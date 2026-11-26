# Delphi Evidence Mining Agent

Agent for the **Delphi Agent Competition: Evidence Mining** (Gensyn, on **Delphi Mainnet**,
**25 Nov 17:00 UTC – 11 Dec 2026**). It finds dated, sourced, public facts on Delphi markets,
fact-checks them, submits them and records verdicts and rewards.

It follows the organisers' official material:
- the guide and rules (`gensyn-delphi-skills`, docs v1.0)
- the starter agent and SDK (`gensyn-delphi-sdk`)

`npm run sync-official` pulls both into `vendor/`. The parts the model must follow land in `guide/official-*.md`, which goes into every prompt. The agent warns at startup when the official rules change upstream.

| Official | |
|---|---|
| Site, markets, leaderboard | <https://competition.delphi.fyi> (`/markets.json` from 25 Nov) |
| Evidence API | `https://delphi.fyi/v1` with a **Mainnet** key from <https://api-access.delphi.fyi/> |
| Feedback | <https://feedback.delphi.fyi> (`npm run feedback`) |
| Rules | `vendor/delphi-skills/reference/competition.md` · what earns: `guide/official-evidence.md` |

## Layout

```
config/rules.json        competition rules + agent policy (limits, note template, market filter, thresholds)
prompts/*.md             research and fact-check prompts ({{placeholders}})
guide/*.md               paste the official agent guide / one-line prompt here → injected into the prompts
vendor/evidence-starter/ the official starter agent, synced from GitHub (do not edit)
fixtures/                sample markets (starter's MarketCard shape)
scripts/sync-starter.ts  re-pulls the official starter and checks for a newer SDK

src/
  finder.ts              the brain: research → filter (side lock, duplicates) → fact-check → note
  pipeline.ts            our runner: limits → rank markets → finder → submit → verdict → memory
  starter-bridge.ts      the official starter's run() with our finder plugged in as findFact()
  stages/
    markets.ts           market sources (competition / real Delphi via SDK / fixture) → Market
    picker.ts            ranking + hard filters from rules.json
    claude.ts            Claude research + fact-check (server-side web search/fetch)
    offline.ts           canned adversarial stand-ins ($0)
    index.ts             picks stage implementations
  lib/
    evidence.ts          SDK EvidenceClient (live or simulator), retries, idempotent submit, terms gate
    version.ts           prompt-version hash recorded on every submission
    llm.ts               Claude calls, refusal fallback, spend tracking against the daily budget
    prompts.ts note.ts   prompt templates + guide injection; note from rules.noteTemplate
    state.ts log.ts      memory (data/state.json); events → ~/.delphi/agent-events.jsonl (Agent TUI)
  inspect-markets.ts     shows how the real feed maps, and which fields are new
  status.ts              rewards, verdicts, qualification progress, terms, limits
  report.ts              compares prompt versions on what the judge paid
  sim/server.ts          local competition simulator (evidence API /v1 routes, strict, chaos mode)
  sim/judge.ts           simulated judge: Claude forecaster before/after a note (or heuristic)
scripts/chaos-test.ts    5 scenarios of real runs against the failing simulator, then checks the safety rules
tests/unit.test.ts       item packing, notes, market ranking, error classification
tests/contract.test.ts   the real SDK client against the simulator, rule by rule from the official API docs
```

## Real vs simulated

Everything is **real by default**. Three switches each replace one part, for testing:

| Part | Real (default) | Test switch |
|---|---|---|
| Markets | `competition`: `competition.delphi.fyi/markets.json` (from 25 Nov) | `--markets=delphi`: **real live Delphi markets** via the SDK (works today) · `--markets=fixture`: samples |
| Submissions + judge | Delphi evidence API through the SDK `EvidenceClient` | `--sim`: the same SDK client pointed at the local simulator |
| Research + fact-check | Claude with web search/fetch | `--offline`: canned, adversarial ($0) |

The **simulator** (`src/sim/`) implements the evidence API's routes and is deliberately strict:
- **Rules:** terms gate, validation, idempotency, the 3-per-market cap, the hourly limit, the daily cap (pays 0), reward pots and duplicate detection.
- **Judge:** a Claude forecaster estimates P(YES) before and after reading a note, and pays for the move. `SIM_JUDGE=heuristic` is a $0 version.
- **Chaos:** `SIM_CHAOS=0..1` injects network errors, 5xx, call-rate 429s and failed judgements.

