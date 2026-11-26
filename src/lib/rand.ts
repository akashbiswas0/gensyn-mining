/**
 * Randomness for the simulator and canned research. With SIM_SEED set it is a seeded PRNG
 * (mulberry32), so a failing chaos run can be replayed: `npm run test:chaos -- --seed=<seed>`.
 * Without it, Math.random. Live code paths never use this.
 */
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, to turn any seed string into a 32-bit state. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const seed = process.env.SIM_SEED;
export const rand: () => number = seed ? mulberry32(hash(seed)) : Math.random;
export const randInt = (n: number) => Math.floor(rand() * n);
/** A random-looking hex id from `rand` (reproducible under a seed, unlike randomUUID). */
export const randHex = (len = 32) => Array.from({ length: len }, () => randInt(16).toString(16)).join("");
