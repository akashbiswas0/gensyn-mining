/**
 * Runs the OFFICIAL starter agent (vendor/evidence-starter, synced with `npm run sync-starter`)
 * with our research + fact-check as its `findFact()`. Use this when you want the organisers'
 * own control flow (market picking, terms, entry-state, submit, poll) and only our brain.
 *
 *   npm run starter           live (competition markets → Delphi)
 *   npm run starter:sim       real Delphi markets + real Claude → simulator
 * Any src/agent.ts flag works here too (--markets=, --sim, --offline).
 *
 * The starter submits at most one fact per run, so schedule it (cron/launchd) for repeated use.
 */
import { run } from "../vendor/evidence-starter/agent.js";
import { config, describeMode } from "./config.js";
import { findFact, type Proposal } from "./finder.js";
import { EvidenceApiError } from "@gensyn-ai/gensyn-delphi-sdk";
import { call, makeEvidenceClient, resilient } from "./lib/evidence.js";
import { info } from "./lib/log.js";
import { recordSubmission } from "./pipeline.js";
import { normalise, siteFetch } from "./stages/markets.js";
import { rankMarkets } from "./stages/picker.js";
import type { Fact, Market, MarketCard } from "./types.js";

async function main(): Promise<void> {
  info(`official starter + our brain · ${describeMode()} · agent ${config.agentId}`);
  const proposals = new Map<string, { market: Market; proposal: Proposal }>();

  // The starter offers its picked markets in feed order; our picker's filters (submissions used,
  // back-off, cutoff buffer) still decide whether a market is worth paying to research.
  const ourFindFact = async (card: MarketCard): Promise<Fact | null> => {
    const m = normalise(card);
    if (!m || !rankMarkets([m]).ranked.length) return null;
    const p = await findFact(m);
    if (!p) return null;
    proposals.set(m.address.toLowerCase(), { market: m, proposal: p });
    // The starter builds the note itself as "As of <date>: <text>" with one link.
    return { date: p.verification.factDate, text: p.verification.factText, source: p.links[0]! };
  };

  // The starter doesn't check limits or retry; we do both around it.
  const client = resilient(makeEvidenceClient());
  const { data: limits } = await call("limits", () => client.getLimits());
  if (limits.submitsLeftThisHour <= 0 || limits.dailyCapLeft <= 0) {
    info(`no submissions left (hour resets ${limits.hourEndsAt}, day ${limits.dailyCapResetAt}); not starting the starter`);
    return;
  }

  const result = await run({
    siteUrl: config.siteUrl,
    client,
    acceptTerms: config.acceptTerms,
    findFact: ourFindFact,
    fetch: siteFetch,
    log: (...a: unknown[]) => info(a.map(String).join(" ")),
  }).catch((e) => {
    // Limits can run out between our check and its submit; that's a stop, not a crash.
    if (e instanceof EvidenceApiError && (e.code === "rate_limited" || e.code === "cap_reached")) {
      info(`starter stopped: ${e.code} (${e.message})`);
      return null;
    }
    throw e;
  });

  // Keep our memory (side taken, notes, verdicts) in sync with what the starter submitted.
  if (result) {
    // result.markets is empty for an unmatched submission; fall back to the last proposal.
    const addr = result.markets[0]?.marketAddress?.toLowerCase();
    const hit = addr ? proposals.get(addr) : [...proposals.values()].at(-1);
    if (hit) recordSubmission(hit.market, hit.proposal, result);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
