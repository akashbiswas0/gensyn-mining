/**
 * The real SDK EvidenceClient, configured like the official starter (DELPHI_API_URL,
 * DELPHI_API_ACCESS_KEY, X-Agent-* headers). With --sim the same client talks to the local
 * simulator (src/sim/server.ts) through its `fetch` option. Nothing else differs.
 *
 * Also: the resilience the live API needs (and the simulator's chaos mode tests):
 *   call()          retries transient failures (5xx, call-rate 429, network) honouring Retry-After
 *   submit()        one Idempotency-Key across retries, so a retried POST can't double-submit
 *   awaitFinal()    polls to a terminal status and retries `failed` submissions that allow it
 */
import { randomUUID } from "node:crypto";
import { EvidenceApiError, EvidenceClient, TermsNotAcceptedError, type Submission, type SubmitEvidenceParams } from "@gensyn-ai/gensyn-delphi-sdk";
import { config, requireLive } from "../config.js";
import { simFetch } from "../sim/server.js";
import { info } from "./log.js";

export function makeEvidenceClient(): EvidenceClient {
  const headers = {
    agentId: config.agentId.slice(0, 64),
    agentHarness: config.agentHarness.slice(0, 64),
    agentModel: config.agentModel.slice(0, 64),
  };
  if (config.sim) return new EvidenceClient({ baseUrl: "https://simulator.local/v1", apiKey: "sim", fetch: simFetch, ...headers });
  requireLive();
  return new EvidenceClient({ baseUrl: config.apiUrl, apiKey: config.apiKey, ...headers });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Network errors (fetch throws TypeError) and retryable API errors are transient. */
export function isTransient(e: unknown): boolean {
  if (e instanceof TermsNotAcceptedError) return false;
  if (e instanceof EvidenceApiError) return e.retryable && !(e.code === "rate_limited" && e.limit && e.limit !== "call_rate");
  return e instanceof TypeError;
}

export async function call<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isTransient(e)) throw e;
      const wait = e instanceof EvidenceApiError && e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : Math.min(30_000, 500 * 2 ** i);
      info(`${what}: transient error (${e instanceof EvidenceApiError ? e.code : (e as Error).message}); retry ${i}/${attempts - 1} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

export async function submit(ev: EvidenceClient, p: Omit<SubmitEvidenceParams, "idempotencyKey">) {
  const idempotencyKey = randomUUID(); // same key on every retry: the server returns the original, never a duplicate
  return call("submit", () => ev.submitEvidence({ ...p, idempotencyKey }));
}

export async function awaitFinal(ev: EvidenceClient, sub: Submission, maxRetries = 3): Promise<Submission> {
  let current = sub;
  for (let retries = 0; ; ) {
    if (current.status === "queued" || current.status === "judging") {
      current = (await call("poll", () => ev.waitForSubmission(current.id, { timeoutMs: 10 * 60_000 }))).data;
    }
    if (current.status === "failed" && current.canRetry && retries < maxRetries) {
      retries++;
      const wait = current.retryAt ? Math.max(0, Date.parse(current.retryAt) - Date.now()) : 2000;
      info(`submission ${current.id} failed (${current.code ?? "?"}); retrying in ${Math.ceil(wait / 1000)}s (${retries}/${maxRetries})`);
      await sleep(wait);
      current = (await call("retry", () => ev.retrySubmission(current.id))).data;
      continue;
    }
    return current;
  }
}

/** Same policy as the starter: never accept terms unless ACCEPT_TERMS names the current version. */
export async function ensureTerms(ev: EvidenceClient): Promise<void> {
  const { data: terms } = await call("terms", () => ev.getTerms());
  if (terms.acceptedAt) return;
  if (config.acceptTerms === terms.version) {
    await call("accept terms", () => ev.acceptTerms(terms.version));
    info(`Accepted evidence terms ${terms.version}`);
    return;
  }
  throw new TermsNotAcceptedError(
    { version: terms.version, url: terms.url },
    403,
    "terms_not_accepted",
    `Read the evidence terms at ${terms.url}, then set ACCEPT_TERMS=${terms.version} in .env`,
    false,
    null,
    null,
  );
}

/**
 * The same client with our resilience layered on every call, for code we don't control (the
 * official starter): transient failures are retried, submits keep one Idempotency-Key across
 * retries, and polling retries `failed` judgements that allow it.
 */
export function resilient(ev: EvidenceClient): EvidenceClient {
  return new Proxy(ev, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      if (prop === "submitEvidence") return (p: SubmitEvidenceParams) => submit(target, p);
      if (prop === "waitForSubmission")
        return async (id: string) => {
          const { data, meta } = await call("poll", () => target.getSubmission(id));
          return { data: await awaitFinal(target, data), meta };
        };
      return (...a: unknown[]) => call(String(prop), () => (v as (...x: unknown[]) => Promise<unknown>).apply(target, a));
    },
  });
}
