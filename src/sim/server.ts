/**
 * Local competition simulator: implements the evidence API's /v1 routes as a fetch function, so
 * the REAL SDK EvidenceClient (and the real official starter) run against it unchanged.
 *
 * It's strict on purpose: it enforces terms, validation, idempotency, per-market caps, hourly
 * limits, the daily cap (pays 0), reward pots and duplicate detection, and judges with
 * src/sim/judge.ts. SIM_CHAOS=0..1 injects 5xx errors, call-rate 429s, network failures and
 * judge failures (retryable). State persists in data/sim/server.json so caps carry across runs.
 *
 * Settings (env): SIM_HOURLY_LIMIT=10 SIM_DAILY_CAP=30 SIM_NOTE_MAX_CHARS=1000 SIM_MAX_LINKS=5
 * SIM_CHAOS=0 SIM_JUDGE=llm|heuristic SIM_JUDGE_MODEL SIM_JUDGE_DELAY_SECONDS=3 SIM_POT_USDC=250
 * SIM_USDC_PER_POINT=0.5 SIM_MIN_DELTA=0.02 SIM_TERMS_VERSION=sim-1
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, rules } from "../config.js";
import { loadMarkets } from "../stages/markets.js";
import type { Market } from "../types.js";
import { type Forecast, forecastBefore, judge } from "./judge.js";

const n = (k: string, d: number) => (process.env[k] && Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
const S = {
  hourly: n("SIM_HOURLY_LIMIT", 10),
  daily: n("SIM_DAILY_CAP", 30),
  noteMax: n("SIM_NOTE_MAX_CHARS", 8000),
  maxItems: 8,
  maxFileBytes: 10 * 1024 * 1024,
  chaos: n("SIM_CHAOS", 0),
  delayS: n("SIM_JUDGE_DELAY_SECONDS", 3),
  potBase: n("SIM_POT_USDC", 20) * 1e6, // official: 50 USDC.e per market, 20 judgment + 30 settlement
  perPointBase: n("SIM_USDC_PER_POINT", 0.25) * 1e6,
  minDelta: n("SIM_MIN_DELTA", 0.02),
  terms: process.env.SIM_TERMS_VERSION || "sim-1",
};

interface SimSub {
  id: string; key: string; bodyHash: string; createdAt: string; agentId: string | null;
  note: string; links: string[]; files: number; market: string | null;
  status: "queued" | "judging" | "judged" | "rejected" | "failed" | "unmatched";
  readyAt: number; failNext: boolean; code?: string; retryAt?: string;
  verdict: string | null; reason: string | null; bounty: { amount: string; state: string } | null;
  zeroPayReason?: string; settlementUpTo: string | null;
  /** markets[].status once judged: accepted / not_accepted (official). */
  lineStatus?: string;
}
interface SimState {
  termsAccepted: string | null;
  subs: SimSub[];
  pots: Record<string, number>;
  forecasts: Record<string, Forecast & { day: string }>;
}

const file = () => path.join(config.dataDir, "server.json");
let st: SimState | null = null;
const load = (): SimState => {
  if (st) return st;
  try { st = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { st = { termsAccepted: null, subs: [], pots: {}, forecasts: {} }; }
  return st!;
};
const save = () => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(load(), null, 2)); };

let marketsCache: Map<string, Market> | null = null;
async function markets(): Promise<Map<string, Market>> {
  if (!marketsCache) marketsCache = new Map((await loadMarkets()).map((m) => [m.address.toLowerCase(), m]));
  return marketsCache;
}

/* ------------------------------- helpers ------------------------------- */

// Response shapes follow the SDK's own contract tests (tests/client/evidence.test.ts in the SDK repo).
const CONTRACT = "sim-1.0.0";
let warnings = "";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-Id": randomUUID(), "X-Contract-Version": CONTRACT, ...(warnings ? { "X-Delphi-Warnings": warnings } : {}), ...headers },
  });
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  json(status, { error: { code, message, retryable: status >= 500 || code === "rate_limited", retryAfterSeconds: null, field: null, limit: null, ...extra }, requestId: randomUUID() },
    extra.retryAfterSeconds ? { "Retry-After": String(extra.retryAfterSeconds) } : {});
