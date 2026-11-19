/**
 * npm run sync-starter
 *
 * Pulls the official evidence starter agent from the SDK repo (examples/evidence-starter) into
 * vendor/evidence-starter/, rewriting its SDK import to the npm package so it runs here.
 * Run it again on 23 Nov (and whenever the organisers update it), then `git diff vendor/` shows
 * what changed. Also reports whether a newer SDK is published.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "gensyn-ai/gensyn-delphi-sdk";
const DIR = "examples/evidence-starter";
const OUT = "vendor/evidence-starter";
const FILES = ["agent.ts", "README.md"];

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "evidence-agent-sync" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const commits = JSON.parse(await get(`https://api.github.com/repos/${REPO}/commits?path=${DIR}&per_page=1`)) as {
    sha: string;
    commit: { committer: { date: string } };
  }[];
  const sha = commits[0]?.sha ?? "main";

  fs.mkdirSync(OUT, { recursive: true });
  for (const f of FILES) {
    let text = await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${DIR}/${f}`);
    if (f.endsWith(".ts")) {
      // The example imports the SDK from the repo's src/; here it comes from node_modules.
      text = text.replace(/from\s+["'](\.\.\/)+src\/index\.js["']/g, 'from "@gensyn-ai/gensyn-delphi-sdk"');
      text = `// VENDORED from github.com/${REPO}/blob/${sha}/${DIR}/${f}\n// Do not edit: re-run \`npm run sync-starter\`. Our research plugs in via src/starter-bridge.ts.\n${text}`;
    }
    fs.writeFileSync(path.join(OUT, f), text);
  }

  const installed = JSON.parse(fs.readFileSync("node_modules/@gensyn-ai/gensyn-delphi-sdk/package.json", "utf8")).version;
  let latest = "?";
  try {
    latest = execSync("npm view @gensyn-ai/gensyn-delphi-sdk version", { encoding: "utf8" }).trim();
  } catch { /* offline */ }
  fs.writeFileSync(
    path.join(OUT, "SOURCE.json"),
    JSON.stringify({ repo: REPO, path: DIR, sha, committedAt: commits[0]?.commit.committer.date, syncedAt: new Date().toISOString(), sdkInstalled: installed }, null, 2) + "\n",
  );

  console.log(`Synced ${DIR} @ ${sha.slice(0, 7)} (${commits[0]?.commit.committer.date ?? "?"}) → ${OUT}/`);
  console.log(`SDK installed ${installed}, latest ${latest}${latest !== "?" && latest !== installed ? "  ← run: npm install @gensyn-ai/gensyn-delphi-sdk@latest" : ""}`);
  console.log("Next: git diff vendor/  ·  npm run typecheck  ·  npm run starter:offline");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
