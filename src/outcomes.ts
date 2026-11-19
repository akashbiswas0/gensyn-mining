/**
 * npm run outcomes (live) / npm run outcomes -- --sim
 *
 * Two refreshes of our memory, both from real sources:
 *  1. Re-reads each submission from the evidence API (or the simulator), since bounty state
 *     (held → paid / voided) and settlement figures change after judging.
 *  2. Asks the Delphi API how each market settled (getMarket → status, winningOutcomeIdx) and
 *     marks every submission right / wrong / void. On sim runs over real Delphi markets
 *     (`npm run sim`), this is real ground truth for the settlement half of the score:
 *     did the agent pick the side that actually happened?
 */
import type { Submission } from "@gensyn-ai/gensyn-delphi-sdk";
import { config, describeMode } from "./config.js";
import { call, makeEvidenceClient } from "./lib/evidence.js";
import * as state from "./lib/state.js";
import { delphiReader } from "./stages/markets.js";
import type { Direction } from "./types.js";

async function refreshFromApi(): Promise<number> {
  let ev;
  try {
    ev = makeEvidenceClient();
  } catch (e) {
    console.log(`(skipping evidence API refresh: ${(e as Error).message.split("\n")[0]})`);
    return 0;
  }
  let updated = 0;
  for (const [addr, m] of Object.entries(state.load().markets)) {
    if (!m.submissions.length) continue;
    const { data } = await call("list submissions", () => ev.listSubmissions({ market: addr, limit: 50 }));
    for (const item of data.items as Submission[]) {
      const rec = m.submissions.find((r) => r.id === item.id);
      const mk = item.markets.find((x) => x.marketAddress.toLowerCase() === addr) ?? item.markets[0];
      if (!rec || !mk) continue;
      const next = { status: item.status, verdict: mk.verdict, reason: mk.reason, bounty: mk.bounty?.amount ?? null, bountyState: mk.bounty?.state ?? null, settlementUpTo: mk.settlementUpTo };
      if (JSON.stringify(next) !== JSON.stringify({ status: rec.status, verdict: rec.verdict, reason: rec.reason, bounty: rec.bounty, bountyState: rec.bountyState, settlementUpTo: rec.settlementUpTo ?? null })) {
        Object.assign(rec, next);
        updated++;
      }
    }
  }
  state.save();
  return updated;
}

async function resolveMarkets(): Promise<{ checked: number; resolved: number }> {
  const client = delphiReader();
  if (!client) {
    console.log("(skipping settlement check: set DELPHI_MARKETS_API_KEY for the network the markets live on)");
    return { checked: 0, resolved: 0 };
  }
  let checked = 0;
  let resolved = 0;
  for (const [addr, m] of Object.entries(state.load().markets)) {
    if (!m.submissions.length || (m.resolved && m.resolved.status !== "open" && m.resolved.status !== "awaiting_settlement")) continue;
    checked++;
    try {
      const d = await client.getMarket({ id: addr });
      let winner: Direction | null = null;
      if (d.status === "settled" && d.winningOutcomeIdx !== null) {
        const name = d.metadata?.outcomes?.[Number(d.winningOutcomeIdx)]?.trim().toLowerCase();
        winner = name === "yes" ? "yes" : name === "no" ? "no" : null;
      }
      m.resolved = { status: d.status, winner, checkedAt: new Date().toISOString() };
      if (d.status === "settled" || d.status === "expired" || d.status === "failed") {
        resolved++;
        for (const r of m.submissions) r.outcome = winner ? (r.direction === winner ? "right" : "wrong") : "void";
      }
    } catch (e) {
      console.log(`  ${addr}: ${(e as Error).message.slice(0, 100)}`);
    }
  }
  state.save();
  return { checked, resolved };
}

async function main(): Promise<void> {
  console.log(describeMode());
  const updated = await refreshFromApi();
  const { checked, resolved } = await resolveMarkets();
  const recs = Object.values(state.load().markets).flatMap((m) => m.submissions);
  const right = recs.filter((r) => r.outcome === "right").length;
  const wrong = recs.filter((r) => r.outcome === "wrong").length;
  console.log(`\nrefreshed ${updated} submission(s) · checked ${checked} market(s), ${resolved} newly final`);
  console.log(`side accuracy on settled markets: ${right + wrong ? `${right}/${right + wrong} (${Math.round((100 * right) / (right + wrong))}%)` : "no settled markets yet"}`);
  console.log("Per prompt version: npm run report" + (config.sim ? " -- --sim" : ""));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
