/** Builds the submitted note from rules.noteTemplate (the starter uses "As of {{date}}: {{text}}"). */
import { rules } from "../config.js";
import { render } from "./prompts.js";

export function formatNote(date: string, text: string): string {
  const note = render(rules.noteTemplate, { date, text: text.trim() });
  if (note.length <= rules.noteMaxChars) return note;
  // Cut at the last sentence end that fits, else hard-cut.
  const cut = note.slice(0, rules.noteMaxChars);
  const end = cut.lastIndexOf(". ");
  return end > rules.noteMaxChars * 0.6 ? cut.slice(0, end + 1) : cut.trimEnd();
}

/** Characters left for the fact text once the template is applied (used in the fact-check prompt). */
export function textBudget(): number {
  return Math.max(120, rules.noteMaxChars - render(rules.noteTemplate, { date: "2026-11-23", text: "" }).length);
}

export const noteShape = () => `"${rules.noteTemplate}"`;
