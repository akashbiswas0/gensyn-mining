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
import { EvidenceApiError, EvidenceClient, TermsNotAcceptedError, type EvidenceLimits, type EvidenceMeta, type Submission, type SubmitEvidenceParams } from "@gensyn-ai/gensyn-delphi-sdk";
import { competitionPhase, config, requireLive, rules } from "../config.js";
import { simFetch } from "../sim/server.js";
import { event, info } from "./log.js";
import * as state from "./state.js";

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

/** Longest wait we'll sit through inside one call. Longer Retry-After (e.g. the hourly limit,
 *  which the API marks retryable with Retry-After up to ~20 min) ends the cycle instead. */
const MAX_INLINE_WAIT_S = 60;

/** The account can't use the evidence API at all: a person must act (official: "stop and tell me"). */
export class AccessError extends Error {}

/**
 * GET /v1/limits: the official entry check, and what the account has left. Read it before each
 * batch (the hourly limit can change). 401 and 404 here are about the ACCOUNT, not a resource.
 */
export async function readLimits(ev: EvidenceClient): Promise<EvidenceLimits> {
  try {
    const { data } = await call("limits", () => ev.getLimits());
    return data;
  } catch (e) {
    if (e instanceof EvidenceApiError && e.code === "unauthorized")
      throw new AccessError("401: the API key was refused. Create a MAINNET key at https://api-access.delphi.fyi, signed in the same way you sign in to Delphi, and set DELPHI_API_ACCESS_KEY (a key exported in the shell takes the place of the one in .env). Testnet keys do not work.");
    if (e instanceof EvidenceApiError && e.code === "not_found")
      throw new AccessError(`404: this account has no evidence access yet. Possible reasons: ${competitionPhase() === "before" ? `the competition has not opened (${rules.competitionWindow.startsAt}); ` : ""}you have not registered at https://dorahacks.io/hackathon/delphi-agent-competition2/detail with the wallet shown on your Delphi profile (if it was another wallet, register again); or you registered or created the Delphi account in the last hour (access is synced once an hour: try again after an hour).`);
    throw e;
  }
}

/** Errors that must stop the agent, not just skip a market: bad key, region block, terms. */
export function isFatal(e: unknown): boolean {
  return e instanceof AccessError || e instanceof TermsNotAcceptedError || (e instanceof EvidenceApiError && ["unauthorized", "forbidden"].includes(e.code));
}

/** Network errors (fetch throws TypeError) and short-wait retryable API errors are transient. */
export function isTransient(e: unknown): boolean {
  if (isFatal(e)) return false;
  if (e instanceof EvidenceApiError) {
    if (!e.retryable) return false;
    if (e.code === "rate_limited" && e.limit && e.limit !== "call_rate") return false; // hourly/daily/bytes limits
    return (e.retryAfterSeconds ?? 0) <= MAX_INLINE_WAIT_S;
  }
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

/**
 * Polls to a final status, following Retry-After (30 s when there is none), for at most
 * `maxMinutes` (the guide says about 30). A result still pending then is returned as is: it stays
 * recorded as queued/judging and `npm run outcomes` reads it again later. Failed judgments are
 * retried automatically by Delphi first; we retry only `failed` + `canRetry`.
 */
export async function awaitFinal(ev: EvidenceClient, sub: Submission, maxMinutes = 30, maxRetries = 3): Promise<Submission> {
  let current = sub;
  const deadline = Date.now() + maxMinutes * 60_000;
  for (let retries = 0; ; ) {
    if (current.status === "queued" || current.status === "judging") {
      try {
        current = (await call("poll", () => ev.waitForSubmission(current.id, { timeoutMs: Math.max(1000, deadline - Date.now()), defaultIntervalMs: 30_000 }))).data;
      } catch (e) {
        if (!/Timed out waiting/.test((e as Error).message)) throw e;
        info(`submission ${current.id} still ${current.status} after ${maxMinutes} min; leaving it pending (npm run outcomes re-reads it)`);
        return current;
      }
    }
    if (current.status === "failed" && current.canRetry && retries < maxRetries) {
      retries++;
      const wait = current.retryAt ? Math.max(0, Date.parse(current.retryAt) - Date.now()) : 2000;
      info(`submission ${current.id} failed (${current.code ?? "?"}); retrying in ${Math.ceil(wait / 1000)}s (${retries}/${maxRetries})`);
      await sleep(wait);
      try {
        current = (await call("retry", () => ev.retrySubmission(current.id))).data;
      } catch (e) {
        if (!(e instanceof EvidenceApiError)) throw e;
        if (e.code === "not_found") {
          // Official: 404 for anything but a failed submission, i.e. Delphi already retried it.
          current = (await call("poll", () => ev.getSubmission(current.id))).data;
          if (current.status === "failed") return current;
        } else if (e.code === "rate_limited" && e.limit === "retry_backoff") {
          const s = e.retryAfterSeconds ?? 60;
          if (Date.now() + s * 1000 > deadline) return current; // the next cycle tries again
          info(`submission ${current.id}: still in its retry backoff, waiting ${s}s`);
          await sleep(s * 1000);
        } else throw e;
      }
      continue;
    }
    return current;
  }
}

/** Same policy as the starter: never accept terms unless ACCEPT_TERMS names the current version. */
export async function ensureTerms(ev: EvidenceClient): Promise<void> {
  const { data: terms, meta } = await call("terms", () => ev.getTerms());
  checkContract(meta);
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
export function resilient(ev: EvidenceClient, hooks: { onSubmitted?: (sub: Submission, p: SubmitEvidenceParams) => void } = {}): EvidenceClient {
  return new Proxy(ev, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      // Report a submission the moment it exists: polling can still fail afterwards, and a
      // submission we forget still uses a per-market slot and fixes our side on that market.
      if (prop === "submitEvidence")
        return async (p: SubmitEvidenceParams) => {
          const r = await submit(target, p);
          hooks.onSubmitted?.(r.data, p);
          return r;
        };
      if (prop === "waitForSubmission")
        return async (id: string) => {
          const { data, meta } = await call("poll", () => target.getSubmission(id));
          return { data: await awaitFinal(target, data), meta };
        };
      return (...a: unknown[]) => call(String(prop), () => (v as (...x: unknown[]) => Promise<unknown>).apply(target, a));
    },
  });
}

/** The API reports its contract version and any warnings (e.g. a missing X-Agent-* header) in headers. */
export function checkContract(meta: EvidenceMeta): void {
  if (meta.warnings) event("ERROR", `API warning: ${meta.warnings}`);
  if (!meta.contractVersion) return;
  const st = state.load();
  if (st.apiContractVersion && st.apiContractVersion !== meta.contractVersion) {
    event("ERROR", `Evidence API contract changed ${st.apiContractVersion} → ${meta.contractVersion}: re-run npm run sync-starter, check the SDK and the guide`);
  } else if (!st.apiContractVersion) {
    info(`evidence API contract ${meta.contractVersion}`);
  }
  st.apiContractVersion = meta.contractVersion;
  state.save();
}