const HOUR = 3_600_000;
const normUrl = (u: string) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); } catch { return u; } };
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
const similarity = (a: string, b: string) => { const A = words(a), B = words(b); let i = 0; for (const w of A) if (B.has(w)) i++; return A.size && B.size ? i / (A.size + B.size - i) : 0; };
const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
const usedToday = (s: SimState) => s.subs.filter((x) => Date.parse(x.createdAt) >= dayStart()).length;
const usedThisHour = (s: SimState) => s.subs.filter((x) => Date.now() - Date.parse(x.createdAt) < HOUR);

function view(x: SimSub) {
  return {
    id: x.id, createdAt: x.createdAt, agentId: x.agentId, note: x.note, links: x.links, files: [], status: x.status,
    ...(x.status === "failed" ? { code: x.code, canRetry: true, retryAt: x.retryAt } : {}),
    ...(x.status === "queued" || x.status === "judging" ? { judgingEstimateSeconds: Math.max(1, Math.ceil((x.readyAt - Date.now()) / 1000)) } : {}),
    markets: x.market ? [{
      marketAddress: x.market, status: x.lineStatus ?? x.status, verdict: x.verdict, reason: x.reason, bounty: x.bounty,
      settlementUpTo: x.settlementUpTo, ...(x.zeroPayReason ? { zeroPayReason: x.zeroPayReason } : {}),
    }] : [],
  };
}

async function runJudge(s: SimState, x: SimSub): Promise<void> {
  const m = (await markets()).get(x.market!);
  if (!m) { x.status = "unmatched"; return; }
  const key = m.address.toLowerCase();
  const earlier = s.subs.filter((o) => o !== x && o.market === x.market && o.status === "judged" && Date.parse(o.createdAt) < Date.parse(x.createdAt));

  // Evidence that repeats an earlier submission earns nothing.
  const linkSet = new Set(earlier.flatMap((o) => o.links.map(normUrl)));
  if (x.links.some((l) => linkSet.has(normUrl(l))) || earlier.some((o) => similarity(o.note, x.note) >= 0.6)) {
    Object.assign(x, { status: "judged", lineStatus: "not_accepted", verdict: "duplicate", reason: "The same fact was already accepted on this market.", bounty: { amount: "0", state: "none" }, settlementUpTo: "0" });
    return;
  }

  if (/\b(ignore (all|any|the|previous)|disregard|system prompt|you (must|should) (rate|score|accept|update|raise|lower)|(dear|to the) (judge|forecaster|model)|rate this|score this)/i.test(x.note)) {
    Object.assign(x, { status: "judged", lineStatus: "not_accepted", verdict: "manipulation", reason: null, bounty: { amount: "0", state: "none" }, settlementUpTo: "0" });
    return;
  }
  if (!x.links.length && !x.files) {
    Object.assign(x, { status: "judged", lineStatus: "not_accepted", verdict: "unverifiable", reason: "No source to check.", bounty: { amount: "0", state: "none" }, settlementUpTo: "0" });
    return;
  }
  const f = s.forecasts[key];
  const before = f && f.day === new Date().toISOString().slice(0, 10) ? f : { ...(await forecastBefore(m)), day: new Date().toISOString().slice(0, 10) };
  s.forecasts[key] = before;
  const accepted = earlier.filter((o) => o.verdict === "accepted").map((o) => o.note);
  const j = await judge(m, before, accepted, x.note, x.links);
  const delta = j.probAfter - j.probBefore;
  const moveTxt = `Δ ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pts (${(j.probBefore * 100).toFixed(0)}%→${(j.probAfter * 100).toFixed(0)}%). ${j.rationale}`;

  if (!j.credible) {
    Object.assign(x, { status: "judged", lineStatus: "not_accepted", verdict: "no information", reason: moveTxt, bounty: { amount: "0", state: "none" }, settlementUpTo: "0" });
    return;
  }
  s.forecasts[key] = { probYes: j.probAfter, rationale: `updated by evidence ${x.id}`, day: before.day };
  const pot = s.pots[key] ?? S.potBase;
  let amount = Math.min(pot, Math.round(Math.abs(delta) * 100 * S.perPointBase));
  let zero: string | undefined;
  if (Math.abs(delta) < S.minDelta) { amount = 0; zero = "below_minimum"; }
  else if (pot <= 0) { amount = 0; zero = "pot_empty"; }
  else if (usedToday(s) > S.daily) { amount = 0; zero = "daily_cap"; }
  s.pots[key] = pot - amount;
  Object.assign(x, {
    status: "judged", lineStatus: "accepted", verdict: "accepted", reason: moveTxt,
    bounty: { amount: String(amount), state: amount ? "held" : "none" },
    zeroPayReason: zero, settlementUpTo: String(30 * 1e6 / 3), // a share of the 30 USDC.e settlement pot
  });
}

