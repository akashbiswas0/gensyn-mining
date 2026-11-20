/**
 * Settings come from three places, so official rule changes can be adopted without code changes:
 *   .env               secrets and endpoints (names match the official starter agent)
 *   config/rules.json  competition rules and agent policy
 *   prompts/, guide/   what the model is told (see src/lib/prompts.ts)
 *
 * Everything is REAL by default. Three switches replace one part at a time for testing:
 *   --markets=competition|delphi|fixture   where markets come from (default: competition)
 *        competition = <COMPETITION_SITE_URL>/markets.json (live from 25 Nov)
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
  noteHardMaxChars: number;
  maxItemsPerSubmission: number;
  maxFileBytesTotal: number;
  allowedFileTypes: string[];
  acceptanceGuard: { window: number; minAcceptedRate: number };
  pollMaxMinutes: number;
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
  /** --review: show each submission and ask before sending (you are responsible for what the agent submits). */
  review: flag("review") || env("REVIEW") === "1",
  cycles: num(opt("cycles") ?? "", 1),

  // Official values from the competition guide (gensyn-delphi-skills reference/competition.md).
  // Variable names: the official skill's first, the official starter's second.
  siteUrl: env("COMPETITION_SITE_URL") || "https://competition.delphi.fyi",
  apiUrl: env("DELPHI_EVIDENCE_URL", "DELPHI_API_URL", "EVIDENCE_API_BASE_URL") || "https://delphi.fyi/v1",
  /** A MAINNET Delphi API key (api-access.delphi.fyi). Testnet keys get 401 from the competition. */
  apiKey: env("DELPHI_API_ACCESS_KEY", "DELPHI_API_KEY"),
  /** The wallet the key was created with = the DoraHacks registration wallet. Needed for feedback. */
  wallet: env("DELPHI_WALLET_ADDRESS", "CDP_WALLET_ADDRESS"),
  acceptTerms: env("ACCEPT_TERMS") || undefined,
  agentId: env("DELPHI_AGENT_ID", "AGENT_ID") || "my-evidence-agent",
  agentHarness: env("DELPHI_AGENT_HARNESS", "AGENT_HARNESS") || "delphi-evidence-agent-ts",
  feedbackUrl: env("DELPHI_FEEDBACK_URL") || "https://feedback.delphi.fyi",

  /** Reading Delphi markets with the SDK. Competition markets are Delphi MAINNET markets. For
   *  testing with --markets=delphi you can read another network with its own key. */
  delphiMarketsNetwork: (env("DELPHI_MARKETS_NETWORK") || "mainnet") as "mainnet" | "testnet",
  delphiMarketsApiKey: env("DELPHI_MARKETS_API_KEY", "DELPHI_API_ACCESS_KEY"),

  researchModel: env("RESEARCH_MODEL") || "claude-opus-5-5",
  verifyModel: env("VERIFY_MODEL") || "claude-opus-5-5",
  researchEffort: effort(env("RESEARCH_EFFORT"), "high"),
  verifyEffort: effort(env("VERIFY_EFFORT"), "high"),
  get agentModel() {
    return env("DELPHI_AGENT_MODEL", "AGENT_MODEL") || this.researchModel;
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

/**
 * Hard guards before anything reaches the real Delphi API (Pilot Terms, "Fair play"):
 *  - canned research is invented text: submitting it live would be fabricated evidence
 *  - fixture/Delphi markets aren't competition markets: rewards there don't count, so live
 *    submissions to them would only burn limits
 *  - results must show under the agent name registered on DoraHacks (X-Agent-Id)
 */
export function requireLive(): void {
  const problems = [
    !config.apiKey && "DELPHI_API_ACCESS_KEY is not set (a Mainnet key from https://api-access.delphi.fyi/)",
    config.offline && "--offline (canned research) can never submit live: it would be fabricated evidence",
    config.marketSource !== "competition" && `--markets=${config.marketSource} is for testing only: live submissions must go to competition markets`,
    config.agentId === "my-evidence-agent" && "set DELPHI_AGENT_ID in .env to the agent name you registered on DoraHacks",
  ].filter(Boolean);
  if (problems.length) throw new Error(`Refusing to submit live:\n- ${problems.join("\n- ")}\n(Add --sim to test against the simulator.)`);
}
