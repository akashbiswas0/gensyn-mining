/**
 * npm run test:chaos [-- --runs=4 --chaos=0.25]
 *
 * Aggressive pre-competition test, $0: runs our runner and the official-starter bridge many times
 * against the simulator with failure injection (network errors, 5xx, call-rate 429s, failed
 * judgements) and adversarial canned research, then checks invariants on what reached the
 * "server" and what the agent remembers:
 *   - never more than the per-market cap, never past the hourly limit
 *   - never both sides of a market, never the same source or the same note twice on a market
 *   - no double submissions despite retries (idempotency), no orphans, every record final
 *   - no crashes
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const RUNS = Number(arg("runs", "5"));
const CHAOS = arg("chaos", "0.25");
const HOURLY = 20;
const root = "data/chaos";
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

// A bigger market set than the samples, and no back-off, so the run isn't starved of work.
const fixture = path.join(root, "markets.json");
fs.writeFileSync(fixture, JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
  address: `0x${(i + 1).toString(16).padStart(40, "c")}`,
  question: `Chaos market ${i + 1}: will event ${i + 1} happen?`,
  status: i === 11 ? "settled" : "open",
  odds: { yes: 0.25 + (i % 6) * 0.1, no: 0.75 - (i % 6) * 0.1 },
  evidenceCutoffAt: new Date(Date.now() + (i === 10 ? -1 : 1) * 7 * 864e5).toISOString(),
  dataSources: [],
}))));
const rulesFile = path.join(root, "rules.json");
fs.writeFileSync(rulesFile, JSON.stringify({ ...JSON.parse(fs.readFileSync("config/rules.json", "utf8")), backoffHoursWhenNothingFound: 0 }));

const env = {
  ...process.env,
  DATA_DIR: root,
  DELPHI_AGENT_LOG: path.join(root, "events.jsonl"),
  SIM_CHAOS: CHAOS,
  SIM_JUDGE: "heuristic",
  SIM_JUDGE_DELAY_SECONDS: "0",
  SIM_HOURLY_LIMIT: String(HOURLY),
  ACCEPT_TERMS: "sim-1",
  FIXTURE_MARKETS: fixture,
  RULES_FILE: rulesFile,
  MARKETS_PER_CYCLE: "6",
  MAX_SUBMISSIONS_PER_CYCLE: "6",
};
const common = ["--sim", "--markets=fixture", "--offline"];

let crashes = 0;
let transient = 0;
const t0 = Date.now();
for (let i = 1; i <= RUNS; i++) {
  for (const [label, script, extra] of [
    ["runner", "src/agent.ts", ["--cycles=3"]],
    ["starter", "src/starter-bridge.ts", []],
  ] as const) {
    const r = spawnSync("npx", ["tsx", script, ...common, ...extra], { env, encoding: "utf8" });
    const out = r.stdout + r.stderr;
    transient += (out.match(/transient error|failed \(judge|retrying in/g) ?? []).length;
    fs.appendFileSync(path.join(root, "runs.log"), `\n===== run ${i} ${label} (exit ${r.status})\n${out}`);
    if (r.status !== 0) {
      // A run may legitimately stop on a transient error that outlasted its retries; anything else is a crash.
      const lastLine = out.trim().split("\n").at(-1) ?? "";
      const tolerated = /sim chaos|fetch failed|upstream unavailable|too many calls/.test(lastLine);
      if (!tolerated) crashes++;
      console.log(`run ${i} ${label}: exit ${r.status}${tolerated ? " (chaos outlasted retries; tolerated)" : " CRASH"}: ${lastLine.slice(0, 160)}`);
    }
  }
}

interface ServerSub { id: string; note: string; links: string[]; market: string | null; status: string; createdAt: string }
interface Rec { id: string; direction: string; status: string }
const server = JSON.parse(fs.readFileSync(path.join(root, "sim", "server.json"), "utf8")) as { subs: ServerSub[] };
const agent = JSON.parse(fs.readFileSync(path.join(root, "sim", "state.json"), "utf8")) as { markets: Record<string, { side?: string; submissions: Rec[] }> };
const norm = (u: string) => { const x = new URL(u); return (x.hostname + x.pathname).toLowerCase(); };

const failures: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };

const byMarket = new Map<string, ServerSub[]>();
for (const s of server.subs) if (s.market) byMarket.set(s.market, [...(byMarket.get(s.market) ?? []), s]);
for (const [m, subs] of byMarket) {
  check(subs.length <= 3, `${m}: ${subs.length} submissions (> cap)`);
  const links = subs.flatMap((s) => s.links.map(norm));
  check(new Set(links).size === links.length, `${m}: same source submitted twice`);
  const notes = subs.map((s) => s.note);
  check(new Set(notes).size === notes.length, `${m}: same note submitted twice`);
}
const times = server.subs.map((s) => Date.parse(s.createdAt)).sort((a, b) => a - b);
for (let i = 0; i < times.length; i++) check(times.filter((t) => t >= times[i]! && t < times[i]! + 3_600_000).length <= HOURLY, "hourly limit exceeded");

const records = Object.values(agent.markets).flatMap((m) => m.submissions);
for (const [addr, m] of Object.entries(agent.markets)) {
  check(new Set(m.submissions.map((r) => r.direction)).size <= 1, `${addr}: both sides submitted`);
}
const serverIds = new Set(server.subs.map((s) => s.id));
check(records.length === server.subs.length, `agent remembers ${records.length} submissions, server has ${server.subs.length} (orphans or double submits)`);
for (const r of records) {
  check(serverIds.has(r.id), `agent record ${r.id} unknown to server`);
  check(!["queued", "judging"].includes(r.status), `record ${r.id} left in non-final status ${r.status}`);
}
check(crashes === 0, `${crashes} crashed run(s); see ${root}/runs.log`);
check(server.subs.length >= 15, `only ${server.subs.length} submissions: the test did not exercise enough`);
for (const bad of ["0x" + "c".repeat(39) + "b", "0x" + "c".repeat(39) + "c"]) check(!byMarket.has(bad), `${bad}: submitted to an expired or settled market`);

const statuses = server.subs.reduce<Record<string, number>>((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {});
console.log(`\n${RUNS} rounds × (runner ×3 cycles + starter) in ${Math.round((Date.now() - t0) / 1000)}s · chaos ${CHAOS}`);
console.log(`submissions: ${server.subs.length} on ${byMarket.size} markets · final statuses ${JSON.stringify(statuses)} · transient errors survived: ${transient}`);
if (failures.length) {
  console.log(`\nFAILED ${failures.length} invariant(s):\n- ${[...new Set(failures)].join("\n- ")}`);
  process.exit(1);
}
console.log("ALL INVARIANTS HOLD");
