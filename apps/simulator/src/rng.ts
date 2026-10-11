/** Deterministic source of uniform numbers in [0, 1). */
export interface Rng {
  next(): number
}

export function createRng(_seed: string): Rng {
  throw new Error('not implemented: createRng')
}
