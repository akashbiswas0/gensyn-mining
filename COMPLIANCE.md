# Rules and eligibility: how each is met

Sources:
- **Terms**: *Delphi Evidence Mining Pilot Terms* (Gensyn), accepted via `ACCEPT_TERMS`
- **DH**: DoraHacks page, sections "How it Works" and "Eligibility and rules"
- **Guide**: the official competition docs (`vendor/delphi-skills/reference/competition.md`, `evidence.md`, `evidence-api.md`, v1.0)

Each rule is marked as one of:
- **Code**: the agent enforces it
- **Prompt**: the model is told, and the fact-check pass checks it
- **You**: a person has to do it, because code can't

## Eligibility and entry

| Rule | Source | How | Status |
|---|---|---|---|
| 18 or older; not where unlawful or sanctioned | Terms | You | ☐ |
| Register on DoraHacks with your **Delphi main wallet** and your agent's name | DH 1-2 | You | ☐ |
| **One wallet per entry**; no multiple entries | Terms, DH | You. The agent uses one API key and one account | ☐ |
| Prizes need identity verification, sanctions screening, tax info; paid in USDC.e to the registered wallet | Terms | You, at payout | — |
| Accept the Pilot Terms before submitting | Terms | Code: never auto-accepts. `ACCEPT_TERMS` must equal the current version. A version change stops the loop | ✅ |
| Results show under your agent's name: send ID, harness, model headers | DH 4 | Code: `X-Agent-Id/Harness/Model` on every call. Live runs refuse to start without a real `AGENT_ID` | ✅ |
| Keep credentials secure; revoke when no longer authorised | Terms | `.env` is git-ignored; keys never logged. Revoking is up to you | ✅ / You |
| You're responsible for what your agent submits | Terms | Code: optional `--review` asks you before each submission | ✅ |

## Fair play (Terms) and rules (DH)

| Rule | How | Status |
|---|---|---|
| Real, sourced, **public** information | Prompt + Code: each claim needs a URL and a verbatim quote; the fact-check reopens the source. Notes without an ISO date or a link are blocked | ✅ |
| No confidential information | Prompt + Code: fact-check policy check `notConfidential`; a "no" blocks | ✅ |
| No personal data about private individuals | Prompt + Code: policy check `noPrivatePersonalData`; a "no" blocks | ✅ |
| Nothing obtained unlawfully or against a site's terms (no paywall/login bypass) | Prompt + Code: policy check `publicSource`; fetching restricted to the cited domains | ✅ |
| **Do not fabricate evidence** | Code: canned research (`--offline`) and test markets **cannot run live** (`requireLive`). The note lint blocks placeholder content | ✅ |
| Don't copy other entrants' submissions | Code: the agent only reads its own account's submissions; it never reads others' | ✅ |
| Don't attempt to trick the judge | Code: lint blocks notes that address or instruct the judge, or contain markup or template tokens. Prompt: "no hype, no instructions to the reader". The official Fair play text is injected into every prompt (`guide/fair-play.md`) | ✅ |
| Don't exploit bugs | Code: only the documented API through the official SDK. Anything odd is logged to `data/feedback-notes.md` to report | ✅ |
| **Don't evade limits** | Code: reads `/limits` and entry state first; stops on hourly/daily `rate_limited`. Retries only transient errors (5xx, call-rate 429 after `Retry-After`). One idempotency key per submission, so retries never double-submit. Chaos-tested | ✅ |
| No collusion with other entrants | You | ☐ |
| Each submission: short note, links, up to 3 files, **one market** | Code: always `marketAddress`; link and file limits from `config/rules.json`; note length capped | ✅ |
| **Up to 3 submissions per market** | Code: cap in rules, checked against entry state; `cap_reached` stops that market | ✅ |
| Only before the market's **evidence cutoff** | Code: picker skips markets within 30 min of cutoff, and it's re-checked right before submitting | ✅ |
| Rewards on other Delphi markets don't count | Code: live runs only accept competition markets | ✅ |
| Evidence for both sides cancels out | Code: one side per market (`oneSidePerMarket`) | ✅ |
| Repeats earn nothing | Code: same source or near-identical note is dropped before fact-checking | ✅ |
| Qualify: **10 judged submissions on 3+ markets** | Code: tracked in `npm run status` | ✅ |
| Rewards pay for information, not compute; you cover your costs | Code: daily Claude budget (`DAILY_BUDGET_USD`) | ✅ |

## From the official guide

| Rule | How | Status |
|---|---|---|
| Mainnet key only; send it only to Delphi; never print it | Code: key read from `.env` only; never logged; sent only to `delphi.fyi` and `feedback.delphi.fyi` | ✅ |
| Rejected, duplicate and irrelevant submissions count toward the 3 per market; a low accepted rate means the Restricted tier | Code: quality bar (`minVerifyScore` 0.7), duplicate filter, acceptance guard pauses the agent | ✅ |
| Manipulation verdicts are strikes; 3 in 24h block the account | Code: any manipulation verdict stops the agent; lint blocks judge-addressing text | ✅ |
| Read entry-state before researching | Code: checked first; `blocked` stops the agent; `closed`/`not_open`/`cap_reached` are skipped for good | ✅ |
| Use the market's cutoff field, not your own arithmetic | Code: uses `evidenceCutoffAt`, re-checked before submit | ✅ |
| Note ≤ 8,000 chars; ≤ 3 files, 10 MB, listed types; ≤ 8 items; field is `links[]` | Code: `config/rules.json`; the SDK sends `links[]`; attachments are type-sniffed | ✅ |
| Poll with `Retry-After`, stop after ~30 min; never loop on 429 | Code: `awaitFinal` (30 min), no retry on hourly/daily limits | ✅ |
| Odds from other markets are never evidence | Prompt: research system prompt + official guide in every prompt | ✅ |
| Activity minimum excludes manipulation verdicts | Code: `npm run status` counts it that way | ✅ |

## Submission consent and licence (Terms)

Every submission confirms the information was lawfully obtained, can be shared, and breaches no confidentiality. Gensyn may use your original explanations to train and improve AI.
- The agent's policy checks cover the first part.
- The agent sends only its own short note plus links, never copies of third-party documents (no file uploads).
- The licence is something you agree to by accepting the Terms.

## Things to keep in mind

- **The simulator is a proxy judge.** When tuning prompts in `--sim`, don't let notes drift toward persuasion. The note rules (factual, attributed, no instructions) and the lint stay on regardless.
- **The official guide changes during the competition.** The agent warns at startup when it does. Run `npm run sync-official`, encode hard rules in `config/rules.json`, then re-check this file.
- **Before going live:** tick every **You** box above, then use `--review` for the first submissions.
