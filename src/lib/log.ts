/**
 * Logging to the console and to the Delphi Agent TUI event log
 * (~/.delphi/agent-events.jsonl, same format as the delphi skill's log-event.ts),
 * so `npx tsx scripts/agent-tui/index.tsx <wallet> <network>` shows the reasoning stream.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type EventType = "THINK" | "SKIP" | "SUBMIT" | "VERDICT" | "ERROR";

const logPath = () => process.env.DELPHI_AGENT_LOG ?? path.join(os.homedir(), ".delphi", "agent-events.jsonl");

export function event(type: EventType, text: string, extra: Record<string, unknown> = {}): void {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`${stamp} ${type.padEnd(7)} ${text}`);
  try {
    const p = logPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ ts: Date.now(), type, text, ...extra }) + "\n");
  } catch {
    /* the TUI log is a convenience; never fail the agent over it */
  }
  // Errors double as raw material for the competition's feedback bounties (5 × $250).
  if (type === "ERROR") {
    try {
      fs.mkdirSync("data", { recursive: true });
      fs.appendFileSync(path.join("data", "feedback-notes.md"), `- ${new Date().toISOString()} ${text}\n`);
    } catch {
      /* ignore */
    }
  }
}

export const info = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}         ${msg}`);
