/**
 * One cycle of our own runner: limits → rank markets → findFact → submit → record the verdict.
 * (The alternative runner is the official starter with our brain plugged in: src/starter-bridge.ts.)
 */
import type { EvidenceClient, Submission } from "@gensyn-ai/gensyn-delphi-sdk";
import { EvidenceApiError } from "@gensyn-ai/gensyn-delphi-sdk";
import { config, rules } from "./config.js";
import { findFact, type Proposal } from "./finder.js";
import { awaitFinal, call, isFatal, submit } from "./lib/evidence.js";
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
  const mk = sub.markets.find((x) => x.marketAddress.toLowerCase() === m.address.toLowerCase()) ?? sub.markets[0];
  let rec = s.submissions.find((x) => x.id === sub.id);
  if (!rec) {
    rec = { id: sub.id, at: new Date().toISOString(), direction: p.candidate.direction, note: p.note, links: p.links, status: sub.status, verdict: null, reason: null, bounty: null, bountyState: null, promptVersion: promptVersion(), costUsd };
    s.submissions.push(rec);
  }
  s.side ??= p.candidate.direction;
  Object.assign(rec, {
    status: sub.status,
    verdict: mk?.verdict ?? null,
    reason: mk?.reason ?? null,
    bounty: mk?.bounty?.amount ?? null,
    bountyState: mk?.bounty?.state ?? null,
    settlementUpTo: mk?.settlementUpTo ?? null,
    ...(mk?.zeroPayReason ? { zeroPayReason: mk.zeroPayReason } : {}),
  });
  state.save();
  return rec;
}

async function processMarket(ev: EvidenceClient, m: Market): Promise<boolean> {
  const s = state.market(m.address);
  const { data: entry } = await call("entry state", () => ev.getEntryState(m.address));
  if (!entry.canSubmit || entry.remainingOnMarket <= 0) {
    event("SKIP", `${m.question}: cannot submit (${entry.reason ?? `${entry.remainingOnMarket} left`})`);
    s.skipUntil = entry.rateLimit?.resetAt;
    state.save();
    return false;
  }
  info(`${m.question}: pot left ${usdc(entry.judgementPotRemainingBaseUnits)} USDC, ${entry.remainingOnMarket} submissions left`);
  await syncFromApi(ev, m);

  const spentBefore = state.spentToday();
  const p = await findFact(m);
  if (!p) return false;
  const cost = state.spentToday() - spentBefore;

  const { data: sub, meta } = await submit(ev, { note: p.note, links: p.links, marketAddress: m.address });
  if (meta.warnings) info(`API warning: ${meta.warnings}`);
  recordSubmission(m, p, sub, cost);
  event("SUBMIT", `${sub.id} → ${m.question}: ${p.note}`);

  // A saved rejection comes back at once; anything else is polled until final, and `failed`
  // submissions that allow it are retried.
  const final = sub.status === "rejected" ? sub : await awaitFinal(ev, sub);
  const rec = recordSubmission(m, p, final);
  event("VERDICT", `${final.status}/${rec.verdict ?? "-"} reward ${usdc(rec.bounty)} USDC${rec.zeroPayReason ? ` (0: ${rec.zeroPayReason})` : ""}. ${rec.reason ?? ""}`);
  return true;
}

export async function cycle(ev: EvidenceClient): Promise<void> {
  assertBudget();
  const { data: limits } = await call("limits", () => ev.getLimits());
  info(`limits: ${limits.submitsLeftThisHour} left this hour, ${limits.dailyCapLeft} today · Claude spend today $${state.spentToday().toFixed(2)} / $${config.dailyBudgetUsd}`);
  if (limits.submitsLeftThisHour <= 0 || limits.dailyCapLeft <= 0) {
    event("SKIP", `Submission limit reached (resets ${limits.submitsLeftThisHour <= 0 ? limits.hourEndsAt : limits.dailyCapResetAt})`);
    return;
  }

  const markets = await loadMarkets();
  const { ranked, skipped } = rankMarkets(markets);
  info(`${markets.length} markets · ${ranked.length} eligible · ${skipped.length} skipped`);
  for (const r of ranked.slice(0, config.marketsPerCycle)) info(`  ${r.score.toFixed(2)}  ${r.market.question}  (${r.why})`);

  const cap = Math.min(config.maxSubmissionsPerCycle, limits.submitsLeftThisHour, limits.dailyCapLeft);
  let submitted = 0;
  for (const r of ranked.slice(0, config.marketsPerCycle)) {
    if (submitted >= cap) break;
    for (let i = 0; i < rules.submissionsPerMarketPerCycle && submitted < cap; i++) {
      try {
        if (!(await processMarket(ev, r.market))) break;
        submitted++;
      } catch (e) {
        if (e instanceof BudgetExceeded || isFatal(e)) throw e;
        const msg = e instanceof EvidenceApiError ? `${e.code} ${e.message}${e.requestId ? ` (request ${e.requestId})` : ""}` : (e as Error).message;
        event("ERROR", `${r.market.question}: ${msg}`);
        if (e instanceof EvidenceApiError && e.code === "rate_limited") return; // hourly/daily limit: stop this cycle
        if (e instanceof EvidenceApiError && e.code === "cap_reached") state.market(r.market.address).skipUntil = "9999-01-01T00:00:00Z";
        state.save();
        break;
      }
    }
  }
  info(`cycle done: ${submitted} submitted · Claude spend today $${state.spentToday().toFixed(2)}`);
}
