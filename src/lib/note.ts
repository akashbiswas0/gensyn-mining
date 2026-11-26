/** Builds the submitted note from rules.noteTemplate (the starter uses "As of {{date}}: {{text}}"). */
import { rules } from "../config.js";
import { render } from "./prompts.js";

export function formatNote(date: string, text: string): string {
  const note = render(rules.noteTemplate, { date, text: text.trim() }).slice(0, rules.noteHardMaxChars);
  if (note.length <= rules.noteMaxChars) return note;
  // Cut at the last sentence end that fits, else hard-cut.
  const cut = note.slice(0, rules.noteMaxChars);
  const end = cut.lastIndexOf(". ");
  return end > rules.noteMaxChars * 0.6 ? cut.slice(0, end + 1) : cut.trimEnd();
}

/**
 * Appends a calculation's working (CSV rows) to the note when it got no file slot of its own.
 * Bounded by the API's hard note limit; dropped whole rather than cut mid-table.
 */
export function withWorking(note: string, csv: string): string {
  if (!csv.trim()) return note;
  const out = `${note}\n\nWorking (CSV):\n${csv.trim()}`;
  return out.length <= rules.noteHardMaxChars ? out : note;
}

/** Characters left for the fact text once the template is applied (used in the fact-check prompt). */
export function textBudget(): number {
  return Math.max(120, rules.noteMaxChars - render(rules.noteTemplate, { date: "2026-11-23", text: "" }).length);
}

export const noteShape = () => `"${rules.noteTemplate}"`;

/**
 * Deterministic last check on the exact text we send (Pilot Terms: no attempts to trick the
 * judge; real, sourced information). Returns problems; empty means OK.
 */
export function lintNote(note: string, links: string[]): string[] {
  const problems: string[] = [];
  const addressesJudge =
    /\b(ignore (all|any|the|previous)|disregard|system prompt|you (must|should) (rate|score|accept|update|raise|lower)|as an ai|(dear|to the) (judge|forecaster|model)|rate this|score this|instructions?:)/i;
  if (addressesJudge.test(note)) problems.push("note addresses or instructs the judge");
  if (/<\/?[a-z_]+>|\{\{|\}\}/i.test(note)) problems.push("note contains markup or template tokens");
  if (!/\b20\d\d-\d\d-\d\d\b/.test(note)) problems.push("note has no ISO date");
  if (!links.length) problems.push("no source link");
  if (links.some((l) => !/^https?:\/\//.test(l))) problems.push("source links must be http(s) URLs");
  if (/\[OFFLINE|canned|placeholder|lorem ipsum|example\.(com|org|net)/i.test(note + links.join(" "))) problems.push("test/placeholder content");
  return problems;
}