Its judge is a proxy for the real one: good for comparing versions, not a promise of real rewards. Simulated runs keep their own memory in `data/sim/`, so they never mix with live records.

## Commands

| Command | Markets | Submissions | Research |
|---|---|---|---|
| `npm run preflight` | competition | nothing sent (read-only check: key, terms, limits, markets, docs) | none ($0) |
| `npm run cycle` / `npm run loop` | competition | **live Delphi** | Claude |
| `npm run starter` | competition | **live Delphi** (official starter + our brain) | Claude |
| `npm run sim` | **real Delphi** | simulator | Claude |
| `npm run starter:sim` | **real Delphi** | simulator (official starter + our brain) | Claude |
| `npm run sim:fixture` | samples | simulator | Claude |
| `npm run test:chaos` | 12 generated | simulator, 5 scenarios (see below) | canned ($0) |

Other commands:
- `npm run outcomes` refreshes submissions from the API and checks how each market actually settled on Delphi (real ground truth for side accuracy). Add `-- --sim` for simulator runs.
- `npm run report` compares prompt versions on what the judge paid and, after `outcomes`, how often the chosen side was right. Add `-- --sim` for simulator results.
- `npm run status` shows submissions, verdicts and qualification progress. Add `-- --sim` for simulator results.
- `npm run inspect-markets` shows how a market feed maps (try `-- --markets=delphi`).
- `npm run sync-official` re-pulls the official starter, docs and guide (alias `sync-starter`).
- `npm run feedback` sends feedback to Delphi or shows the collected notes.
- `npm run typecheck` runs `tsc --noEmit`.

### Test in the simulator, promote to live

1. Edit `prompts/`, `guide/` or `config/rules.json`. Every change gets a new **prompt version** (a hash), which is recorded on each submission.
2. Run `npm run sim` (real Delphi markets, real Claude, simulated judge) a few times.
3. Run `npm run report -- --sim`. It ranks versions by acceptance, reward per submission, cost per submission and reward per dollar. As those real Delphi markets settle, `npm run outcomes -- --sim` adds whether the chosen side was right, scored against real outcomes rather than the proxy judge.
4. Keep the best version, run it live, and check `npm run report`, which shows the **real** judge's verdicts.

### Our runner or the official starter

Both use the same brain (`src/finder.ts`) and the same memory.

| | Our runner (`src/pipeline.ts`) | Official starter (`src/starter-bridge.ts`) |
|---|---|---|
| Market choice | Ranked by uncertainty, pot, timing, freshness | Starter's filter (open, 20–80% odds), feed order |
| Per run | Several markets, up to the hourly cap | One submission |
| Resilience | Built in | Starter has none; the bridge hands it a client with retries and checks limits first |

The chaos test found that the unmodified starter exits with an error on the hourly limit or a transient 5xx. The bridge now covers that.

## Tests ($0, no keys, never call live services; the chaos test rewrites only `data/chaos/`)

| Command | What | Time |
|---|---|---|
| `npm test` | typecheck + unit + contract + full chaos | ~10 min |
| `npm run test:quick` | the same, 1 round per chaos scenario | ~5 min |
| `npm run test:unit` | 3-item packing (incl. a 500-case property test and a local document server), note building/linting, market ranking, which errors are retried or stop the agent | 2 s |
| `npm run test:contract` | the real SDK client against the simulator, pinned to the official API docs: terms, the 3-item limit and its error fields, idempotency, per-market cap, entry-state reasons, hourly limit, recovery of lost polls | 1 s |
| `npm run test:chaos` | scenarios `baseline` (25% failures), `storm` (60%), `tight-hourly` (limit 4), `no-access` (404 everywhere), `no-terms`, `slow-judge` (results outlive polling). Each but `slow-judge` (which recovers through `outcomes`) ends with one calm cycle that must recover any lost result. Invariants: rules (cap, hourly, items, note, links, agent id), strategy (one side, no repeated source or note), memory (agent ↔ server 1:1, remembers exactly what was sent and the verdict, every record final) | ~7 min |

