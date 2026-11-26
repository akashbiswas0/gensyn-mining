/**
 * npm run preflight: can this agent compete right now? Follows the official entry order
 * (https://competition.delphi.fyi/skill.md): key → GET /v1/limits → GET /v1/terms → markets.
 * Read-only: submits nothing, accepts nothing, spends nothing, never prints a key.
 */
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { competitionPhase, config, rules } from "./config.js";
import { changedDocs } from "./lib/docs-check.js";
import { readLimits } from "./lib/evidence.js";
import { loadMarkets } from "./stages/markets.js";
import { rankMarkets } from "./stages/picker.js";

let blockers = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const warn = (m: string) => console.log(`  note  ${m}`);
const bad = (m: string) => { blockers++; console.log(`  STOP  ${m}`); };

async function main(): Promise<void> {
  if (config.sim || config.marketSource !== "competition") throw new Error("preflight checks the live competition: run it without --sim or --markets");
  console.log("Setup");
  const phase = competitionPhase();
  (phase === "open" ? ok : bad)(`competition window ${rules.competitionWindow.startsAt} to ${rules.competitionWindow.endsAt}: ${phase}`);
  (new URL(config.siteUrl).hostname === "competition.delphi.fyi" ? ok : bad)(`competition site ${config.siteUrl}`);
  (config.agentId !== "my-evidence-agent" ? ok : bad)(config.agentId !== "my-evidence-agent" ? `agent name ${config.agentId} · ${config.agentHarness} · ${config.agentModel}` : "DELPHI_AGENT_ID is not set (the name results show under)");
  const researchKey = process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY;
  (researchKey ? ok : bad)(researchKey ? `OpenAI research key set (model ${config.researchModel})` : "OPEN_AI_KEY is empty: the agent cannot research");
  if (!config.wallet) warn("DELPHI_WALLET_ADDRESS is not set: needed only to send feedback (the wallet shown as \"Issued to wallet\" on the API keys page)");

  console.log("Official docs");
  const { changed, unread } = await changedDocs();
  if (changed.length) bad(`changed since our last sync: ${changed.join(", ")} → npm run sync-official, review the diff`);
  else ok(unread.length ? `unchanged, but could not read ${unread.join(", ")}` : "our copies match");

  console.log("Account");
  if (!config.apiKey) bad("DELPHI_API_ACCESS_KEY is empty: create a Mainnet key at https://api-access.delphi.fyi, signed in the same way you sign in to Delphi");
  else {
    const ev = new EvidenceClient({ baseUrl: config.apiUrl, apiKey: config.apiKey, agentId: config.agentId.slice(0, 64), agentHarness: config.agentHarness.slice(0, 64), agentModel: config.agentModel.slice(0, 64) });
    try {
      const l = await readLimits(ev);
      ok(`GET /v1/limits: ${l.submitsLeftThisHour} submissions left until ${l.hourEndsAt}; daily reward cap left ${l.dailyCapLeft}`);
      const { data: t } = await ev.getTerms();
      if (t.acceptedAt) ok(`terms ${t.version} accepted ${t.acceptedAt}`);
      else bad(`terms ${t.version} not accepted. Read ${t.url} and, only if you agree, set ACCEPT_TERMS=${t.version} in .env`);
    } catch (e) {
      bad((e as Error).message);
    }
  }

  console.log("Markets");
  try {
    const markets = await loadMarkets();
    if (!markets.length) bad("the market list is empty: no competition market is open yet, try again later");
    else {
      const { ranked } = rankMarkets(markets);
      ok(`${markets.length} listed, ${ranked.length} eligible (open, ${rules.marketFilter.minYes * 100}-${rules.marketFilter.maxYes * 100}% Yes, before the cutoff), ${markets.filter((m) => m.rewardPot !== null && m.description && m.evidenceCutoff && m.dataSources.length).length} with pot, criteria, cutoff and sources`);
      for (const r of ranked.slice(0, 5)) console.log(`        ${r.score.toFixed(2)}  ${r.market.question.slice(0, 88)}  (${r.why})`);
    }
  } catch (e) {
    bad((e as Error).message);
  }
  console.log(blockers ? `\n${blockers} thing(s) to fix before the agent can compete.` : "\nReady to compete.");
  process.exitCode = blockers ? 1 : 0;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
