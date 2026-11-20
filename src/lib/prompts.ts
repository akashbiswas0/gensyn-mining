/**
 * Prompt templates live in prompts/*.md with {{placeholders}}. Every .md file in guide/
 * (except its README) is injected into the system prompts as official guidance, so the
 * official guide (synced by npm run sync-official) and any notes you add reach the model.
 */
import fs from "node:fs";
import path from "node:path";

export function guideText(dir = "guide"): string {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md").sort();
  } catch {
    return "";
  }
  const parts = files.map((f) => `<document name="${f}">\n${fs.readFileSync(path.join(dir, f), "utf8").trim()}\n</document>`);
  return parts.length
    ? `\nThe competition organisers published the guidance below. Follow it; where it conflicts with anything above, the guidance wins.\n<official_guidance>\n${parts.join("\n")}\n</official_guidance>`
    : "";
}

export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`Prompt placeholder {{${k}}} has no value`);
    return String(vars[k]);
  });
}

/** Loads prompts/<name>.md and fills it. `{{guide}}` is always available. */
export function prompt(name: string, vars: Record<string, string | number> = {}): string {
  const template = fs.readFileSync(path.join(process.env.PROMPTS_DIR ?? "prompts", `${name}.md`), "utf8");
  return render(template, { guide: guideText(), ...vars }).trim();
}
