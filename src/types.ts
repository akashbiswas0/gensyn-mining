/**
 * Shared types. `MarketCard` and `Fact` are the official starter agent's own types
 * (vendor/evidence-starter/agent.ts), re-exported so our code and theirs agree.
 */
import type { Fact as StarterFact, MarketCard as StarterMarketCard } from "../vendor/evidence-starter/agent.js";

/** A /markets.json entry as the starter reads it. The real export may carry more fields. */
export type MarketCard = StarterMarketCard;
/** What the starter submits: `As of <date>: <text>` with one source link. */
export type Fact = StarterFact;

/** A market normalised for our pipeline. `raw` keeps every field from /markets.json. */
export interface Market {
  address: string;
  question: string;
  status: string;
  /** Resolution criteria / description, if the feed provides it. */
  description: string;
  outcomes: string[];
  /** Market probability of YES (0-1), or null if unknown. */
  probYes: number | null;
  /** Evidence is only accepted before this time. */
  evidenceCutoff: Date | null;
  closesAt: Date | null;
  /** Remaining judgement reward pot in USDC, if the feed provides it (entry-state also has it). */
  rewardPot: number | null;
  /** The sources the market resolves from. Research starts here. */
  dataSources: string[];
  category: string | null;
  url: string | null;
  raw: Record<string, unknown>;
}

export type Direction = "yes" | "no";

/** One fact the research stage found. */
export interface Candidate {
  claim: string;
  eventDate: string;
  publishedDate: string;
  direction: Direction;
  sourceUrls: string[];
  quote: string;
  whyNew: string;
  whyItMatters: string;
  expectedImpact: "low" | "medium" | "high";
  confidence: number;
  /** 0-1: chance the forecaster already has this, or a faster agent will submit the same obvious record. High = likely a duplicate. */
  duplicationRisk: number;
}

/** The fact-check of one candidate. `factDate` + `factText` become the note via rules.noteTemplate. */
export interface Verification {
  supported: boolean;
  dateConfirmed: boolean;
  directionCorrect: boolean;
  novelty: number;
  relevance: number;
  /** 0-1: how likely the forecaster already has this / an obvious fact other agents also fetch. Penalises the score. */
  duplicationRisk: number;
  score: number;
  issues: string[];
  factDate: string;
  factText: string;
  /** Inputs and working of a calculation as CSV ("" if none). Attached as working.csv. */
  workingCsv: string;
  /** The judge may not be able to open the main source (JS page, bot-blocked, login, huge). */
  sourceMayBeUnreadable: boolean;
}

/** A file to attach to a submission. */
export interface Attachment {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface ResearchResult {
  candidates: Candidate[];
  contraryEvidence: string;
  summary: string;
}

/** Pluggable stages (src/stages/index.ts picks the implementation). */
export interface Stages {
  research(m: Market, memory: import("./lib/state.js").MarketState): Promise<ResearchResult>;
  verify(m: Market, c: Candidate): Promise<Verification>;
}
