/**
 * Market sources (config.marketSource), all producing starter-shaped cards:
 *   competition  GET <COMPETITION_SITE_URL>/markets.json, exactly as the official starter does
 *   delphi       real live Delphi Yes/No markets via the SDK's DelphiClient.listMarkets
 *   fixture      fixtures/markets.sample.json
 * Cards are then normalised into `Market`. Starter fields (address, question, status, odds, evidenceCutoffAt,
 * dataSources) are read first; other likely names are fallbacks. If 23 Nov brings new fields
 * (e.g. a reward pot or description), `npm run inspect-markets` lists them; add them to KNOWN
 * and to `normalise()`.
 */
import fs from "node:fs";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";
import { config } from "../config.js";
import type { Market, MarketCard } from "../types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) {
    let v: unknown = o;
    for (const p of k.split(".")) v = isObj(v) ? v[p] : undefined;
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
const toDate = (v: unknown): Date | null => {
  if (v === undefined) return null;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const toNum = (v: unknown): number | null => (v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** Top-level fields normalise() understands. Anything else is reported by inspect-markets. */
export const KNOWN = new Set([
  "address", "marketAddress", "id", "question", "title", "status", "odds", "probYes", "evidenceCutoffAt",
  "evidenceCutoff", "dataSources", "description", "resolutionCriteria", "rules", "outcomes", "closesAt",
  "closeTime", "resolvesAt", "rewardPot", "judgementPot", "judgementPotRemainingBaseUnits", "category",
  "marketUrl", "url", "metadata",
]);

export function normalise(card: MarketCard | Obj): Market | null {
  const m = card as unknown as Obj;
  const address = pick(m, "address", "marketAddress", "id");
  const question = pick(m, "question", "title", "metadata.question");
  if (typeof address !== "string" || typeof question !== "string") return null;

  // Starter: odds.yes as a fraction or a percent.
  let probYes = toNum(pick(m, "odds.yes", "probYes"));
  if (probYes !== null && probYes > 1) probYes /= 100;

  let pot = toNum(pick(m, "rewardPot", "judgementPot"));
  const potBase = toNum(pick(m, "judgementPotRemainingBaseUnits"));
  if (pot === null && potBase !== null) pot = potBase / 1e6;

  const ds = pick(m, "dataSources");
  return {
    address,
    question,
    status: String(pick(m, "status") ?? "open"),
    description: String(pick(m, "description", "resolutionCriteria", "rules", "metadata.description") ?? ""),
    outcomes: ((pick(m, "outcomes", "metadata.outcomes") as unknown[] | undefined) ?? ["Yes", "No"]).map(String),
    probYes,
    evidenceCutoff: toDate(pick(m, "evidenceCutoffAt", "evidenceCutoff")),
    closesAt: toDate(pick(m, "closesAt", "closeTime", "resolvesAt")),
    rewardPot: pot,
    dataSources: Array.isArray(ds) ? ds.map(String) : [],
    category: (pick(m, "category") as string | undefined) ?? null,
    url: (pick(m, "marketUrl", "url") as string | undefined) ?? null,
    raw: m,
  };
}

const unwrap = (body: unknown, from: string): Obj[] => {
  const list = Array.isArray(body) ? body : isObj(body) ? body.markets : undefined; // starter: array or { markets }
  if (!Array.isArray(list)) throw new Error(`${from}: expected an array or { markets: [...] }`);
  return list.filter(isObj);
};

let _delphi: DelphiClient | null = null;
/** Read-only Delphi REST client (no wallet needed) for DELPHI_MARKETS_NETWORK, or null without a key. */
export function delphiReader(): DelphiClient | null {
  if (!config.delphiMarketsApiKey) return null;
  return (_delphi ??= new DelphiClient({ network: config.delphiMarketsNetwork, apiKey: config.delphiMarketsApiKey }));
}

/** Real live Delphi markets, reshaped into starter cards. Only Yes/No markets (the competition's kind). */
async function delphiCards(): Promise<Obj[]> {
  const client = delphiReader();
  if (!client) throw new Error("--markets=delphi needs DELPHI_MARKETS_API_KEY (or DELPHI_API_ACCESS_KEY) for the " + config.delphiMarketsNetwork + " Delphi API");
  const { markets } = await client.listMarkets({ status: "open", limit: 100, orderBy: "liquidity", pricesAndImpliedProbabilities: true });
  const cards: Obj[] = [];
  for (const m of markets ?? []) {
    const outcomes = m.metadata?.outcomes ?? [];
    const yes = outcomes.findIndex((o) => o.trim().toLowerCase() === "yes");
    const no = outcomes.findIndex((o) => o.trim().toLowerCase() === "no");
    if (outcomes.length !== 2 || yes < 0 || no < 0 || !m.metadata?.question) continue;
    const p = m.spotImpliedProbabilities;
    cards.push({
      address: m.id,
      question: m.metadata.question,
      status: m.status,
      odds: p ? { yes: p[yes], no: p[no] } : { yes: 0.5, no: 0.5 },
      evidenceCutoffAt: m.settlesAt ?? m.resolvesAt ?? "",
      dataSources: Array.isArray(m.dataSources) ? m.dataSources.map(String) : [],
      description: m.metadata.model?.prompt_context ?? "",
      category: m.category,
      marketUrl: m.marketUrl,
    });
  }
  return cards;
}

/** Cards from the configured source. */
export async function fetchMarketCards(): Promise<Obj[]> {
  if (config.marketSource === "fixture") return unwrap(JSON.parse(fs.readFileSync(config.fixtureMarkets, "utf8")), config.fixtureMarkets);
  if (config.marketSource === "delphi") return delphiCards();
  const url = new URL("/markets.json", config.siteUrl).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return unwrap(await res.json(), url);
}

/**
 * fetch for the competition site, handed to the official starter. For the competition source it is
 * the real fetch; for delphi/fixture it serves /markets.json from that source, so the starter runs
 * unchanged on real Delphi markets before 23 Nov.
 */
export const siteFetch: typeof fetch = async (input, init) => {
  if (config.marketSource === "competition") return fetch(input, init);
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (u.pathname !== "/markets.json") return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(await fetchMarketCards()), { headers: { "Content-Type": "application/json" } });
};

export async function loadMarkets(): Promise<Market[]> {
  const markets = (await fetchMarketCards()).map(normalise).filter((m): m is Market => m !== null);
  if (config.marketSource === "competition") await enrichFromDelphi(markets);
  return markets;
}

const enriched = new Map<string, { description: string; closesAt: Date | null } | null>();
/**
 * If competition markets are also Delphi markets, the Delphi API has the settlement oracle's own
 * context (metadata.model.prompt_context) and the settlement time. Fill them in where
 * /markets.json lacks them. Best effort: no key, a different network, or a 404 just means no extra detail.
 */
async function enrichFromDelphi(markets: Market[]): Promise<void> {
  const client = delphiReader();
  if (!client) return;
  await Promise.all(
    markets.filter((m) => !m.description || !m.closesAt).map(async (m) => {
      if (!enriched.has(m.address)) {
        try {
          const d = await client.getMarket({ id: m.address });
          enriched.set(m.address, { description: d.metadata?.model?.prompt_context ?? "", closesAt: d.settlesAt ? new Date(d.settlesAt) : null });
        } catch {
          enriched.set(m.address, null);
        }
      }
      const e = enriched.get(m.address);
      if (e) {
        m.description ||= e.description;
        m.closesAt ??= e.closesAt;
      }
    }),
  );
}

export function describeMarket(m: Market): string {
  const pct = m.probYes === null ? "unknown" : `${(m.probYes * 100).toFixed(0)}% YES`;
  return [
    `Question: ${m.question}`,
    m.description && `Resolution details: ${m.description}`,
    m.dataSources.length && `Resolves from these data sources: ${m.dataSources.join(", ")}`,
    `Current market odds: ${pct}`,
    m.evidenceCutoff && `Evidence cutoff: ${m.evidenceCutoff.toISOString()}`,
    m.closesAt && `Market closes: ${m.closesAt.toISOString()}`,
    m.category && `Category: ${m.category}`,
  ]
    .filter(Boolean)
    .join("\n");
}
