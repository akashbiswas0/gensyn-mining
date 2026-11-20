/**
 * The agent's "brain": research → filter → fact-check, for one market. Used by our own pipeline
 * (src/pipeline.ts) and, through src/starter-bridge.ts, as the official starter's `findFact()`.
 * Returns the best verified fact, or null.
 */
import { config, rules } from "./config.js";
import { event, info } from "./lib/log.js";
import readline from "node:readline/promises";
import { formatNote, lintNote } from "./lib/note.js";
import * as state from "./lib/state.js";
import { stages } from "./stages/index.js";
import { buildAttachments } from "./lib/attachments.js";
import type { Attachment, Candidate, Market, Verification } from "./types.js";

export interface Proposal {
  candidate: Candidate;
  verification: Verification;
  /** The final note, built from rules.noteTemplate. */
  note: string;
  links: string[];
  files: Attachment[];
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
    const links = c.sourceUrls.slice(0, rules.maxLinksPerSubmission);
    const files = config.offline ? [] : await buildAttachments({ workingCsv: v.workingCsv, mainSource: links[0], sourceMayBeUnreadable: v.sourceMayBeUnreadable, links: links.length });
    if (config.offline && v.workingCsv) files.push({ name: "working.csv", type: "text/csv", data: new TextEncoder().encode(v.workingCsv) });
    const proposal: Proposal = { candidate: c, verification: v, note: formatNote(v.factDate, v.factText), links, files };
    const blocked = await preSubmitGate(m, proposal);
    if (blocked) {
      event("SKIP", `Blocked before submit (${blocked}): ${proposal.note}`);
      s.seenClaims.push(c.claim);
      state.save();
      continue;
    }
    event("THINK", `Chose ${c.direction.toUpperCase()} fact for "${m.question}": ${c.whyItMatters} (novelty ${v.novelty.toFixed(2)}, relevance ${v.relevance.toFixed(2)})`);
    return proposal;
  }
  return null;
}

/** Last checks on the exact submission, shared by our runner and the starter bridge. Returns a reason to block, or null. */
async function preSubmitGate(m: Market, p: Proposal): Promise<string | null> {
  // Canned research only exists to test plumbing against the simulator; its placeholder text is expected there.
  const lint = config.offline && config.sim ? [] : lintNote(p.note, p.links);
  if (lint.length) return lint.join("; ");

  // Research can take minutes; the evidence cutoff may have passed meanwhile.
  if (m.evidenceCutoff && m.evidenceCutoff.getTime() - Date.now() < 60_000) return "evidence cutoff passed during research";

  if (config.review) {
    if (!process.stdin.isTTY) return "--review needs an interactive terminal";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\n── Review submission ──\nMarket: ${m.question}\nSide:   ${p.candidate.direction.toUpperCase()}\nNote:   ${p.note}\nLinks:  ${p.links.join("  ")}\nFiles:  ${p.files.map((f) => `${f.name} (${Math.round(f.data.byteLength / 1024)} KB)`).join(", ") || "none"}\nCheck:  novelty ${p.verification.novelty.toFixed(2)}, relevance ${p.verification.relevance.toFixed(2)}${p.verification.issues.length ? `, notes: ${p.verification.issues.join("; ")}` : ""}`);
    const answer = (await rl.question("Submit this? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") return "declined in review";
  }
  return null;
}
