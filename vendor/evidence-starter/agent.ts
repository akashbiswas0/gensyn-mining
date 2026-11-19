// VENDORED from github.com/gensyn-ai/gensyn-delphi-sdk/blob/14d706f5c674c7e4fbaf0237bdbeae7894faaea0/examples/evidence-starter/agent.ts
// Do not edit: re-run `npm run sync-starter`. Our research plugs in via src/starter-bridge.ts.
// Starter agent for the evidence competition: reads /markets.json of the competition site,
// picks open markets with YES odds between 20% and 80%, submits 1 dated fact with a source,
// and polls the result. It accepts the evidence terms only when you set ACCEPT_TERMS=<version>. Run: see README.md in this folder.
import { pathToFileURL } from "node:url";
import { EvidenceClient, type Submission } from "@gensyn-ai/gensyn-delphi-sdk";

/** The fields of a `/markets.json` entry this agent reads (the export has more). */
export interface MarketCard {
  address: string;
  question: string;
  status: string;
  odds: { yes: number; no: number };
  evidenceCutoffAt: string;
  dataSources: string[];
}

export interface Fact {
  /** The date the fact is true on, e.g. `2026-11-16`. */
  date: string;
  text: string;
  /** A link to the source of the fact. */
  source: string;
}

/** YES probability in 0..1. Accepts odds as a fraction or as a percent. */
export const yesProbability = (m: MarketCard): number => (m.odds.yes > 1 ? m.odds.yes / 100 : m.odds.yes);

/** Open markets, before their evidence cutoff, with YES odds in the 20% to 80% band. */
export const pickMarkets = (markets: MarketCard[], now = Date.now()): MarketCard[] =>
  markets.filter((m) => {
    const p = yesProbability(m);
    return m.status === "open" && Date.parse(m.evidenceCutoffAt) > now && p >= 0.2 && p <= 0.8;
  });

/**
 * Replace this with your research. The default reads 1 fact from the environment
 * (`FACT`, `FACT_SOURCE`, optional `FACT_DATE`, default today) and uses it only
 * for the market at `MARKET_ADDRESS`. A fact is never sent to a market it was not chosen for.
 */
export async function findFact(market: MarketCard, env = process.env): Promise<Fact | null> {
  if (!env.FACT || !env.FACT_SOURCE || !env.MARKET_ADDRESS) return null;
  if (env.MARKET_ADDRESS.toLowerCase() !== market.address.toLowerCase()) return null;
  return { date: env.FACT_DATE ?? new Date().toISOString().slice(0, 10), text: env.FACT, source: env.FACT_SOURCE };
}

export async function run(opts: {
  siteUrl: string;
  client: EvidenceClient;
  /** The terms version the person who runs the agent accepts (`ACCEPT_TERMS`). Without it the agent never accepts terms. */
  acceptTerms?: string;
  findFact?: (m: MarketCard) => Promise<Fact | null>;
  fetch?: typeof fetch;
  log?: (...a: unknown[]) => void;
}): Promise<Submission | null> {
  const { client, log = console.log, findFact: find = (m) => findFact(m) } = opts;
  const res = await (opts.fetch ?? fetch)(new URL("/markets.json", opts.siteUrl).toString());
  if (!res.ok) throw new Error(`GET /markets.json failed: ${res.status}`);
  const body = (await res.json()) as MarketCard[] | { markets: MarketCard[] };
  const picked = pickMarkets(Array.isArray(body) ? body : body.markets);
  log(`${picked.length} market(s) between 20% and 80%`);
  let termsOk = false;

  for (const m of picked) {
    const fact = await find(m);
    if (!fact) continue;
    if (!termsOk) {
      // Read the terms once; accept them only for the exact version the person who runs the agent chose.
      const { data: terms } = await client.getTerms();
      if (terms.acceptedAt === null) {
        if (opts.acceptTerms !== terms.version) {
          log(`would submit to ${m.address} (${m.question}): read the evidence terms at ${terms.url}, then set ACCEPT_TERMS=${terms.version} to accept them and submit`);
          return null;
        }
        await client.acceptTerms(terms.version);
        log(`accepted the evidence terms ${terms.version}`);
      }
      termsOk = true;
    }
    const { data: entry } = await client.getEntryState(m.address);
    if (!entry.canSubmit) {
      log(`skip ${m.address}: ${entry.reason ?? "cannot submit"}`);
      continue;
    }
    const { data } = await client.submitEvidence({
      note: `As of ${fact.date}: ${fact.text}`,
      links: [fact.source],
      marketAddress: m.address,
    });
    log(`submitted ${data.id} to ${m.address} (${data.status})`);
    // A saved rejection comes back at once; anything else is polled until it is final.
    const result = data.status === "rejected" ? data : (await client.waitForSubmission(data.id)).data;
    log(`result: ${result.status}`, JSON.stringify(result.markets));
    return result;
  }
  const addr = opts.findFact ? undefined : process.env.MARKET_ADDRESS;
  if (addr && !picked.some((m) => m.address.toLowerCase() === addr.toLowerCase())) {
    log(`MARKET_ADDRESS ${addr} is not among the picked markets (closed, past cutoff, or outside 20%–80%)`);
  } else {
    log("no fact to submit: set FACT, FACT_SOURCE and MARKET_ADDRESS, or replace findFact()");
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const need = (k: string) => process.env[k] || (console.error(`${k} is required`), process.exit(1));
  run({
    siteUrl: need("COMPETITION_SITE_URL"),
    client: new EvidenceClient({
      baseUrl: need("DELPHI_API_URL"),
      // DELPHI_API_ACCESS_KEY is the SDK-wide name (DelphiClient); DELPHI_API_KEY still works.
      apiKey: process.env.DELPHI_API_ACCESS_KEY || process.env.DELPHI_API_KEY || need("DELPHI_API_ACCESS_KEY"),
      agentId: process.env.AGENT_ID ?? "evidence-starter",
      agentHarness: "gensyn-delphi-sdk/examples/evidence-starter",
      agentModel: process.env.AGENT_MODEL,
    }),
    acceptTerms: process.env.ACCEPT_TERMS || undefined,
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
