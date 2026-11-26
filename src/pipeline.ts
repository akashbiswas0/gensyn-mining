/**
 * One cycle of our own runner: limits → rank markets → findFact → submit → record the verdict.
 * (The alternative runner is the official starter with our brain plugged in: src/starter-bridge.ts.)
 */
import type { EvidenceClient, EvidenceLimits, Submission } from "@gensyn-ai/gensyn-delphi-sdk";
import { EvidenceApiError } from "@gensyn-ai/gensyn-delphi-sdk";
import { competitionPhase, config, rules } from "./config.js";
import { findFact, type Proposal } from "./finder.js";
import { toFiles } from "./lib/attachments.js";
import { awaitFinal, call, isFatal, readLimits, submit } from "./lib/evidence.js";
import { BudgetExceeded, assertBudget } from "./lib/llm.js";
import { event, info } from "./lib/log.js";
import * as state from "./lib/state.js";
import { promptVersion } from "./lib/version.js";
import { loadMarkets } from "./stages/markets.js";
import { rankMarkets } from "./stages/picker.js";
import type { Market } from "./types.js";

export const usdc = (base: string | null | undefined) => (base ? (Number(base) / 1e6).toFixed(2) : "0.00");

/** Pull this account's earlier submissions (other runs, other agents on the account) into memory. */
async function syncFromApi(ev: EvidenceClient, m: Market): Promise<void> {
  const s = state.market(m.address);
  try {
    const { data } = await call("list submissions", () => ev.listSubmissions({ market: m.address, limit: 50 }));
    const known = new Set(s.submissions.map((x) => x.id));
    for (const item of data.items) if (!known.has(item.id) && item.note && !s.seenClaims.includes(item.note)) s.seenClaims.push(item.note);
  } catch (e) {
    info(`(could not list earlier submissions for ${m.address}: ${(e as Error).message})`);
  }
}

/** Records a submission and its final verdict in data/state.json. Shared with the starter bridge. */
export function recordSubmission(m: Market, p: Proposal, sub: Submission, costUsd?: number): state.SubmissionRecord {
  const s = state.market(m.address);
  let rec = s.submissions.find((x) => x.id === sub.id);
  if (!rec) {
    // Record what the API says was sent (a submission echoes its note, links and files), not what we
    // proposed: the official starter, for one, sends only "As of <date>: <text>" and one link.
    rec = { id: sub.id, at: new Date().toISOString(), direction: p.candidate.direction, note: sub.note ?? p.note, links: sub.links ?? p.links, files: sub.files ? sub.files.map((f) => f.name ?? f.contentType) : p.files.map((f) => f.name), status: sub.status, verdict: null, reason: null, bounty: null, bountyState: null, promptVersion: promptVersion(), costUsd };
    s.submissions.push(rec);
  }
  s.side ??= p.candidate.direction;
  applyResult(rec, m.address, sub);
  return rec;
}

/** Copies the API's current view of a submission (status, verdict, reward) into our record. */
function applyResult(rec: state.SubmissionRecord, address: string, sub: Submission): void {
  const mk = sub.markets.find((x) => x.marketAddress.toLowerCase() === address.toLowerCase()) ?? sub.markets[0];
  Object.assign(rec, {
    status: sub.status,
    verdict: mk?.verdict ?? null,
    reason: mk?.reason ?? (sub as { message?: string }).message ?? null, // a rejection has `code` and `message`
    ...(sub.code ? { code: sub.code } : {}),
    bounty: mk?.bounty?.amount ?? null,
    bountyState: mk?.bounty?.state ?? null,
    settlementUpTo: mk?.settlementUpTo ?? null,
    ...(mk?.zeroPayReason ? { zeroPayReason: mk.zeroPayReason } : {}),
  });
  state.save();
}

/**
 * Re-reads every submission our memory still has as queued/judging. A poll can fail after the
 * submit went through (network, or judging outlasting rules.pollMaxMinutes); without this the record
 * would stay pending forever and the acceptance guard would never see its verdict.
 */
export async function refreshPending(ev: EvidenceClient): Promise<number> {
  let done = 0;
  for (const [address, m] of Object.entries(state.load().markets)) {
    for (const rec of m.submissions) {
      if (!["queued", "judging", "failed"].includes(rec.status)) continue;
      try {
        let { data } = await call("refresh pending", () => ev.getSubmission(rec.id));
        // Delphi retries failed judgments itself first; ask only when the result says we can.
        if (data.status === "failed" && data.canRetry) data = await awaitFinal(ev, data, Math.min(2, rules.pollMaxMinutes), 1);
        applyResult(rec, address, data);
        if (!["queued", "judging", "failed"].includes(rec.status)) {
          done++;
          event("VERDICT", `${rec.id} (earlier submission): ${rec.status}/${rec.verdict ?? "-"} reward ${usdc(rec.bounty)} USDC${rec.zeroPayReason ? ` (0: ${rec.zeroPayReason})` : ""}. ${rec.reason ?? ""}`);
        }
      } catch (e) {
        if (isFatal(e)) throw e;
        info(`(could not refresh ${rec.id}: ${(e as Error).message}; next cycle tries again)`);
      }
    }
  }
  return done;
}

