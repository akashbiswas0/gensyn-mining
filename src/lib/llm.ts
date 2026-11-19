/**
 * Thin Claude wrapper: a server-tool loop (web search / web fetch run on Anthropic's side),
 * structured extraction with Zod, refusal fallbacks, and spend tracking against the daily budget.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config, type Effort } from "../config.js";
import * as state from "./state.js";

let _client: Anthropic | null = null;
const client = () => (_client ??= new Anthropic());

/** On a safety decline the API re-runs the request on a fallback model inside the same call. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** USD per 1M tokens [input, output]. Cache reads are billed at the input rate here (conservative). */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-2": [8, 40],
};
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

type Usage = Anthropic.Beta.Messages.BetaUsage;

function recordCost(model: string, usage: Usage): number {
  const [pin, pout] = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const usd =
    (input * pin + usage.output_tokens * pout) / 1e6 +
    (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
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
  /** Restrict web fetch to these domains (e.g. the candidate's sources during verification). */
  fetchDomains?: string[];
  maxTurns?: number;
}

/** Runs one research-style request with server-side web tools, resuming paused turns. Returns all text. */
export async function runWithWebTools(o: ToolRunOptions): Promise<{ text: string; usd: number }> {
  assertBudget();
  const tools: Anthropic.Beta.Messages.BetaToolUnion[] = [];
  if (o.webSearchUses) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: o.webSearchUses });
  if (o.webFetchUses) {
    tools.push({
      type: "web_fetch_20260209",
      name: "web_fetch",
      max_uses: o.webFetchUses,
      max_content_tokens: 20_000,
      ...(o.fetchDomains?.length ? { allowed_domains: o.fetchDomains } : {}),
    });
  }

  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: o.prompt }];
  const texts: string[] = [];
  let usd = 0;

  for (let turn = 0; turn < (o.maxTurns ?? 6); turn++) {
    const msg = await client()
      .beta.messages.stream({
        model: o.model,
        max_tokens: 64_000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: o.effort },
        system: o.system,
        tools,
        messages,
      })
      .finalMessage();

    usd += recordCost(msg.model, msg.usage);
    for (const b of msg.content) if (b.type === "text") texts.push(b.text);

    if (msg.stop_reason === "refusal") throw new Error(`Model declined: ${msg.stop_details?.category ?? "unknown"}`);
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    break; // end_turn / max_tokens: take what we have
  }
  return { text: texts.join("\n").trim(), usd };
}

/** Turns free text into a validated object. No tools, so it's cheap. */
export async function extract<T extends z.ZodType>(
  schema: T,
  prompt: string,
  model: string,
  effort: Effort = "low",
): Promise<z.infer<T>> {
  assertBudget();
  const res = await client().beta.messages.parse({
    model,
    max_tokens: 16_000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content: prompt }],
  });
  recordCost(res.model, res.usage);
  if (res.stop_reason === "refusal") throw new Error(`Model declined: ${res.stop_details?.category ?? "unknown"}`);
  if (!res.parsed_output) throw new Error("Structured output did not parse");
  return res.parsed_output as z.infer<T>;
}
