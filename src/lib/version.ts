/**
 * A short fingerprint of everything that shapes what the agent submits: prompts, guide, rules,
 * models and efforts. Every submission (simulated or live) records it, so `npm run report`
 * can compare versions and the best one can be promoted from simulation to live.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const read = (dir: string) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => f + fs.readFileSync(path.join(dir, f), "utf8"));
  } catch {
    return [];
  }
};

let cached: string | null = null;
export function promptVersion(): string {
  if (cached) return cached;
  const h = createHash("sha256");
  for (const part of [
    ...read(process.env.PROMPTS_DIR ?? "prompts"),
    ...read("guide"),
    fs.readFileSync(process.env.RULES_FILE ?? "config/rules.json", "utf8"),
    `${config.researchModel}/${config.researchEffort}/${config.verifyModel}/${config.verifyEffort}/${config.minVerifyScore}`,
  ])
    h.update(part);
  return (cached = h.digest("hex").slice(0, 8));
}