Chaos randomness is seeded. A failure prints a replay command, e.g. `npm run test:chaos -- --seed=1106300e --scenario=storm`. Options: `--scenario=a,b`, `--runs=N`, `--quick`.

What these tests found and fixed: pending results were never re-read after a failed poll (now `refreshPending` at the start of every cycle); the starter bridge forgot a submission when the starter's poll failed (now recorded the moment it is made); the bridge paid for research before finding out the terms were not accepted (now checks first); memory recorded the proposal instead of what was actually sent; and two simulator gaps (404 before the terms check, results only judged when polled one by one).

## To start competing (live since 25 Nov 17:00 UTC, ends 11 Dec 17:00 UTC)

Run `npm run preflight` after each step: it checks everything below without submitting or accepting anything.

1. **Register** on DoraHacks with the wallet shown on your **Delphi profile**. Access is synced once an hour; until then every call answers `404`.
2. **Mainnet API key** from <https://api-access.delphi.fyi/>, signed in **the same way you sign in to Delphi**, in `.env` as `DELPHI_API_ACCESS_KEY`. A testnet key answers `401` (keep it in `DELPHI_MARKETS_API_KEY` for `npm run sim`). A key exported in the shell takes the place of the one in `.env`.
3. **Name and Claude key**: `DELPHI_AGENT_ID` and `ANTHROPIC_API_KEY`. `DELPHI_WALLET_ADDRESS` (the key's "Issued to wallet") is only for feedback.
4. **Terms**: preflight prints the URL and version. Read them; only if you agree, set `ACCEPT_TERMS=<version>`.
5. **First submissions**: `npm run cycle -- --review` asks before each one is sent. Then `npm run loop`.

## On and after 25 November

1. **Check for changes.** Run `npm run sync-official && git diff vendor/ guide/`, then `npm run typecheck && npm run test:chaos`.
2. **Read the real feed.** `npm run inspect-markets` shows the live `/markets.json` and flags fields we don't use yet. Pots are 20 USDC.e judgment and 30 settlement per market.
3. **Start small, with review.** Run `MARKETS_PER_CYCLE=1 npm run cycle -- --review`.
4. **Learn from the results.** `npm run status` shows the verdicts and the judge's reasons. Tune `prompts/` and `config/rules.json` through the simulator.
5. **Send feedback.** `npm run feedback -- --notes` shows what the agent collected. Send the useful ones with `npm run feedback -- --area … --text …` (5 × USD 250).

## What protects the account

These follow the official rules:
- **Weak submissions still count.** Rejected, duplicate and irrelevant submissions each use one of the 3 per market, and a low accepted rate drops the account to the **Restricted tier** (1 per market). The **acceptance guard** pauses the agent when fewer than half of the last 6 were accepted (`config/rules.json` → `acceptanceGuard`).
- **Manipulation verdicts.** Any manipulation verdict in 24 hours stops the agent, because 3 strikes in 24 hours block the account.
- **Entry state first.** Every market is checked before research:
  - `blocked` and `terms_not_accepted` stop the agent;
  - `rate_limited` ends the hour;
  - `closed`, `not_open` and `cap_reached` skip the market for good.
- **Readable sources.** Notes follow the official structure: fact and date, source, why it matters, working. A submission holds at most **3 items** (the note, each link and each file count as 1; official since 2026-11-23). The note and the main link always go. The last slot goes, in order, to a copy of a source the judge may not be able to open, then **working.csv** for a calculation, then a copy of a PDF/spreadsheet source, then a second link. A calculation that gets no slot is written into the note. See `src/lib/attachments.ts`.
- **Polling.** Results are polled for up to 30 minutes, then left pending for `npm run outcomes` to re-read.

## Rules and eligibility

See **[COMPLIANCE.md](COMPLIANCE.md)**. It maps every rule in the Pilot Terms and on the DoraHacks page to how it's enforced, and lists what you must do yourself. Key guards:
- Live runs refuse canned research, test markets or a placeholder `AGENT_ID`.
- The fact-check has a policy check: public source, no private personal data, nothing confidential.
- A final lint blocks notes that address the judge.
- The evidence cutoff is re-checked right before submitting.
- `--review` lets you approve each submission.
