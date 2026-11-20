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
scripts/chaos-test.ts    many runs against the failing simulator, then checks the safety rules
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
| `npm run cycle` / `npm run loop` | competition | **live Delphi** | Claude |
| `npm run starter` | competition | **live Delphi** (official starter + our brain) | Claude |
| `npm run sim` | **real Delphi** | simulator | Claude |
| `npm run starter:sim` | **real Delphi** | simulator (official starter + our brain) | Claude |
| `npm run sim:fixture` | samples | simulator | Claude |
| `npm run test:chaos` | 12 generated | simulator + 25% failures | canned ($0) |

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

## Before 25 November

1. **Mainnet API key.** Create one at <https://api-access.delphi.fyi/> (keep **Mainnet** selected) with your Delphi account's wallet, and put it in `.env` as `DELPHI_API_ACCESS_KEY`. A testnet key gets `401`; keep one in `DELPHI_MARKETS_API_KEY` for testing on testnet markets.
2. **`.env` identity.** Set `DELPHI_WALLET_ADDRESS` (the key's wallet, also your DoraHacks wallet) and `DELPHI_AGENT_ID` (your agent's name).
3. **Register on DoraHacks** with that wallet, if not done. It takes up to 12 hours to sync.
4. **Test the key.**
   - `npm run feedback -- --list` should return an empty list.
   - `npm run status` should show terms and limits.
   - A `401` means a wrong or testnet key. `not_found` on every route means the wallet isn't registered yet.
5. **Accept the terms.** `npm run status` prints the URL and version. Read them, then set `ACCEPT_TERMS=<version>`.
6. **Tune in the simulator.** Run `npm run sim` on real markets with real Claude, then `npm run report -- --sim`.

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
- **Readable sources.** Notes follow the official structure: fact and date, source, why it matters, working. A **working.csv** is attached for calculations, and the **original document** (PDF/CSV/TXT/DOC) is copied when the judge may not be able to open the link. The link is always sent too.
- **Polling.** Results are polled for up to 30 minutes, then left pending for `npm run outcomes` to re-read.

## Rules and eligibility

See **[COMPLIANCE.md](COMPLIANCE.md)**. It maps every rule in the Pilot Terms and on the DoraHacks page to how it's enforced, and lists what you must do yourself. Key guards:
- Live runs refuse canned research, test markets or a placeholder `AGENT_ID`.
- The fact-check has a policy check: public source, no private personal data, nothing confidential.
- A final lint blocks notes that address the judge.
- The evidence cutoff is re-checked right before submitting.
- `--review` lets you approve each submission.
