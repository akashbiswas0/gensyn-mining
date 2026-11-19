/**
 * Ranks markets by where the agent is most likely to add new, rewarded information.
 * Hard filters come from config/rules.json (the starter itself uses status "open",
 * before the cutoff, YES odds 20%-80%).
 */
import { rules } from "../config.js";
import * as state from "../lib/state.js";
import type { Market } from "../types.js";

export interface Ranked { market: Market; score: number; why: string }

const HOUR = 3_600_000;

export function rankMarkets(markets: Market[], now = new Date()) {
  const ranked: Ranked[] = [];
  const skipped: { market: Market; why: string }[] = [];
  const maxPot = Math.max(1, ...markets.map((m) => m.rewardPot ?? 0));
  const f = rules.marketFilter;

  for (const m of markets) {
    const s = state.market(m.address);
    const used = s.submissions.length;
    const cutoff = m.evidenceCutoff ?? m.closesAt;
    const skip = (why: string) => skipped.push({ market: m, why });

    if (f.statuses.length && !f.statuses.includes(m.status)) { skip(`status ${m.status}`); continue; }
    if (m.probYes !== null && (m.probYes < f.minYes || m.probYes > f.maxYes)) { skip(`odds ${m.probYes.toFixed(2)} outside band`); continue; }
    if (used >= rules.maxSubmissionsPerMarket) { skip("all submissions used"); continue; }
    if (cutoff && cutoff.getTime() - now.getTime() < rules.cutoffBufferMinutes * 60_000) { skip("evidence cutoff passed or too close"); continue; }
    if (s.skipUntil && new Date(s.skipUntil) > now) { skip(`backing off until ${s.skipUntil}`); continue; }

    // Uncertain markets are where new facts move the forecaster most; the floor keeps
    // confidently priced markets in play for a surprising fact.
    const p = m.probYes ?? 0.5;
    const uncertainty = Math.max(0.2, 1 - Math.abs(p - 0.5) * 2);
    const pot = m.rewardPot === null ? 0.5 : Math.log1p(m.rewardPot) / Math.log1p(maxPot);
    const hoursLeft = cutoff ? (cutoff.getTime() - now.getTime()) / HOUR : 24 * 7;
    const timing = hoursLeft < 6 ? 0.4 : hoursLeft <= 24 * 10 ? 1 : 0.6;
    const since = s.lastResearchedAt ? (now.getTime() - new Date(s.lastResearchedAt).getTime()) / HOUR : Infinity;
    const freshness = since < 6 ? 0.3 : since < 24 ? 0.7 : 1;
    const remaining = 0.5 + 0.5 * ((rules.maxSubmissionsPerMarket - used) / rules.maxSubmissionsPerMarket);

    ranked.push({
      market: m,
      score: (0.4 * uncertainty + 0.35 * pot + 0.25 * timing) * freshness * remaining,
      why: `p=${m.probYes?.toFixed(2) ?? "?"} pot=${m.rewardPot ?? "?"} ${hoursLeft.toFixed(0)}h left, ${used}/${rules.maxSubmissionsPerMarket} used`,
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, skipped };
}
