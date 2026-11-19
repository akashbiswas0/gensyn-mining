/** Research and fact-check with Claude + server-side web search/fetch. Prompts: prompts/*.md. */
import { z } from "zod";
import { config, rules } from "../config.js";
import { extract, runWithWebTools } from "../lib/llm.js";
import { info } from "../lib/log.js";
import { noteShape, textBudget } from "../lib/note.js";
import { prompt } from "../lib/prompts.js";
import type { MarketState } from "../lib/state.js";
import type { Candidate, Market, ResearchResult, Stages, Verification } from "../types.js";
import { describeMarket } from "./markets.js";

const today = () => new Date().toISOString().slice(0, 10);
const MAX_CANDIDATES = 4;

const CandidateSchema = z.object({
  claim: z.string().describe("One self-contained factual sentence, with the key date in it"),
  eventDate: z.string().describe("ISO date the event happened or is scheduled"),
  publishedDate: z.string().describe("ISO date the main source was published; empty if unknown"),
  direction: z.enum(["yes", "no"]).describe("Which outcome this fact makes more likely"),
  sourceUrls: z.array(z.string()).describe("Main source first"),
  quote: z.string().describe("Short verbatim excerpt from the main source supporting the claim"),
  whyNew: z.string(),
  whyItMatters: z.string(),
  expectedImpact: z.enum(["low", "medium", "high"]),
  confidence: z.number().describe("0-1"),
});

const ResearchSchema = z.object({
  candidates: z.array(CandidateSchema),
  contraryEvidence: z.string().describe("Strong evidence for the opposite of the committed side, if any; else empty"),
  summary: z.string(),
});

const VerifySchema = z.object({
  supported: z.boolean(),
  dateConfirmed: z.boolean(),
  directionCorrect: z.boolean(),
  novelty: z.number().describe("0-1"),
  relevance: z.number().describe("0-1"),
  publicSource: z.boolean().describe("Public, no login or paywall, allowed to read under the site's terms"),
  noPrivatePersonalData: z.boolean().describe("No personal data about private individuals"),
  notConfidential: z.boolean().describe("Not confidential or leaked material"),
  issues: z.array(z.string()),
  factDate: z.string().describe("ISO date the fact is true on"),
  factText: z.string().describe("The fact text to submit, without the date prefix"),
});

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const isHttpUrl = (u: string) => { try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; } };

async function research(m: Market, s: MarketState): Promise<ResearchResult> {
  const already = [...s.submissions.map((x) => `- SUBMITTED: ${x.note}`), ...s.seenClaims.map((c) => `- ALREADY FOUND: ${c}`)];
  const side = s.side?.toUpperCase();
  const sideRule = side && rules.oneSidePerMarket
    ? `We have already submitted evidence pointing to ${side} on this market. Evidence for both sides cancels out, so only report candidates pointing to ${side}. Describe strong evidence for the other side under "contrary evidence" instead of listing it.`
    : `We have not taken a side on this market yet. Report the strongest new facts whichever way they point.`;

  const run = await runWithWebTools({
    model: config.researchModel,
    effort: config.researchEffort,
    system: prompt("research.system"),
    prompt: prompt("research.user", {
      today: today(),
      market: describeMarket(m),
      sideRule,
      already: already.length ? `Do not repeat any of these:\n${already.join("\n")}\n` : "",
      maxCandidates: MAX_CANDIDATES,
    }),
    webSearchUses: 8,
    webFetchUses: 8,
  });
  info(`research call: $${run.usd.toFixed(2)}`);

  const parsed = await extract(ResearchSchema, prompt("research.extract", { report: run.text }), config.researchModel);
  return {
    candidates: parsed.candidates
      .map((c) => ({ ...c, sourceUrls: c.sourceUrls.filter(isHttpUrl).slice(0, rules.maxLinksPerSubmission), confidence: clamp01(c.confidence) }))
      .filter((c) => c.sourceUrls.length > 0)
      .slice(0, MAX_CANDIDATES),
    contraryEvidence: parsed.contraryEvidence,
    summary: parsed.summary,
  };
}

async function verify(m: Market, c: Candidate): Promise<Verification> {
  const run = await runWithWebTools({
    model: config.verifyModel,
    effort: config.verifyEffort,
    system: prompt("verify.system"),
    prompt: prompt("verify.user", {
      today: today(),
      market: describeMarket(m),
      direction: c.direction.toUpperCase(),
      claim: c.claim,
      eventDate: c.eventDate,
      publishedDate: c.publishedDate || "unknown",
      sources: c.sourceUrls.join(" , "),
      quote: c.quote,
      whyNew: c.whyNew,
      noteShape: noteShape(),
      textMaxChars: textBudget(),
    }),
    webSearchUses: 2,
    webFetchUses: 4,
    fetchDomains: [...new Set(c.sourceUrls.map((u) => new URL(u).hostname))],
  });
  info(`fact-check call: $${run.usd.toFixed(2)}`);

  const v = await extract(VerifySchema, prompt("verify.extract", { report: run.text }), config.verifyModel);
  const novelty = clamp01(v.novelty);
  const relevance = clamp01(v.relevance);
  // Pilot Terms, "Fair play": any policy failure blocks the fact outright, whatever its value.
  const policy = [
    !v.publicSource && "source is not public / needs login or paywall / site terms",
    !v.noPrivatePersonalData && "contains personal data about a private individual",
    !v.notConfidential && "confidential or leaked material",
  ].filter((x): x is string => Boolean(x));
  const ok = v.supported && v.dateConfirmed && v.directionCorrect && policy.length === 0;
  return {
    ...v,
    novelty,
    relevance,
    score: ok ? 0.5 * novelty + 0.5 * relevance : 0,
    issues: [...policy.map((x) => `POLICY: ${x}`), ...(v.directionCorrect ? [] : ["direction does not hold"]), ...v.issues],
    factDate: v.factDate || c.eventDate,
  };
}

export const claudeStages: Stages = { research, verify };
