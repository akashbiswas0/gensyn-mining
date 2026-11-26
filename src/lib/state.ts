/** Local, durable agent memory: sides taken, what was submitted, verdicts, spend. data/state.json */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Direction } from "../types.js";

export interface SubmissionRecord {
  id: string;
  at: string;
  direction: Direction;
  note: string;
  links: string[];
  /** Names of attached files. */
  files?: string[];
  status: string;
  verdict: string | null;
  reason: string | null;
  /** Rejected submissions: which check failed (`duplicate`, a screening or moderation code). */
  code?: string;
  bounty: string | null;
  bountyState: string | null;
  zeroPayReason?: string;
  /** Hash of prompts + guide + rules + models when this was submitted (src/lib/version.ts). */
  promptVersion?: string;
  /** Claude spend (USD) on the research and fact-check that produced this submission. */
  costUsd?: number;
  /** Upper bound of the settlement reward, as reported at judging (USDC.e base units). */
  settlementUpTo?: string | null;
  /** Once the market settles: did this submission point the right way? */
  outcome?: "right" | "wrong" | "void";
}

export interface MarketState {
  /** Once we submit on a side we stay on it: evidence for both sides cancels out in the ranking. */
  side?: Direction;
  submissions: SubmissionRecord[];
  lastResearchedAt?: string;
  /** Back off from a market (e.g. research found nothing new) until this time. */
  skipUntil?: string;
  /** Short notes the researcher should not repeat (things it already found but didn't submit). */
  seenClaims: string[];
  /** Filled by `npm run outcomes` once the market has a final status. */
  resolved?: { status: string; winner: Direction | null; checkedAt: string };
}

interface State {
  markets: Record<string, MarketState>;
  spendByDay: Record<string, number>;
  /** Last X-Contract-Version the evidence API reported; a change means the API changed. */
  apiContractVersion?: string;
}

const file = () => path.join(config.dataDir, "state.json");

let state: State | null = null;

export function load(): State {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(file(), "utf8")) as State;
  } catch {
    state = { markets: {}, spendByDay: {} };
  }
  return state;
}

export function save(): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(load(), null, 2));
  fs.renameSync(f + ".tmp", f);
}

export function market(address: string): MarketState {
  const s = load();
  const key = address.toLowerCase();
  return (s.markets[key] ??= { submissions: [], seenClaims: [] });
}

const today = () => new Date().toISOString().slice(0, 10);

export function addSpend(usd: number): void {
  const s = load();
  s.spendByDay[today()] = (s.spendByDay[today()] ?? 0) + usd;
  save();
}

export const spentToday = () => load().spendByDay[today()] ?? 0;

const DAY = 864e5;
/** The judged `duplicate` verdicts that gave their slot back (at most `limit` in any 24 h). */
function givenBack(limit: number): Set<string> {
  const dups = Object.values(load().markets)
    .flatMap((m) => m.submissions)
    .filter((r) => r.status === "judged" && /^duplicate$/i.test(r.verdict ?? ""))
    .sort((a, b) => a.at.localeCompare(b.at));
  const out: SubmissionRecord[] = [];
  for (const r of dups) if (out.filter((o) => Date.parse(r.at) - Date.parse(o.at) < DAY).length < limit) out.push(r);
  return new Set(out.map((r) => r.id));
}

/**
 * Slots used on a market. Every submission with an id uses one, whatever its verdict, except a
 * JUDGED `duplicate`, which gives its slot back (official, 2026-11-25). A submission REJECTED with
 * code `duplicate` keeps its count. Entry-state stays the authority; this only ranks markets.
 */
export function slotsUsed(address: string, giveBackLimit: number): number {
  const back = givenBack(giveBackLimit);
  return market(address).submissions.filter((r) => !back.has(r.id)).length;
}
