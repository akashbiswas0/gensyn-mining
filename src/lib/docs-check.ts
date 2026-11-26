/**
 * The official guide says: read the rules again at the start of every session, because rules and
 * limits can change during the competition. At startup we compare every live official document we
 * follow with our synced copy and warn loudly if one moved. Best effort: a network problem never
 * blocks the agent.
 */
import fs from "node:fs";
import { event, info } from "./log.js";

const RAW = "https://raw.githubusercontent.com/gensyn-ai/gensyn-delphi-skills/main/";
const DOCS: [live: string, local: string][] = [
  ...["reference/competition.md", "reference/evidence.md", "reference/evidence-api.md"].map((d): [string, string] => [RAW + d, `vendor/delphi-skills/${d}`]),
  ["https://competition.delphi.fyi/skill.md", "vendor/competition-site/skill.md"],
];

/** Names of the official documents that differ from our copy. */
export async function changedDocs(): Promise<{ changed: string[]; unread: string[] }> {
  const changed: string[] = [];
  const unread: string[] = [];
  await Promise.all(DOCS.map(async ([live, local]) => {
    const name = live.split("/").at(-1)!;
    try {
      const res = await fetch(live, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(String(res.status));
      if ((await res.text()) !== (fs.existsSync(local) ? fs.readFileSync(local, "utf8") : "")) changed.push(name);
    } catch {
      unread.push(name);
    }
  }));
  return { changed, unread };
}

export async function checkOfficialDocs(): Promise<void> {
  const { changed, unread } = await changedDocs();
  if (unread.length) info(`official docs not readable right now: ${unread.join(", ")}`);
  if (changed.length) event("ERROR", `Official docs changed upstream: ${changed.join(", ")}. Run npm run sync-official, review git diff vendor/ guide/, re-run the tests.`);
  else if (!unread.length) info("official docs: up to date");
}
