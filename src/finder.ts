/**
 * The agent's "brain": research → filter → fact-check, for one market. Used by our own pipeline
 * (src/pipeline.ts) and, through src/starter-bridge.ts, as the official starter's `findFact()`.
 * Returns the best verified fact, or null.
 */
import { config, rules } from "./config.js";
import { event, info } from "./lib/log.js";
import { formatNote } from "./lib/note.js";
import * as state from "./lib/state.js";
import { stages } from "./stages/index.js";
import type { Candidate, Market, Verification } from "./types.js";

export interface Proposal {
  candidate: Candidate;
  verification: Verification;
  /** The final note, built from rules.noteTemplate. */
  note: string;
  links: string[];
}

const IMPACT = { low: 1, medium: 2, high: 3 } as const;

function normUrl(u: string): string {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
function similarity(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Evidence that repeats an earlier submission earns nothing, so drop near-duplicates before paying to verify. */
function duplicateReason(c: Candidate, s: state.MarketState): string | null {
  const used = new Set(s.submissions.flatMap((x) => x.links.map(normUrl)));
  if (c.sourceUrls[0] && used.has(normUrl(c.sourceUrls[0]))) return "main source already submitted";
  for (const prior of [...s.submissions.map((x) => x.note), ...s.seenClaims]) {
    if (similarity(c.claim, prior) >= 0.6) return "too similar to an earlier note";
  }
  return null;
}

export async function findFact(m: Market): Promise<Proposal | null> {
  const s = state.market(m.address);
  event("THINK", `Researching: ${m.question}`);

  const r = await stages.research(m, s);
  s.lastResearchedAt = new Date().toISOString();
  state.save();
  info(`research: ${r.summary}`);
  if (r.contraryEvidence && s.side) {
    event("THINK", `Contrary evidence on "${m.question}" (we are on ${s.side.toUpperCase()}): ${r.contraryEvidence}`);
  }
  if (!r.candidates.length) {
    event("SKIP", `${m.question}: nothing new found; backing off ${rules.backoffHoursWhenNothingFound}h`);
    s.skipUntil = new Date(Date.now() + rules.backoffHoursWhenNothingFound * 3.6e6).toISOString();
    state.save();
    return null;
  }

  const ordered = [...r.candidates].sort((a, b) => IMPACT[b.expectedImpact] * b.confidence - IMPACT[a.expectedImpact] * a.confidence);
  for (const c of ordered) {
    if (rules.oneSidePerMarket && s.side && c.direction !== s.side) {
      event("SKIP", `Opposite-side fact held back (would cancel our ${s.side.toUpperCase()} evidence): ${c.claim}`);
      continue;
    }
    const dup = duplicateReason(c, s);
    if (dup) { event("SKIP", `${dup}: ${c.claim}`); continue; }

    const v = await stages.verify(m, c);
    if (v.score < config.minVerifyScore) {
      event("SKIP", `Failed fact-check (score ${v.score.toFixed(2)}${v.issues.length ? `; ${v.issues.join("; ")}` : ""}): ${c.claim}`);
      s.seenClaims.push(c.claim);
      state.save();
      continue;
    }
    event("THINK", `Chose ${c.direction.toUpperCase()} fact for "${m.question}": ${c.whyItMatters} (novelty ${v.novelty.toFixed(2)}, relevance ${v.relevance.toFixed(2)})`);
    return { candidate: c, verification: v, note: formatNote(v.factDate, v.factText), links: c.sourceUrls.slice(0, rules.maxLinksPerSubmission) };
  }
  return null;
}
