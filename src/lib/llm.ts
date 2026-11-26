/**
 * Thin OpenAI wrapper: a research request with the hosted web_search tool (OpenAI runs the search
 * and browsing server-side), structured extraction with Zod, and spend tracking against the daily
 * budget. Exposes the same surface the rest of the agent expects (runWithWebTools, extract,
 * assertBudget, BudgetExceeded), so swapping the provider here leaves the pipeline untouched.
 */
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { config, type Effort } from "../config.js";
import * as state from "./state.js";

/** The key env name the user pasted is OPEN_AI_KEY; accept the standard name too. */
const apiKey = () => process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY || "";
let _client: OpenAI | null = null;
const client = () => (_client ??= new OpenAI({ apiKey: apiKey() }));

/** USD per 1M tokens [input, output]. Reasoning tokens are billed as output. Approximate ids fall
 *  back to the research model's price; it only drives the local daily-budget guard, not billing. */
const PRICES: Record<string, [number, number]> = {
  "gpt-5.6-sol": [4, 20],
  "gpt-6.2-sol": [2, 10],
  "gpt-6.1-sol": [2, 10],
  "gpt-6-sol": [2, 10],
  "gpt-6.2-astra": [8, 40],
  "gpt-6-astra": [10, 50],
  "gpt-5.5": [4, 20],
  "gpt-5.5-pro": [15, 120],
  "gpt-5.4-mini": [0.25, 2],
  "gpt-4o": [2.5, 10],
};
const DEFAULT_PRICE: [number, number] = [4, 20];
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 web_search tool calls

/** OpenAI reasoning effort is minimal|low|medium|high; our scale's xhigh/max map to high. */
const reasoningEffort = (e: Effort): "low" | "medium" | "high" => (e === "low" || e === "medium" ? e : "high");

interface OAUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

function priceFor(model: string): [number, number] {
  if (PRICES[model]) return PRICES[model]!;
  const base = model.replace(/-20\d\d-\d\d-\d\d$/, ""); // drop a dated snapshot suffix
  return PRICES[base] ?? DEFAULT_PRICE;
}

function recordCost(model: string, usage: OAUsage | undefined, webSearches = 0): number {
  const [pin, pout] = priceFor(model);
  const input = usage?.input_tokens ?? 0; // cached tokens are included here; we don't discount them
  const output = usage?.output_tokens ?? 0;
  const usd = (input * pin + output * pout) / 1e6 + webSearches * WEB_SEARCH_USD;
  state.addSpend(usd);
  return usd;
}

export class BudgetExceeded extends Error {}

export function assertBudget(): void {
  if (state.spentToday() >= config.dailyBudgetUsd) {
    throw new BudgetExceeded(`Daily budget of $${config.dailyBudgetUsd} reached ($${state.spentToday().toFixed(2)} spent)`);
  }
}

export interface ToolRunOptions {
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  webSearchUses?: number;
  webFetchUses?: number;
  /** Restrict browsing to these domains (e.g. the candidate's sources during verification). */
  fetchDomains?: string[];
  maxTurns?: number;
}

/** Runs one research-style request with the hosted web_search tool. OpenAI loops the tool
 *  server-side, so the final response already contains the written answer. Returns all text. */
export async function runWithWebTools(o: ToolRunOptions): Promise<{ text: string; usd: number }> {
  assertBudget();
  const wantsWeb = !!(o.webSearchUses || o.webFetchUses);
  const tools: OpenAI.Responses.Tool[] = [];
  if (wantsWeb) {
    const web: Record<string, unknown> = { type: "web_search" };
    if (o.fetchDomains?.length) web.filters = { allowed_domains: o.fetchDomains };
    tools.push(web as unknown as OpenAI.Responses.Tool);
  }

  const res = await client().responses.create({
    model: o.model,
    instructions: o.system,
    input: o.prompt,
    reasoning: { effort: reasoningEffort(o.effort) },
    max_output_tokens: 32_000,
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
  });

  const webCalls = (res.output ?? []).filter((b) => (b as { type?: string }).type === "web_search_call").length;
  const usd = recordCost(res.model ?? o.model, res.usage as OAUsage | undefined, webCalls);

  if (res.status === "incomplete" && res.incomplete_details?.reason === "content_filter") {
    throw new Error("Model declined: content_filter");
  }
  return { text: (res.output_text ?? "").trim(), usd };
}

/** Turns free text into a validated object. No tools, so it's cheap. */
export async function extract<T extends z.ZodType>(
  schema: T,
  prompt: string,
  model: string,
  effort: Effort = "low",
): Promise<z.infer<T>> {
  assertBudget();
  const res = await client().responses.parse({
    model,
    input: prompt,
    reasoning: { effort: reasoningEffort(effort) },
    max_output_tokens: 16_000,
    text: { format: zodTextFormat(schema, "result") },
  });
  recordCost(res.model ?? model, res.usage as OAUsage | undefined);
  if (res.status === "incomplete" && res.incomplete_details?.reason === "content_filter") {
    throw new Error("Model declined: content_filter");
  }
  const parsed = res.output_parsed;
  if (parsed == null) throw new Error("Structured output did not parse");
  return parsed as z.infer<T>;
}