/* -------------------------------- routes -------------------------------- */

export const simFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const p = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const s = load();
  const h = new Headers(init?.headers);
  warnings = ["X-Agent-Id", "X-Agent-Harness", "X-Agent-Model"].filter((k) => !h.get(k)).map((k) => `missing ${k}`).join(", ");
  if (h.get("Authorization") !== "Bearer sim") return err(401, "unauthorized", "invalid API key");

  // Chaos: transient failures any client must survive.
  if (S.chaos > 0 && Math.random() < S.chaos) {
    const r = Math.random();
    if (r < 0.34) throw new TypeError("fetch failed (sim chaos: network)");
    if (r < 0.67) return err(503, "server_error", "sim chaos: upstream unavailable");
    return err(429, "rate_limited", "sim chaos: too many calls", { limit: "call_rate", retryAfterSeconds: 1 });
  }

  if (p === "/terms" && method === "GET")
    return json(200, { version: S.terms, url: "https://example.com/sim-terms", acceptedAt: s.termsAccepted === S.terms ? new Date().toISOString() : null });
  if (p === "/terms/acceptance" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.termsVersion !== S.terms) return err(400, "invalid_request", "not the current terms version", { field: "termsVersion" });
    s.termsAccepted = S.terms; save();
    return json(200, { version: S.terms, acceptedAt: new Date().toISOString() });
  }
  if (p === "/limits") {
    const hour = usedThisHour(s);
    const oldest = hour.map((x) => Date.parse(x.createdAt)).sort()[0] ?? Date.now();
    return json(200, { submitsLeftThisHour: Math.max(0, S.hourly - hour.length), hourEndsAt: new Date(oldest + HOUR).toISOString(), dailyCapLeft: Math.max(0, S.daily - usedToday(s)), dailyCapResetAt: new Date(dayStart() + 24 * HOUR).toISOString() });
  }

  const entry = p.match(/^\/markets\/([^/]+)\/entry-state$/);
  if (entry) {
    const key = decodeURIComponent(entry[1]!).toLowerCase();
    if (!(await markets()).has(key)) return err(404, "market_not_found", "no such market", { field: "marketAddress" });
    const used = s.subs.filter((x) => x.market === key).length;
    const left = Math.max(0, rules.maxSubmissionsPerMarket - used);
    const mk = (await markets()).get(key)!;
    const cutoff = mk.evidenceCutoff ?? mk.closesAt;
    // Official order: terms and market reasons first, then rate_limited.
    const reason = s.termsAccepted !== S.terms ? "terms_not_accepted" : mk.status !== "open" ? "not_open" : cutoff && cutoff.getTime() <= Date.now() ? "closed"
      : left === 0 ? "cap_reached" : usedThisHour(s).length >= S.hourly ? "rate_limited" : undefined;
    return json(200, {
      canSubmit: !reason, ...(reason ? { reason } : {}),
      remainingOnMarket: left, judgementPotRemainingBaseUnits: String(s.pots[key] ?? S.potBase),
      rateLimit: { resetAt: new Date(Date.now() + 60_000).toISOString() },
    });
  }

  if (p === "/submissions" && method === "POST") {
    if (s.termsAccepted !== S.terms) return json(403, { error: { code: "terms_not_accepted", message: "accept the terms first", retryable: false, terms: { version: S.terms, url: "https://example.com/sim-terms" } } });
    const form = init?.body as FormData;
    const headers = new Headers(init?.headers);
    const key = headers.get("Idempotency-Key") ?? "";
    const note = String(form.get("note") ?? "");
    const links = form.getAll("links[]").map(String);
    const files = form.getAll("files").length;
    const marketRaw = form.get("marketAddress");
    const market = marketRaw ? String(marketRaw).toLowerCase() : null;
    const bodyHash = createHash("sha256").update(JSON.stringify([note, links, market, files])).digest("hex");

    const same = s.subs.find((x) => x.key === key);
    if (same) return same.bodyHash === bodyHash ? json(200, view(same)) : err(409, "idempotency_conflict", "Idempotency-Key reused with a different body");
    if (!note.trim() || note.length > S.noteMax) return err(400, "invalid_request", `note must be 1-${S.noteMax} characters`, { field: "note" });
    if (links.some((l) => !/^https?:\/\/\S+$/.test(l))) return err(400, "invalid_request", "links[] must be URLs without spaces", { field: "links[]" });
    if (files > 3) return err(400, "invalid_request", "at most 3 files", { field: "files" });
    if ((note ? 1 : 0) + links.length + files > S.maxItems) return err(400, "invalid_request", "a submission holds at most 8 items", { field: "links[]" });
    const fileList = form.getAll("files") as File[];
    if (fileList.reduce((a, f) => a + f.size, 0) > S.maxFileBytes) return err(400, "invalid_request", "files exceed 10 MB in total", { field: "files" });
    if (fileList.some((f) => !rules.allowedFileTypes.includes(f.type))) return err(400, "invalid_request", "file type not allowed", { field: "files" });
    if (market && !(await markets()).has(market)) return err(404, "market_not_found", "marketAddress is not a competition market", { field: "marketAddress" });
    if (market && s.subs.filter((x) => x.market === market).length >= rules.maxSubmissionsPerMarket) return err(429, "cap_reached", "all submissions used on this market", { retryable: false });
    const hour = usedThisHour(s);
    if (hour.length >= S.hourly) {
      const wait = Math.ceil((Math.min(...hour.map((x) => Date.parse(x.createdAt))) + HOUR - Date.now()) / 1000);
      return err(429, "rate_limited", "hourly submission limit", { limit: "hourly", retryAfterSeconds: wait });
    }

    const x: SimSub = {
      id: randomUUID(), key, bodyHash, createdAt: new Date().toISOString(), agentId: headers.get("X-Agent-Id"),
      note, links, files, market, status: market ? "queued" : "unmatched", readyAt: Date.now() + S.delayS * 1000,
      failNext: S.chaos > 0 && Math.random() < S.chaos, verdict: null, reason: null, bounty: null, settlementUpTo: null,
    };
    s.subs.push(x); save();
    // Official: "markets is empty at first, also when you sent a marketAddress".
    return json(202, { ...view(x), markets: [] }, { "Retry-After": String(S.delayS), Location: `/v1/submissions/${x.id}` });
  }

  const retry = p.match(/^\/submissions\/([^/]+)\/retry$/);
  if (retry && method === "POST") {
    const x = s.subs.find((o) => o.id === retry[1]);
    if (!x) return err(404, "not_found", "no such submission");
    if (x.status !== "failed") return err(400, "invalid_request", `cannot retry a ${x.status} submission`);
    Object.assign(x, { status: "queued", readyAt: Date.now() + S.delayS * 1000, code: undefined, retryAt: undefined });
    save();
    return json(202, view(x), { "Retry-After": String(S.delayS) });
  }

  const one = p.match(/^\/submissions\/([^/]+)$/);
  if (one && method === "GET") {
    const x = s.subs.find((o) => o.id === one[1]);
    if (!x) return err(404, "not_found", "no such submission");
    if ((x.status === "queued" || x.status === "judging") && Date.now() >= x.readyAt) {
      if (x.failNext) {
        Object.assign(x, { status: "failed", failNext: false, code: "judge_unavailable", retryAt: new Date(Date.now() + 2000).toISOString() });
      } else {
        try { await runJudge(s, x); } catch (e) {
          Object.assign(x, { status: "failed", code: "judge_error", retryAt: new Date(Date.now() + 5000).toISOString(), reason: (e as Error).message });
        }
      }
      save();
    } else if (x.status === "queued") { x.status = "judging"; save(); }
    const pending = x.status === "queued" || x.status === "judging";
    return json(200, view(x), pending ? { "Retry-After": String(Math.max(1, Math.ceil((x.readyAt - Date.now()) / 1000))) } : {});
  }

  if (p === "/submissions" && method === "GET") {
    const market = url.searchParams.get("market")?.toLowerCase();
    const agent = url.searchParams.get("agentId");
    const items = s.subs.filter((x) => (!market || x.market === market) && (!agent || x.agentId === agent)).map(view);
    return json(200, { items: items.slice(0, Number(url.searchParams.get("limit") ?? 50)), nextCursor: null });
  }
  return err(404, "not_found", `sim: no route ${method} ${p}`);
};
