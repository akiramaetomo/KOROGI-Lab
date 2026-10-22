/**
 * 31-bit Fibonacci LFSR noise tables (after the TR-909 noise generator, not an emulation of it).
 *
 * State bits are numbered 1..31 from the LSB. Each clock shifts left and inserts
 * b = bit31 XOR bit13, which is also the output bit. The output therefore obeys
 * b[t] = b[t-31] XOR b[t-13], characteristic polynomial x^31 + x^18 + 1 (the reciprocal of
 * x^31 + x^13 + 1); both are primitive, so every nonzero state has period 2^31 - 1.
 */
export const LFSR_LENGTH = 31;
const MASK31 = 0x7fff_ffff;
/** Taps 31 and 13 are 18 apart, so up to 13 new bits depend only on the current state. */
const MAX_CHUNK = 13;
export const DEFAULT_LFSR_SEED = 0x1d87_2b41;
export const LFSR_TABLE_SEC = 10;

/** A nonzero 31-bit state; zero (the LFSR's fixed point) is replaced by the default seed. */
export function lfsrState(seed: number): number {
  const state = (seed >>> 0) & MASK31;
  return state === 0 ? DEFAULT_LFSR_SEED : state;
}

export class Lfsr31 {
  private state: number;

  constructor(seed = DEFAULT_LFSR_SEED) {
    this.state = lfsrState(seed);
  }

  get value(): number {
    return this.state;
  }

  /** One clock; returns the inserted bit. Reference implementation for nextBits. */
  nextBit(): number {
    const bit = ((this.state >>> 30) ^ (this.state >>> 12)) & 1;
    this.state = ((this.state << 1) | bit) & MASK31;
    return bit;
  }

  /** `count` clocks (1..16) packed first-bit-first into an unsigned integer. */
  nextBits(count: number): number {
    let value = 0;
    for (let left = count; left > 0;) {
      const k = Math.min(left, MAX_CHUNK);
      const mask = (1 << k) - 1;
      const chunk = ((this.state >>> (31 - k)) ^ (this.state >>> (13 - k))) & mask;
      this.state = ((this.state << k) | chunk) & MASK31;
      value = (value << k) | chunk;
      left -= k;
    }
    return value;
  }
}

export interface LfsrTableOptions {
  sampleRate: number;
  /** Amplitude update rate (not the shift rate, which is clockHz * bits). */
  clockHz: number;
  /** Output resolution 1..16; each value consumes this many LFSR clocks. */
  bits: number;
  seed?: number;
  durationSec?: number;
}

export function lfsrFrameCount(sampleRate: number, durationSec = LFSR_TABLE_SEC): number {
  return Math.max(1, Math.round(sampleRate * durationSec));
}

/** Number of amplitude values in a table: the clock rounds to a multiple of 1/duration so the loop wraps on an update. */
export function lfsrUpdateCount(sampleRate: number, clockHz: number, durationSec = LFSR_TABLE_SEC): number {
  const frames = lfsrFrameCount(sampleRate, durationSec);
  return Math.min(frames, Math.max(1, Math.round(clockHz * durationSec)));
}

/**
 * Zero-order-hold table. Value k holds from frame floor(k*L/M) to floor((k+1)*L/M), a rational
 * phase accumulator whose mean update rate is M/duration; the wrap is an ordinary update boundary.
 * An N-bit unsigned value u maps linearly to 2u/(2^N - 1) - 1, so the peak is +/-1 at every resolution.
 * `output` (for example an AudioBuffer channel) must hold lfsrFrameCount frames.
 */
export function generateLfsrTable(options: LfsrTableOptions, output?: Float32Array): Float32Array {
  const durationSec = options.durationSec ?? LFSR_TABLE_SEC;
  const bits = Math.round(Math.min(16, Math.max(1, options.bits)));
  const frames = lfsrFrameCount(options.sampleRate, durationSec);
  const updates = lfsrUpdateCount(options.sampleRate, options.clockHz, durationSec);
  const table = output ?? new Float32Array(frames);
  if (table.length !== frames) throw new Error(`LFSR table needs ${frames} frames.`);
  const scale = 2 / ((1 << bits) - 1);
  // Lfsr31.nextBits inlined (tests pin the two to the same sequence): this loop runs once per frame at Clock = sampleRate.
  let state = lfsrState(options.seed ?? DEFAULT_LFSR_SEED);
  const high = Math.min(bits, MAX_CHUNK), low = bits - high;
  const highMask = (1 << high) - 1, lowMask = (1 << low) - 1;
  let start = 0;
  for (let k = 0; k < updates; k += 1) {
    let chunk = ((state >>> (31 - high)) ^ (state >>> (13 - high))) & highMask;
    state = ((state << high) | chunk) & MASK31;
    let value = chunk;
    if (low > 0) {
      chunk = ((state >>> (31 - low)) ^ (state >>> (13 - low))) & lowMask;
      state = ((state << low) | chunk) & MASK31;
      value = (value << low) | chunk;
    }
    const level = value * scale - 1;
    const end = Math.floor((k + 1) * frames / updates);
    for (let i = start; i < end; i += 1) table[i] = level;
    start = end;
  }
  return table;
}
