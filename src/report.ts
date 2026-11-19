/**
 * npm run report (live) / npm run report -- --sim (simulator). Run `npm run outcomes` first to refresh.
 *
 * Compares prompt versions (src/lib/version.ts) on what the judge actually paid: acceptance rate,
 * reward per submission, Claude cost per submission. The loop:
 *   tune prompts/rules → `npm run sim` → `npm run report -- --sim` → keep the best version →
 *   run it live → `npm run report` confirms it on the real judge.
 */
import { config, describeMode } from "./config.js";
import * as state from "./lib/state.js";
import { promptVersion } from "./lib/version.js";

interface Row { n: number; judged: number; accepted: number; paid: number; reward: number; cost: number; costN: number; right: number; wrong: number; first: string; last: string }

const s = state.load();
const rows = new Map<string, Row>();
for (const m of Object.values(s.markets)) {
  for (const x of m.submissions) {
    const v = x.promptVersion ?? "unversioned";
    const r = rows.get(v) ?? { n: 0, judged: 0, accepted: 0, paid: 0, reward: 0, cost: 0, costN: 0, right: 0, wrong: 0, first: x.at, last: x.at };
    r.n++;
    if (x.status === "judged") r.judged++;
    if (x.verdict === "accepted") r.accepted++;
    if (x.outcome === "right") r.right++;
    if (x.outcome === "wrong") r.wrong++;
    const amt = x.bounty ? Number(x.bounty) / 1e6 : 0;
    if (amt > 0) r.paid++;
    r.reward += amt;
    if (x.costUsd !== undefined) { r.cost += x.costUsd; r.costN++; }
    if (x.at < r.first) r.first = x.at;
    if (x.at > r.last) r.last = x.at;
    rows.set(v, r);
  }
}

console.log(`${describeMode()} · ${config.sim ? "SIMULATED judge" : "REAL judge"} · current prompt version ${promptVersion()}\n`);
if (!rows.size) {
  console.log("No submissions yet.");
} else {
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  console.log("version   subs  accepted  paid   reward/sub  total     cost/sub  reward/$  side-right  period");
  for (const [v, r] of [...rows].sort((a, b) => b[1].reward / b[1].n - a[1].reward / a[1].n)) {
    const costSub = r.costN ? r.cost / r.costN : NaN;
    console.log(
      `${(v + (v === promptVersion() ? "*" : "")).padEnd(9)} ${String(r.n).padStart(4)}  ${pct(r.accepted, r.judged).padStart(8)}  ${pct(r.paid, r.n).padStart(4)}  ` +
        `${(r.reward / r.n).toFixed(2).padStart(10)}  ${r.reward.toFixed(2).padStart(7)}  ${Number.isNaN(costSub) ? "       -" : ("$" + costSub.toFixed(2)).padStart(8)}  ` +
        `${r.cost ? (r.reward / r.cost).toFixed(2).padStart(8) : "       -"}  ${(r.right + r.wrong ? `${r.right}/${r.right + r.wrong}` : "-").padStart(10)}  ${r.first.slice(5, 16)} → ${r.last.slice(5, 16)}`,
    );
  }
  console.log("\n* = current version. Rewards in USDC (simulated rewards are a proxy, not real money).");
  console.log("side-right = submissions whose side matched how the market actually settled (npm run outcomes).");
}
