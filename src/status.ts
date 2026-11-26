/** npm run status (live) / npm run status -- --sim: terms, limits, what the agent submitted and earned, qualification progress. */
import { config, describeMode, rules } from "./config.js";
import { makeEvidenceClient } from "./lib/evidence.js";
import * as state from "./lib/state.js";

const usdc = (base: string | null) => (base ? Number(base) / 1e6 : 0);

async function main(): Promise<void> {
  console.log(describeMode());
  const s = state.load();
  let total = 0;
  let judged = 0;
  let count = 0;
  for (const [addr, m] of Object.entries(s.markets)) {
    if (!m.submissions.length) continue;
    console.log(`\n${addr}  side=${m.side ?? "-"}  ${m.submissions.length}/${rules.maxSubmissionsPerMarket} used`);
    for (const x of m.submissions) {
      count++;
      if (x.status === "judged" && !/manipulation/i.test(x.verdict ?? "")) judged++; // official: manipulation verdicts don't count
      total += usdc(x.bounty);
      console.log(`  ${x.at.slice(0, 16)} ${x.direction.toUpperCase().padEnd(3)} ${x.status}/${x.verdict ?? "-"} ${usdc(x.bounty).toFixed(2)} USDC ${x.zeroPayReason ?? ""}`);
      console.log(`    ${x.note.slice(0, 160)}`);
      if (x.reason) console.log(`    judge: ${x.reason.slice(0, 200)}`);
    }
  }
  const marketsUsed = Object.values(s.markets).filter((m) => m.submissions.some((x) => x.status === "judged")).length;
  const q = rules.qualification;
  console.log(`\nJudgment rewards: ${total.toFixed(2)} USDC · ${count} submitted, ${judged} judged, on ${marketsUsed} markets`);
  console.log(`Prize qualification (${q.judgedSubmissions} judged on ${q.markets}+ markets): ${judged >= q.judgedSubmissions && marketsUsed >= q.markets ? "MET" : "not yet"}`);
  console.log(`Claude spend today: $${state.spentToday().toFixed(2)} / $${config.dailyBudgetUsd}`);

  try {
    const ev = makeEvidenceClient();
    const [{ data: terms }, { data: limits }] = await Promise.all([ev.getTerms(), ev.getLimits()]);
    console.log(`\nTerms ${terms.version}: ${terms.acceptedAt ? `accepted ${terms.acceptedAt}` : `NOT accepted. Read ${terms.url}, then set ACCEPT_TERMS=${terms.version}`}`);
    console.log(`Limits: ${limits.submitsLeftThisHour} submissions left this hour, daily reward cap left ${limits.dailyCapLeft}`);
  } catch (e) {
    console.log(`\n(Delphi API not reachable: ${(e as Error).message})`);
  }
}

main();