const FOREVER = "9999-01-01T00:00:00Z";
const guardOn = () => !config.sim || process.env.SIM_GUARD === "1";

async function processMarket(ev: EvidenceClient, m: Market): Promise<boolean> {
  const s = state.market(m.address);
  // Entry state is "the only call that says whether the market takes your evidence now" (official guide).
  const { data: entry } = await call("entry state", () => ev.getEntryState(m.address));
  if (!entry.canSubmit || entry.remainingOnMarket <= 0) {
    const reason = entry.reason ?? (entry.remainingOnMarket <= 0 ? "cap_reached" : "unknown");
    if (reason === "blocked") throw new AccountStop("the account is BLOCKED (entry-state: blocked). Stop and check the Discord / feedback channel.");
    if (reason === "terms_not_accepted") throw new AccountStop("terms not accepted (entry-state). Read the terms, then set ACCEPT_TERMS.");
    if (reason === "rate_limited") throw new HourDone(entry.rateLimit?.resetAt);
    event("SKIP", `${m.question}: cannot submit (${reason})`);
    // closed and not_open do not come back. Neither does cap_reached, unless a submission still being
    // judged turns out a duplicate (it gives its slot back). Anything else: retry after the hour.
    const mayFreeUp = reason === "cap_reached" && s.submissions.some((r) => r.status === "queued" || r.status === "judging");
    s.skipUntil = ["closed", "not_open", "cap_reached"].includes(reason) && !mayFreeUp ? FOREVER : entry.rateLimit?.resetAt;
    state.save();
    return false;
  }
  info(`${m.question}: pot left ${usdc(entry.judgementPotRemainingBaseUnits)} USDC, ${entry.remainingOnMarket} submissions left`);
  await syncFromApi(ev, m);

  const spentBefore = state.spentToday();
  const p = await findFact(m);
  if (!p) return false;
  const cost = state.spentToday() - spentBefore;

  const { data: sub, meta } = await submit(ev, { note: p.note, links: p.links, files: toFiles(p.files), marketAddress: m.address });
  if (meta.warnings) info(`API warning: ${meta.warnings}`);
  recordSubmission(m, p, sub, cost);
  event("SUBMIT", `${sub.id} → ${m.question}: ${p.note}`);

  // A saved rejection comes back at once; anything else is polled until final, and `failed`
  // submissions that allow it are retried.
  const final = sub.status === "rejected" ? sub : await awaitFinal(ev, sub, rules.pollMaxMinutes);
  const rec = recordSubmission(m, p, final);
  event("VERDICT", `${final.status}/${rec.verdict ?? rec.code ?? "-"} reward ${usdc(rec.bounty)} USDC${rec.zeroPayReason ? ` (0: ${rec.zeroPayReason})` : ""}. ${rec.reason ?? ""}`);
  if (guardOn()) strikeCheck(); // before another submission in this cycle can add a second strike
  return true;
}

/** Stops the whole agent: something a person must look at. */
export class AccountStop extends Error {}
/** No submissions left this UTC hour: end the cycle quietly. */
class HourDone extends Error {
  constructor(readonly resetAt?: string) { super("hour used up"); }
}

/**
 * Strikes: manipulation verdicts and screening hits (blocked words, injection); "repeated strikes
 * block the account". The codes aren't listed, so any rejection other than `duplicate` stops the
 * agent for a person to look at. That includes moderation rejections: not strikes, but they flag
 * the account for review.
 */
export function strikeCheck(): void {
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  for (const r of Object.values(state.load().markets).flatMap((m) => m.submissions)) {
    if (r.at < dayAgo) continue;
    if (/manipulation/i.test(r.verdict ?? "")) throw new AccountStop(`a MANIPULATION verdict in the last 24h (${r.id}). Repeated ones block the account: review the note with npm run status before going on.`);
    if (r.status === "rejected" && !/^duplicate$/i.test(r.code ?? "")) throw new AccountStop(`submission ${r.id} was REJECTED by a content check in the last 24h (code ${r.code ?? "?"}: ${r.reason ?? "no message"}). Screening hits are strikes and repeated strikes block the account: review the note with npm run status before going on.`);
  }
}

