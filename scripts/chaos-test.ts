/**
 * npm run test:chaos [-- --scenario=baseline,storm --seed=abc --runs=4 --quick]
 *   --quick   1 round per scenario (coverage minimums scale down), about a minute
 *
 * Aggressive pre-competition test, $0: runs our runner and the official-starter bridge as real
 * processes against the simulator, under several scenarios, then checks invariants on what reached
 * the "server" and on what the agent remembers.
 *
 * Scenarios
 *   baseline      25% injected failures (network errors, 5xx, call-rate 429s, failed judgements)
 *   storm         60% injected failures: retries, idempotency and recovery under heavy fire
 *   tight-hourly  hourly limit of 4: the agent must stop at the limit, never go past it
 *   no-access     account without evidence access: 404 on every call, a clean stop with the reasons
 *   no-terms      terms not accepted: nothing submitted, a clean stop that names the terms
 *   slow-judge    judging outlasts the polling window: results stay pending across the run,
 *                 then `npm run outcomes` finalises them from the API
 *
 * Invariants (every scenario)
 *   rules     ≤ 3 submissions per market, ≤ hourly limit in any hour, nothing on a closed or
 *             settled market, ≤ 3 items per submission, note ≤ 8,000 chars with an ISO date,
 *             http(s) links only, a marketAddress and an X-Agent-Id on every submission
 *   strategy  never both sides of a market, never the same source or note twice on a market
 *   memory    no double submits or orphans (agent ↔ server 1:1), the agent remembers exactly the
 *             note and links that were sent and the verdict that came back, every record final
 *   process   no crashes (only tolerated: chaos outlasting retries, or the scenario's expected stop)
 *
 * Each scenario but slow-judge (which recovers through outcomes) ends with one calm cycle (no injected failures), like the next live cycle: it must
 * recover any result lost to a failed poll, so "every record final" really tests recovery.
 *
 * Randomness (failure injection, canned research) is seeded: a failing run prints the command
 * that replays it.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLOSED_MARKET, SETTLED_MARKET, fixtureMarkets, isolatedEnv } from "../tests/helpers.js";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SEED = arg("seed") ?? randomBytes(4).toString("hex");
const baseRules = JSON.parse(fs.readFileSync("config/rules.json", "utf8"));
const MAX_NOTE = baseRules.noteHardMaxChars as number;
const MAX_ITEMS = baseRules.maxItemsPerSubmission as number;
const PER_MARKET = baseRules.maxSubmissionsPerMarket as number;

interface Scenario {
  name: string;
  what: string;
  runs: number;
  chaos: number;
  hourly?: number;
  env?: Record<string, string>;
  rules?: Record<string, unknown>;
  /** Process ends that are expected in this scenario (matched on the last output line). */
  expectedStop?: RegExp;
  min: number;
  max?: number;
  starter?: boolean;
  /** Wait, then run `npm run outcomes` before checking. */
  outcomesAfterMs?: number;
}

const SCENARIOS: Scenario[] = [
  { name: "baseline", what: "25% injected failures", runs: 5, chaos: 0.25, min: 15 },
  { name: "storm", what: "60% injected failures", runs: 2, chaos: 0.6, min: 2 },
  { name: "tight-hourly", what: "hourly limit 4", runs: 3, chaos: 0.1, hourly: 4, min: 4, max: 4 },
  { name: "no-access", what: "account not registered (404 everywhere)", runs: 1, chaos: 0, env: { SIM_NO_ACCESS: "1" }, expectedStop: /no evidence access/, min: 0, max: 0 },
  { name: "no-terms", what: "terms not accepted", runs: 1, chaos: 0, env: { ACCEPT_TERMS: "" }, expectedStop: /terms/i, min: 0, max: 0 },
  {
    name: "slow-judge", what: "judging outlasts polling; outcomes finalises", runs: 1, chaos: 0, starter: false,
    env: { SIM_JUDGE_DELAY_SECONDS: "5" }, rules: { pollMaxMinutes: 0.02 }, min: 2, outcomesAfterMs: 6000,
  },
];

