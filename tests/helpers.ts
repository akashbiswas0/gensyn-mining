/**
 * Test sandbox: a fresh data dir, a fixture market set, and an environment that can never reach a
 * live service (keys blanked so .env can't fill them in, simulator target, canned research).
 * Call sandbox() BEFORE importing anything from src/: config reads the environment at import.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FixtureMarket {
  address: string;
  question: string;
  status: string;
  odds: { yes: number; no: number };
  evidenceCutoffAt: string;
  dataSources: string[];
}

export const addr = (i: number, fill = "c") => `0x${(i + 1).toString(16).padStart(40, fill)}`;
const DAY = 864e5;

/**
 * 12 markets: 0-9 open (odds spread across the band), 10 open but past its evidence cutoff,
 * 11 settled. The same layout the chaos test has always used.
 */
export function fixtureMarkets(): FixtureMarket[] {
  return Array.from({ length: 12 }, (_, i) => ({
    address: addr(i),
    question: `Test market ${i + 1}: will event ${i + 1} happen?`,
    status: i === 11 ? "settled" : "open",
    odds: { yes: 0.25 + (i % 6) * 0.1, no: 0.75 - (i % 6) * 0.1 },
    evidenceCutoffAt: new Date(Date.now() + (i === 10 ? -1 : 1) * 7 * DAY).toISOString(),
    dataSources: [],
  }));
}
export const CLOSED_MARKET = addr(10);
export const SETTLED_MARKET = addr(11);

/** Environment for a run that can only talk to the simulator. */
export function isolatedEnv(dataDir: string, fixture: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATA_DIR: dataDir,
    DELPHI_AGENT_LOG: path.join(dataDir, "events.jsonl"),
    EVIDENCE_TARGET: "sim",
    MARKET_SOURCE: "fixture",
    FIXTURE_MARKETS: fixture,
    RESEARCH: "canned",
    SIM_JUDGE: "heuristic",
    SIM_JUDGE_DELAY_SECONDS: "0",
    SIM_CHAOS: "0",
    SIM_TERMS_VERSION: "sim-1",
    // Blank, not unset: dotenv never overrides a variable that exists, so .env keys stay out.
    DELPHI_API_ACCESS_KEY: "",
    DELPHI_API_KEY: "",
    DELPHI_MARKETS_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ACCEPT_TERMS: "",
    ...extra,
  };
}

/** Creates the sandbox and applies its environment to this process. */
export function sandbox(name: string, extra: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `evidence-agent-${name}-`));
  const fixture = path.join(dir, "markets.json");
  fs.writeFileSync(fixture, JSON.stringify(fixtureMarkets()));
  const env = isolatedEnv(dir, fixture, extra);
  Object.assign(process.env, env);
  return { dir, fixture, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