/** Why the account can't usefully submit now, or null. dailyCapLeft is REWARD left, not a number of submissions. */
export function limitReached(l: EvidenceLimits): string | null {
  if (l.submitsLeftThisHour <= 0) return `no submissions left this hour (resets ${l.hourEndsAt})`;
  if (Number(l.dailyCapLeft) <= 0) return `daily reward cap used up (frees up from ${l.dailyCapResetAt ?? "when a counted reward turns 24 h old"})`;
  return null;
}

/**
 * Rejected, duplicate and irrelevant submissions still use one of the 3 per market, and "an account
 * with a low accepted rate moves to the Restricted tier: 1 per market and a lower daily reward
 * cap". The threshold isn't published, so acceptanceGuard in rules.json is OUR safety margin: pause
 * when recent results are weak. Strikes stop the agent outright (strikeCheck).
 */
function acceptanceGuard(): string | null {
  const recs = Object.values(state.load().markets).flatMap((m) => m.submissions).filter((r) => r.status === "judged" || r.status === "rejected");
  recs.sort((a, b) => a.at.localeCompare(b.at));
  strikeCheck();
  const { window, minAcceptedRate } = rules.acceptanceGuard;
  const recent = recs.slice(-window);
  if (recent.length < window) return null;
  const rate = recent.filter((r) => /^accepted$/i.test(r.verdict ?? "")).length / recent.length;
  return rate < minAcceptedRate ? `only ${Math.round(rate * 100)}% of the last ${window} submissions were accepted (guard: ${Math.round(minAcceptedRate * 100)}%). Paused to protect the Standard tier: read the judge's reasons (npm run status), tune prompts/rules in --sim, then lower acceptanceGuard or continue.` : null;
}

/** Checks before any submission (both runners). Throws AccountStop, or returns why to pause. Reading results is never blocked. */
export function submitStop(): string | null {
  if (!config.sim) {
    const w = rules.competitionWindow;
    if (competitionPhase() !== "open") throw new AccountStop(`the competition runs ${w.startsAt} to ${w.endsAt}: submissions outside it do not count`);
    if (new URL(config.siteUrl).hostname !== "competition.delphi.fyi") throw new AccountStop(`COMPETITION_SITE_URL is ${config.siteUrl}, but the competition is at https://competition.delphi.fyi`);
  }
  return guardOn() ? acceptanceGuard() : null;
}

export async function cycle(ev: EvidenceClient): Promise<void> {
  assertBudget();
  // Verdicts first: they feed the acceptance guard and the picker.
  const refreshed = await refreshPending(ev);
  if (refreshed) info(`${refreshed} earlier submission(s) finished judging`);
  const paused = submitStop();
  if (paused) {
    event("ERROR", `Paused: ${paused}`);
    return;
  }
  const limits = await readLimits(ev);
  info(`limits: ${limits.submitsLeftThisHour} submissions left this hour, daily reward cap left ${limits.dailyCapLeft} · research spend today $${state.spentToday().toFixed(2)} / $${config.dailyBudgetUsd}`);
  const stop = limitReached(limits);
  if (stop) {
    event("SKIP", `Limit reached: ${stop}`);
    return;
  }

  const markets = await loadMarkets();
  if (!markets.length) {
    event("SKIP", "The market list is empty: no competition market is open yet. Trying again later.");
    return;
  }
  const { ranked, skipped } = rankMarkets(markets);
  info(`${markets.length} markets · ${ranked.length} eligible · ${skipped.length} skipped`);
  for (const r of ranked.slice(0, config.marketsPerCycle)) info(`  ${r.score.toFixed(2)}  ${r.market.question}  (${r.why})`);

  const cap = Math.min(config.maxSubmissionsPerCycle, limits.submitsLeftThisHour);
  let submitted = 0;
  for (const r of ranked.slice(0, config.marketsPerCycle)) {
    if (submitted >= cap) break;
    for (let i = 0; i < rules.submissionsPerMarketPerCycle && submitted < cap; i++) {
      try {
        if (!(await processMarket(ev, r.market))) break;
        submitted++;
      } catch (e) {
        if (e instanceof BudgetExceeded || e instanceof AccountStop || isFatal(e)) throw e;
        if (e instanceof HourDone) {
          event("SKIP", `No submissions left this hour (resets ${e.resetAt ?? "at the next UTC hour"})`);
          return;
        }
        const msg = e instanceof EvidenceApiError ? `${e.code} ${e.message}${e.requestId ? ` (request ${e.requestId})` : ""}` : (e as Error).message;
        event("ERROR", `${r.market.question}: ${msg}`);
        if (e instanceof EvidenceApiError && e.code === "rate_limited") return; // hourly/daily limit: stop this cycle
        if (e instanceof EvidenceApiError && e.code === "cap_reached") state.market(r.market.address).skipUntil = FOREVER;
        state.save();
        break;
      }
    }
  }
  info(`cycle done: ${submitted} submitted · research spend today $${state.spentToday().toFixed(2)}`);
}
