/**
 * npm run inspect-markets [-- --markets=delphi|fixture]
 * Fetches /markets.json and shows how each entry maps into our Market type, plus any fields
 * we don't use yet. Run it first on 23 Nov to see what the real feed contains.
 */
import { config, describeMode } from "./config.js";
import { KNOWN, fetchMarketCards, normalise } from "./stages/markets.js";
import { rankMarkets } from "./stages/picker.js";

async function main(): Promise<void> {
  const cards = await fetchMarketCards();
  console.log(`${describeMode()}\nsource ${config.marketSource === "competition" ? new URL("/markets.json", config.siteUrl) : config.marketSource} → ${cards.length} entries\n`);
  if (!cards.length) return;

  console.log("First entry, raw:\n" + JSON.stringify(cards[0], null, 2).slice(0, 2000) + "\n");

  const unknown = new Map<string, number>();
  for (const c of cards) for (const k of Object.keys(c)) if (!KNOWN.has(k)) unknown.set(k, (unknown.get(k) ?? 0) + 1);
  console.log(unknown.size ? `Fields not used yet (add to src/stages/markets.ts if useful): ${[...unknown].map(([k, n]) => `${k}×${n}`).join(", ")}` : "All fields are mapped.");

  const markets = cards.map(normalise);
  const bad = markets.filter((m) => m === null).length;
  if (bad) console.log(`${bad} entries could not be normalised (no address/question)`);
  const ok = markets.filter((m) => m !== null);
  console.log(`\nNormalised: ${ok.filter((m) => m.probYes !== null).length}/${ok.length} with odds · ${ok.filter((m) => m.evidenceCutoff).length} with cutoff · ${ok.filter((m) => m.rewardPot !== null).length} with pot · ${ok.filter((m) => m.dataSources.length).length} with data sources`);

  const { ranked, skipped } = rankMarkets(ok);
  console.log(`\nRanked (${ranked.length}):`);
  for (const r of ranked) console.log(`  ${r.score.toFixed(2)}  ${r.market.question.slice(0, 90)}  (${r.why})`);
  console.log(`\nSkipped (${skipped.length}):`);
  for (const s of skipped) console.log(`  ${s.market.question.slice(0, 90)}: ${s.why}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