const only = arg("scenario")?.split(",");
const picked = only ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
if (!picked.length) {
  console.error(`No scenario named ${only}. Known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  process.exit(2);
}
const QUICK = process.argv.includes("--quick");
const runsOverride = arg("runs") ? Number(arg("runs")) : QUICK ? 1 : undefined;

const ROOT = "data/chaos";
fs.rmSync(ROOT, { recursive: true, force: true });

interface ServerSub {
  id: string; note: string; links: string[]; files: number; market: string | null; status: string; createdAt: string;
  agentId: string | null; verdict: string | null; gaveBack?: boolean;
}
interface Rec { id: string; direction: string; status: string; note: string; links: string[]; verdict: string | null }
interface Result { s: Scenario; ok: boolean; failures: string[]; subs: number; markets: number; accepted: number; judged: number; transient: number; pendingBefore: number; secs: number }

const norm = (u: string) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); } catch { return u; } };

function runScenario(s: Scenario): Result {
  const t0 = Date.now();
  const root = path.join(ROOT, s.name);
  fs.mkdirSync(root, { recursive: true });
  const fixture = path.join(root, "markets.json");
  fs.writeFileSync(fixture, JSON.stringify(fixtureMarkets()));
  const rulesFile = path.join(root, "rules.json");
  fs.writeFileSync(rulesFile, JSON.stringify({ ...baseRules, backoffHoursWhenNothingFound: 0, ...s.rules }));
  const hourly = s.hourly ?? 20;

  const env = {
    ...process.env,
    ...isolatedEnv(root, fixture, {
      ACCEPT_TERMS: "sim-1",
      SIM_CHAOS: String(s.chaos),
      SIM_HOURLY_LIMIT: String(hourly),
      RULES_FILE: rulesFile,
      MARKETS_PER_CYCLE: "6",
      MAX_SUBMISSIONS_PER_CYCLE: "6",
      DELPHI_AGENT_ID: `chaos-${s.name}`,
      ...s.env,
    }),
  };
  const args = ["--sim", "--markets=fixture", "--offline"];

  const failures: string[] = [];
  const check = (ok: boolean, msg: string) => { if (!ok) failures.push(msg); };
  let transient = 0;
  let recovered = 0;

  const run = (label: string, script: string, extra: string[], seed: string) => {
    const r = spawnSync("npx", ["tsx", script, ...args, ...extra], { env: { ...env, SIM_SEED: seed }, encoding: "utf8" });
    const out = r.stdout + r.stderr;
    transient += (out.match(/transient error|failed \(judge|retrying in/g) ?? []).length;
    fs.appendFileSync(path.join(root, "runs.log"), `\n===== ${label} seed=${seed} (exit ${r.status})\n${out}`);
    if (r.status !== 0) {
      const last = out.trim().split("\n").at(-1) ?? "";
      const tolerated = /sim chaos|fetch failed|upstream unavailable|too many calls/.test(last) || (s.expectedStop?.test(last) ?? false);
      if (!tolerated) check(false, `${label} crashed (exit ${r.status}): ${last.slice(0, 200)}`);
    } else if (s.expectedStop) {
      check(false, `${label} exited 0, expected a stop matching ${s.expectedStop}`);
    }
  };

  const runs = runsOverride ?? s.runs;
  for (let i = 1; i <= runs; i++) {
    run(`round ${i} runner`, "src/agent.ts", ["--cycles=3"], `${SEED}:${s.name}:${i}:runner`);
    if (s.starter !== false) run(`round ${i} starter`, "src/starter-bridge.ts", [], `${SEED}:${s.name}:${i}:starter`);
  }

  // One calm cycle at the end, like the next live cycle after a bad spell: it must pick up any
  // submission whose result was lost to a failed poll (refreshPending). Without that recovery the
  // "every record final" invariant below fails.
  if (!s.outcomesAfterMs) {
    const calm = { ...env, SIM_CHAOS: "0", SIM_SEED: `${SEED}:${s.name}:calm` };
    const r = spawnSync("npx", ["tsx", "src/agent.ts", ...args, "--cycles=1"], { env: calm, encoding: "utf8" });
    const out = r.stdout + r.stderr;
    fs.appendFileSync(path.join(root, "runs.log"), `\n===== calm recovery cycle (exit ${r.status})\n${out}`);
    recovered = (out.match(/\(earlier submission\)/g) ?? []).length;
    if (r.status !== 0 && !(s.expectedStop?.test(out.trim().split("\n").at(-1) ?? ""))) check(false, `calm cycle crashed: ${out.trim().split("\n").at(-1)?.slice(0, 200)}`);
  }

  const serverFile = path.join(root, "sim", "server.json");
  const stateFile = path.join(root, "sim", "state.json");
  const readServer = () => (fs.existsSync(serverFile) ? JSON.parse(fs.readFileSync(serverFile, "utf8")).subs : []) as ServerSub[];
  const readAgent = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")).markets : {}) as Record<string, { side?: string; submissions: Rec[] }>;

  let pendingBefore = 0;
  if (s.outcomesAfterMs) {
    pendingBefore = Object.values(readAgent()).flatMap((m) => m.submissions).filter((r) => ["queued", "judging"].includes(r.status)).length;
    check(pendingBefore > 0, "slow-judge: no record was left pending, so recovery was not exercised");
    spawnSync("sleep", [String(s.outcomesAfterMs / 1000)]);
    run("outcomes", "src/outcomes.ts", [], `${SEED}:${s.name}:outcomes`);
  }

  const server = readServer();
  const agent = readAgent();

  // rules
  const byMarket = new Map<string, ServerSub[]>();
  for (const x of server) {
    check(!!x.market, `${x.id}: no marketAddress`);
    if (x.market) byMarket.set(x.market, [...(byMarket.get(x.market) ?? []), x]);
    const items = (x.note.trim() ? 1 : 0) + x.links.length + (x.files ?? 0);
    check(items <= MAX_ITEMS, `${x.id}: ${items} items (> ${MAX_ITEMS})`);
    check(x.note.length <= MAX_NOTE, `${x.id}: note of ${x.note.length} chars`);
    check(/\b20\d\d-\d\d-\d\d\b/.test(x.note), `${x.id}: note has no ISO date`);
    check(x.links.every((l) => /^https?:\/\/\S+$/.test(l)), `${x.id}: a link is not a plain http(s) URL`);
    check(!!x.agentId, `${x.id}: sent without X-Agent-Id`);
  }
  for (const [m, subs] of byMarket) {
    const counted = subs.filter((x) => !x.gaveBack).length; // a judged duplicate gives its slot back
    check(counted <= PER_MARKET, `${m}: ${counted} counted submissions (> ${PER_MARKET})`);
    const links = subs.flatMap((x) => x.links.map(norm));
    check(new Set(links).size === links.length, `${m}: the same source submitted twice`);
    check(new Set(subs.map((x) => x.note)).size === subs.length, `${m}: the same note submitted twice`);
  }
  // The limit is per UTC clock hour.
  const perHour = new Map<string, number>();
  for (const x of server) if (!x.gaveBack) perHour.set(x.createdAt.slice(0, 13), (perHour.get(x.createdAt.slice(0, 13)) ?? 0) + 1);
  for (const [h, c] of perHour) check(c <= hourly, `${c} submissions in hour ${h} (> ${hourly})`);
  for (const bad of [CLOSED_MARKET, SETTLED_MARKET]) check(!byMarket.has(bad), `${bad}: submitted to a closed or settled market`);

  // strategy + memory
  const bySrv = new Map(server.map((x) => [x.id, x]));
  const records = Object.values(agent).flatMap((m) => m.submissions);
  for (const [a, m] of Object.entries(agent)) check(new Set(m.submissions.map((r) => r.direction)).size <= 1, `${a}: both sides submitted`);
  check(records.length === server.length, `agent remembers ${records.length} submissions, server has ${server.length} (orphan or double submit)`);
  check(new Set(records.map((r) => r.id)).size === records.length, "the agent recorded one submission twice");
  for (const r of records) {
    const x = bySrv.get(r.id);
    if (!x) { check(false, `agent record ${r.id} unknown to the server`); continue; }
    check(r.note === x.note, `${r.id}: remembered note differs from the note sent`);
    check(JSON.stringify(r.links) === JSON.stringify(x.links), `${r.id}: remembered links ${JSON.stringify(r.links)} differ from sent ${JSON.stringify(x.links)}`);
    check(!["queued", "judging"].includes(r.status), `${r.id}: left in non-final status ${r.status}`);
    if (x.status === "judged") check(r.verdict === x.verdict, `${r.id}: remembered verdict ${r.verdict}, server says ${x.verdict}`);
  }

  // coverage
  const min = Math.min(s.min, Math.floor((s.min * runs) / s.runs));
  check(server.length >= min, `only ${server.length} submissions (want ≥ ${min}): the scenario did not exercise enough`);
  const max = s.max === undefined ? undefined : s.max * Math.max(1, perHour.size); // a run may cross a clock hour
  if (max !== undefined) check(server.length <= max, `${server.length} submissions (want ≤ ${max})`);

  const judged = server.filter((x) => x.status === "judged");
  return {
    s, ok: failures.length === 0, failures: [...new Set(failures)], subs: server.length, markets: byMarket.size,
    accepted: judged.filter((x) => x.verdict === "accepted").length, judged: judged.length, transient, pendingBefore: pendingBefore + recovered,
    secs: Math.round((Date.now() - t0) / 1000),
  };
}

console.log(`chaos test · seed ${SEED} · scenarios: ${picked.map((s) => s.name).join(", ")}\n`);
const results: Result[] = [];
for (const s of picked) {
  process.stdout.write(`▶ ${s.name.padEnd(13)} ${s.what} … `);
  const r = runScenario(s);
  results.push(r);
  const extra = [
    `${r.subs} submissions on ${r.markets} markets`,
    r.judged ? `${r.accepted}/${r.judged} accepted` : "",
    r.transient ? `${r.transient} transient errors survived` : "",
    r.pendingBefore ? `${r.pendingBefore} pending result(s) recovered` : "",
    `${r.secs}s`,
  ].filter(Boolean).join(" · ");
  console.log(`${r.ok ? "✔" : "✖"} ${extra}`);
  for (const f of r.failures) console.log(`    - ${f}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed · logs in ${ROOT}/<scenario>/runs.log`);
if (failed.length) {
  console.log(`Replay: npm run test:chaos -- --seed=${SEED} --scenario=${failed.map((r) => r.s.name).join(",")}`);
  process.exit(1);
}
console.log("ALL INVARIANTS HOLD");
