/**
 * Delphi Agent Arena: Evidence Mining, our own runner. Real everything by default.
 *
 *   npm run cycle                       live: competition markets → Delphi (from 23 Nov)
 *   npm run loop                        live, every LOOP_INTERVAL_MINUTES
 *   npm run sim                         real Delphi markets + real Claude → simulator judge
 *   npm run sim:fixture                 sample markets + real Claude → simulator
 *   npm run test:chaos                  sample markets + canned research → simulator with failures
 *
 * Flags: --markets=competition|delphi|fixture  --sim  --offline  --loop  --cycles=N
 */
import { config, describeMode } from "./config.js";
import { ensureTerms, isFatal, makeEvidenceClient } from "./lib/evidence.js";
import { BudgetExceeded } from "./lib/llm.js";
import { event, info } from "./lib/log.js";
import { promptVersion } from "./lib/version.js";
import { cycle } from "./pipeline.js";

async function main(): Promise<void> {
  info(`${describeMode()} · agent ${config.agentId} · prompt version ${promptVersion()}`);
  const ev = makeEvidenceClient();
  await ensureTerms(ev);

  if (!config.loop) {
    for (let i = 1; i <= config.cycles; i++) {
      if (config.cycles > 1) info(`── cycle ${i}/${config.cycles}`);
      await cycle(ev);
    }
    return;
  }
  for (;;) {
    try {
      await cycle(ev);
    } catch (e) {
      event("ERROR", (e as Error).message);
      if (isFatal(e)) throw e; // bad key, region block, or new terms: a person must act
      if (e instanceof BudgetExceeded) info("daily budget reached; waiting for the next cycle");
    }
    info(`sleeping ${config.loopIntervalMinutes} min`);
    await new Promise((r) => setTimeout(r, config.loopIntervalMinutes * 60_000));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
