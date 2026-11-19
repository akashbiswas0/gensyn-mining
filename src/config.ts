/**
 * Settings come from three places, so the 23 Nov guide can be adopted without code changes:
 *   .env               secrets and endpoints (names match the official starter agent)
 *   config/rules.json  competition rules and agent policy
 *   prompts/, guide/   what the model is told (see src/lib/prompts.ts)
 *
 * Everything is REAL by default. Three switches replace one part at a time for testing:
 *   --markets=competition|delphi|fixture   where markets come from (default: competition)
 *        competition = <COMPETITION_SITE_URL>/markets.json (live from 23 Nov)
 *        delphi      = real live Delphi markets via the SDK's DelphiClient (works today)
 *        fixture     = fixtures/markets.sample.json
 *   --sim          send submissions to the local competition simulator (src/sim) instead of Delphi
 *   --offline      canned research instead of Claude ($0; for plumbing and chaos tests)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type MarketSource = "competition" | "delphi" | "fixture";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const env = (...names: string[]) => names.map((n) => process.env[n]).find((v) => v !== undefined && v !== "") ?? "";
const num = (v: string, d: number) => (v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const effort = (v: string, d: Effort): Effort =>
  (["low", "medium", "high", "xhigh", "max"] as const).includes(v as Effort) ? (v as Effort) : d;

export interface Rules {
  maxSubmissionsPerMarket: number;
  maxLinksPerSubmission: number;
  maxFilesPerSubmission: number;
  noteTemplate: string;
  noteMaxChars: number;
  qualification: { judgedSubmissions: number; markets: number };
  marketFilter: { statuses: string[]; minYes: number; maxYes: number };
  cutoffBufferMinutes: number;
  oneSidePerMarket: boolean;
  submissionsPerMarketPerCycle: number;
  minVerifyScore: number;
  backoffHoursWhenNothingFound: number;
}

export const rules: Rules = JSON.parse(fs.readFileSync(process.env.RULES_FILE ?? "config/rules.json", "utf8"));

const marketSource = (opt("markets") ?? env("MARKET_SOURCE") ?? "") || "competition";
if (!["competition", "delphi", "fixture"].includes(marketSource)) throw new Error(`Unknown market source "${marketSource}"`);
const sim = flag("sim") || env("EVIDENCE_TARGET") === "sim";
const dataRoot = env("DATA_DIR") || "data";

export const config = {
  marketSource: marketSource as MarketSource,
  sim,
  offline: flag("offline") || env("RESEARCH") === "canned",
  loop: flag("loop"),
  cycles: num(opt("cycles") ?? "", 1),

  // Same variable names as the official starter (older names still accepted).
  siteUrl: env("COMPETITION_SITE_URL") || "https://agent-competition.gensyn.ai",
  apiUrl: env("DELPHI_API_URL", "EVIDENCE_API_BASE_URL"),
  apiKey: env("DELPHI_API_ACCESS_KEY", "DELPHI_API_KEY"),
  acceptTerms: env("ACCEPT_TERMS") || undefined,
  agentId: env("AGENT_ID") || "my-evidence-agent",
  agentHarness: env("AGENT_HARNESS") || "delphi-evidence-agent-ts",

  /** For --markets=delphi: a Delphi API key for that network (testnet: delphi-api-access.gensyn.ai, mainnet: api-access.delphi.fyi). */
  delphiMarketsNetwork: (env("DELPHI_MARKETS_NETWORK") || "mainnet") as "mainnet" | "testnet",
  delphiMarketsApiKey: env("DELPHI_MARKETS_API_KEY", "DELPHI_API_ACCESS_KEY"),

  researchModel: env("RESEARCH_MODEL") || "claude-opus-5-5",
  verifyModel: env("VERIFY_MODEL") || "claude-opus-5-5",
  researchEffort: effort(env("RESEARCH_EFFORT"), "high"),
  verifyEffort: effort(env("VERIFY_EFFORT"), "high"),
  get agentModel() {
    return env("AGENT_MODEL") || this.researchModel;
  },

  dailyBudgetUsd: num(env("DAILY_BUDGET_USD"), 10),
  marketsPerCycle: num(env("MARKETS_PER_CYCLE"), 3),
  maxSubmissionsPerCycle: num(env("MAX_SUBMISSIONS_PER_CYCLE"), 3),
  loopIntervalMinutes: num(env("LOOP_INTERVAL_MINUTES"), 45),
  minVerifyScore: num(env("MIN_VERIFY_SCORE"), rules.minVerifyScore),

  /** Live and simulated runs keep separate memory, so tests never pollute the real record. */
  dataDir: sim ? path.join(dataRoot, "sim") : dataRoot,
  fixtureMarkets: env("FIXTURE_MARKETS") || "fixtures/markets.sample.json",
};

export function describeMode(): string {
  return [
    `markets: ${config.marketSource}${config.marketSource === "delphi" ? ` (${config.delphiMarketsNetwork})` : ""}`,
    `submissions: ${config.sim ? "SIMULATOR" : "LIVE Delphi"}`,
    `research: ${config.offline ? "canned" : `Claude ${config.researchModel}`}`,
  ].join(" · ");
}

export function requireLive(): void {
  const missing = [!config.apiUrl && "DELPHI_API_URL", !config.apiKey && "DELPHI_API_ACCESS_KEY"].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(", ")} in .env (published on 23 Nov). Until then add --sim.`);
  }
}
