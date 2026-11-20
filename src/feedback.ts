/**
 * Feedback to Delphi (the five most useful entries win USD 250 each). Official guide:
 * https://feedback.delphi.fyi/ and vendor/delphi-skills/reference/feedback.md.
 *
 *   npm run feedback -- --notes                       show what the agent collected (data/feedback-notes.md)
 *   npm run feedback -- --list                        your entries so far
 *   npm run feedback -- --area api --title "One line" --text "What I tried, what happened, what I expected" \
 *                       [--market 0x…] [--submission <id>]
 *
 * Areas: api, keys, markets, judging, rewards, docs, site, other. To dispute a verdict: --area judging
 * with --market and --submission. One issue per entry; 20 entries per key per UTC day.
 * Needs DELPHI_API_ACCESS_KEY (Mainnet) and DELPHI_WALLET_ADDRESS (the wallet the key was created
 * with). The key goes only to the feedback endpoint and is never printed. Nothing is sent unless
 * you run this with --text yourself.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const AREAS = ["api", "keys", "markets", "judging", "rewards", "docs", "site", "other"];
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (n: string) => process.argv.includes(`--${n}`);
const fail = (m: string): never => { console.error(m); process.exit(1); };

async function main(): Promise<void> {
  if (has("notes")) {
    const f = path.join("data", "feedback-notes.md");
    console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "No notes collected yet.");
    return;
  }
  if (!config.apiKey) fail("DELPHI_API_ACCESS_KEY is not set (a Mainnet key; testnet keys are rejected).");
  const headers: Record<string, string> = {
    "x-api-key": config.apiKey,
    "X-Agent-Id": config.agentId.slice(0, 64),
    "X-Agent-Harness": config.agentHarness.slice(0, 64),
    "X-Agent-Model": config.agentModel.slice(0, 64),
  };
  const base = config.feedbackUrl.replace(/\/+$/, "");

  if (has("list")) {
    const res = await fetch(`${base}/v1/feedback?mine=1`, { headers });
    const body = await res.text();
    if (!res.ok) fail(`List failed (${res.status}): ${body.slice(0, 300)}`);
    console.log(body);
    return;
  }

  const area = arg("area");
  const text = arg("text");
  if (!area || !AREAS.includes(area)) fail(`--area is required, one of: ${AREAS.join(", ")}`);
  if (!text || text.length > 4000) fail("--text is required, 1 to 4,000 characters");
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.wallet)) fail("Set DELPHI_WALLET_ADDRESS in .env to the wallet the API key was created with.");
  const title = arg("title");
  if (title && title.length > 120) fail("--title is at most 120 characters");

  const body: Record<string, string> = { wallet: config.wallet, area: area!, text: text!, topic: arg("topic") ?? "agent-competition-evidence-mining" };
  if (title) body.title = title;
  if (arg("market")) body.marketId = arg("market")!;
  if (arg("submission")) body.submissionId = arg("submission")!;

  const res = await fetch(`${base}/v1/feedback`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const reply = await res.text();
  if (res.status === 403 && reply.includes("wallet_mismatch")) fail("403 wallet_mismatch: DELPHI_WALLET_ADDRESS is not the wallet the key was created with.");
  if (!res.ok) fail(`Feedback not stored (${res.status}): ${reply.slice(0, 300)}`);
  console.log(`Feedback stored: ${reply}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
