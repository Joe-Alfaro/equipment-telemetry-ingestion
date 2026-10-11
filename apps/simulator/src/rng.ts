/** Deterministic source of uniform numbers in [0, 1). */
export interface Rng {
  next(): number
}

/** FNV-1a over the seed's code points, so any string maps to a 32-bit state. */
function hashSeed(seed: string): number {
  return [...seed].reduce(
    (hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0,
    0x811c9dc5,
  )
}

/** mulberry32 seeded from a string (SIM_SEED). Not cryptographic; only for demo traffic. */
export function createRng(seed: string): Rng {
  const state = { a: hashSeed(seed) }
  return {
    next: () => {
      state.a = (state.a + 0x6d2b79f5) >>> 0
      const t1 = Math.imul(state.a ^ (state.a >>> 15), state.a | 1)
      const t2 = (t1 + Math.imul(t1 ^ (t1 >>> 7), t1 | 61)) ^ t1
      return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296
    },
  }
}
