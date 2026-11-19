# Delphi Evidence Mining Agent

Agent for the **Delphi Agent Arena: Evidence Mining** competition (Gensyn, 23 Nov – 11 Dec 2026).
It finds dated, sourced, public facts on Delphi markets, fact-checks them, submits them and records
verdicts and rewards.

It's built as a **base that adopts the official release**. It already follows the organisers' starter
agent (public in the SDK repo since 19 Nov): the same `/markets.json` format, the same environment
variable names and the same note format. Whatever changes on 23 Nov lives in files you can edit
without touching code.

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
| Markets | `competition`: `<COMPETITION_SITE_URL>/markets.json` (from 23 Nov) | `--markets=delphi`: **real live Delphi markets** via the SDK (works today) · `--markets=fixture`: samples |
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
- `npm run report` compares prompt versions on what the judge paid. Add `-- --sim` for simulator results.
- `npm run status` shows submissions, verdicts and qualification progress. Add `-- --sim` for simulator results.
- `npm run inspect-markets` shows how a market feed maps (try `-- --markets=delphi`).
- `npm run sync-starter` re-pulls the official starter.
- `npm run typecheck` runs `tsc --noEmit`.

### Test in the simulator, promote to live

1. Edit `prompts/`, `guide/` or `config/rules.json`. Every change gets a new **prompt version** (a hash), which is recorded on each submission.
2. Run `npm run sim` (real Delphi markets, real Claude, simulated judge) a few times.
3. Run `npm run report -- --sim`. It ranks versions by acceptance, reward per submission, cost per submission and reward per dollar.
4. Keep the best version, run it live, and check `npm run report`, which shows the **real** judge's verdicts.

### Our runner or the official starter

Both use the same brain (`src/finder.ts`) and the same memory.

| | Our runner (`src/pipeline.ts`) | Official starter (`src/starter-bridge.ts`) |
|---|---|---|
| Market choice | Ranked by uncertainty, pot, timing, freshness | Starter's filter (open, 20–80% odds), feed order |
| Per run | Several markets, up to the hourly cap | One submission |
| Resilience | Built in | Starter has none; the bridge hands it a client with retries and checks limits first |

The chaos test found that the unmodified starter exits with an error on the hourly limit or a transient 5xx. The bridge now covers that.

## 23 November playbook

1. **Sync the official code.**
   ```bash
   npm run sync-starter          # pulls the latest starter, reports a newer SDK if any
   git diff vendor/              # see exactly what the organisers changed
   npm install @gensyn-ai/gensyn-delphi-sdk@latest   # if a newer SDK is reported
   npm run typecheck && npm run test:chaos
   ```
   If the starter's `MarketCard` or `Fact` types changed, `tsc` points at the places to update (`src/types.ts` re-exports them).
2. **Add the guide.** Save the agent guide and the one-line prompt as `.md` files in `guide/`. They're added to the research and fact-check prompts on the next run.
3. **Update the rules.** Edit `config/rules.json` for any rule the guide states, such as note length, link and file limits, submissions per market, qualification, or note format.
4. **Fill in `.env`.** Copy `.env.example`, then set `DELPHI_API_URL`, `DELPHI_API_ACCESS_KEY` and `COMPETITION_SITE_URL`.
5. **Check the real feed.** `npm run inspect-markets` lists fields we don't use yet. Map the useful ones in `src/stages/markets.ts`, for example a reward pot or a description.
6. **Accept the terms.** `npm run status` prints the terms URL and version. Read them, then set `ACCEPT_TERMS=<version>`.
7. **First live run, small.** Run `MARKETS_PER_CYCLE=1 npm run cycle`, read the judge's rationale with `npm run status`, and tune `prompts/` and `minVerifyScore` through the simulator.
8. **Feedback bounties.** Errors collect in `data/feedback-notes.md`. Send the useful ones through the feedback API or form (5 × $250).

## Rules the code enforces

- **Content:** public information only. Every claim needs a source URL and a verbatim quote, and the fact-check pass reopens the sources.
- **Terms:** never accepted automatically. You set `ACCEPT_TERMS` to the version you read, which is the starter's own policy.
- **Sides:** one side per market (`oneSidePerMarket`), because evidence for both sides cancels out.
- **Duplicates:** facts from a repeated source or similar to an earlier note are dropped before paying to fact-check them.
- **Limits:** per-market limit, hourly and daily caps from `/limits`, and the daily Claude budget.
- **Qualification:** progress is shown in `npm run status` (10 judged submissions on 3+ markets).
