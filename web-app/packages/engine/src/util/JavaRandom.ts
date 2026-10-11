/**
 * Bit-exact port of `java.util.Random` (48-bit LCG). Used where the original engine draws
 * random numbers (idle bus values), so that seeded runs match the Java reference exactly.
 */
export interface RandomSource {
  nextInt(bound: number): number;
  /** `Math.random()` equivalent in [0, 1). */
  nextDouble(): number;
}

const MULTIPLIER = 0x5deece66dn;
const ADDEND = 0xbn;
const MASK = (1n << 48n) - 1n;

export class JavaRandom implements RandomSource {
  private seed: bigint;

  constructor(seed: number | bigint = BigInt(Date.now()) ^ 0x5deece66dn) {
    this.seed = (BigInt(seed) ^ MULTIPLIER) & MASK;
  }

  /** Internal 48-bit state (for diagnostics / parity tests). */
  getState(): bigint {
    return this.seed;
  }

  private next(bits: number): number {
    this.seed = (this.seed * MULTIPLIER + ADDEND) & MASK;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  /** `Random.nextInt(int bound)` */
  nextInt(bound: number): number {
    if (bound <= 0) throw new Error('bound must be positive');
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    }
    let bits: number;
    let val: number;
    do {
      bits = this.next(31);
      val = bits % bound;
    } while (((bits - val + (bound - 1)) | 0) < 0);
    return val;
  }

  /** `Random.nextDouble()` */
  nextDouble(): number {
    const hi = BigInt(this.next(26)) << 27n;
    return Number(hi + BigInt(this.next(27))) * 2 ** -53;
  }
}

/** Unseeded source backed by `Math.random()` (production default, like Java's `Math.random`). */
export const mathRandom: RandomSource = {
  nextInt: (bound) => Math.floor(Math.random() * bound),
  nextDouble: () => Math.random(),
};
