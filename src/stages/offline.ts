/**
 * Zero-cost canned stages for plumbing and chaos tests (--offline). They are deliberately
 * adversarial: each research call also proposes facts the pipeline must refuse (the opposite
 * side, a reused source, a near-copy of an earlier note), and verification fails some at random.
 */
import { rand, randHex, randInt } from "../lib/rand.js";
import type { MarketState } from "../lib/state.js";
import type { Candidate, Direction, Market, Stages } from "../types.js";

const day = () => new Date().toISOString().slice(0, 10);
const VOCAB = "agency regulator filing docket schedule minutes ministry council vote tender permit audit release survey bulletin hearing statement registry quota tariff index forecast recall license injunction ballot".split(" ");
const phrase = () => Array.from({ length: 6 }, () => VOCAB[randInt(VOCAB.length)]).join(" ");

function cand(direction: Direction, url: string, claim: string): Candidate {
  return {
    claim, eventDate: day(), publishedDate: day(), direction, quote: "canned",
    // Sometimes several sources, so the 3-item packing (note + links + files) is exercised against the simulator.
    sourceUrls: rand() < 0.5 ? [url, `${url}/corroboration`, `${url}/series`] : [url],
    whyNew: "canned", whyItMatters: "canned", expectedImpact: (["low", "medium", "high"] as const)[randInt(3)], confidence: 0.5 + rand() / 2, duplicationRisk: rand() * 0.4,
  };
}

export const offlineStages: Stages = {
  async research(m: Market, s: MarketState) {
    if (rand() < 0.15) return { candidates: [], contraryEvidence: "", summary: "canned: nothing found" };
    const side: Direction = s.side ?? ((m.probYes ?? 0.5) < 0.5 ? "yes" : "no");
    const other: Direction = side === "yes" ? "no" : "yes";
    const prior = s.submissions.at(-1);
    const candidates: Candidate[] = [
      cand(other, `https://example.org/${randHex()}`, `Opposite-side ${phrase()}`),
      ...(prior ? [cand(side, prior.links[0]!, `Reused source ${phrase()}`), cand(side, `https://example.net/${randHex()}`, prior.note)] : []),
      cand(side, `https://example.com/${randHex()}`, `On ${day()} the ${phrase()} for ${m.address.slice(0, 8)}`),
    ];
    return { candidates, contraryEvidence: rand() < 0.2 ? "canned contrary evidence" : "", summary: `canned: ${candidates.length} candidates` };
  },
  async verify(_m, c) {
    const pass = rand() < 0.75;
    return {
      supported: pass, dateConfirmed: true, directionCorrect: true, novelty: pass ? 0.8 : 0.2, relevance: 0.8, duplicationRisk: rand() * 0.3, score: pass ? 0.8 : 0,
      issues: pass ? [] : ["canned: random fact-check failure"],
      workingCsv: rand() < 0.3 ? "input,value\nlast_reading,4.21\nthreshold,4.00\nrequired_change,-0.06\n" : "",
      sourceMayBeUnreadable: false,
      factDate: c.eventDate,
      factText: `${c.claim}, according to a public notice at ${new URL(c.sourceUrls[0]!).hostname}. This bears on the question's resolution.`,
    };
  },
};
