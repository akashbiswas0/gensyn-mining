/**
 * The official guide says: read the rules again at the start of every session, because rules and
 * limits can change during the competition. At startup we compare the live official
 * reference/competition.md with our synced copy (vendor/delphi-skills) and warn loudly if it moved.
 * Best effort: a network problem never blocks the agent.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { event, info } from "./log.js";

const LIVE = "https://raw.githubusercontent.com/gensyn-ai/gensyn-delphi-skills/main/reference/competition.md";
const LOCAL = "vendor/delphi-skills/reference/competition.md";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function checkOfficialDocs(): Promise<void> {
  try {
    const res = await fetch(LIVE, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const live = await res.text();
    const local = fs.existsSync(LOCAL) ? fs.readFileSync(LOCAL, "utf8") : "";
    if (hash(live) === hash(local)) {
      info("official rules: up to date");
      return;
    }
    const changelog = live.split(/^## Changelog/m)[1]?.trim().split("\n").slice(-3).join(" ") ?? "";
    event("ERROR", `Official competition rules changed upstream. Run npm run sync-official, review git diff, re-run tests. Latest changelog: ${changelog.slice(0, 300)}`);
  } catch {
    /* offline or GitHub unavailable: not a reason to stop */
  }
}
