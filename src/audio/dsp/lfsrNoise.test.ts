import { describe, expect, it } from 'vitest';
import { DEFAULT_LFSR_SEED, generateLfsrTable, Lfsr31, lfsrState, lfsrUpdateCount } from './lfsrNoise';

/** GF(2) polynomial product modulo p (degree 31), as BigInt bit vectors. */
function mulMod(a: bigint, b: bigint, p: bigint): bigint {
  let result = 0n;
  for (let x = a, y = b; y > 0n; y >>= 1n) {
    if (y & 1n) result ^= x;
    x <<= 1n;
    if (x >> 31n) x ^= p;
  }
  return result;
}

function changePoints(table: Float32Array): number[] {
  const points: number[] = [];
  for (let i = 1; i < table.length; i += 1) if (table[i] !== table[i - 1]) points.push(i);
  return points;
}

describe('31-bit LFSR', () => {
  it('inserts bit31 XOR bit13 and shifts left', () => {
    // Only bit 31 set: the first clock feeds back 1, later clocks follow the hand trace.
    const lfsr = new Lfsr31(0x4000_0000);
    expect(lfsr.nextBit()).toBe(1);
    expect(lfsr.value).toBe(1);
    // Only bit 13 set: feedback 1, then bit 13 moves to bit 14.
    const second = new Lfsr31(1 << 12);
    expect(second.nextBit()).toBe(1);
    expect(second.value).toBe((1 << 13) | 1);
    // Bits 31 and 13 both set cancel.
    const both = new Lfsr31(0x4000_0000 | (1 << 12));
    expect(both.nextBit()).toBe(0);
    expect(both.value).toBe(1 << 13);
  });

  it('produces the recurrence b[t] = b[t-31] ^ b[t-13]', () => {
    const lfsr = new Lfsr31(DEFAULT_LFSR_SEED);
    const bits = Array.from({ length: 4000 }, () => lfsr.nextBit());
    for (let t = 31; t < bits.length; t += 1) expect(bits[t]).toBe(bits[t - 31]! ^ bits[t - 13]!);
  });

  it('has a primitive characteristic polynomial, so the period is the maximum 2^31 - 1', () => {
    // x^31 + x^18 + 1, the recurrence above (reciprocal of the 909-style x^31 + x^13 + 1).
    // x^(2^31) = x mod p with p(0) = p(1) = 1 means p is irreducible of degree 31; as 2^31 - 1 is prime,
    // the order of x is 2^31 - 1, i.e. p is primitive and every nonzero state lies on one maximal cycle.
    const p = (1n << 31n) | (1n << 18n) | 1n;
    let x = 2n;
    for (let i = 0; i < 31; i += 1) x = mulMod(x, x, p);
    expect(x).toBe(2n);
    // Reciprocal check for the tap description itself.
    const reciprocal = (1n << 31n) | (1n << 13n) | 1n;
    let y = 2n;
    for (let i = 0; i < 31; i += 1) y = mulMod(y, y, reciprocal);
    expect(y).toBe(2n);
  });

  it('packs multi-bit reads identically to single clocks, first bit most significant', () => {
    for (const count of [1, 2, 4, 7, 8, 12, 13, 14, 16]) {
      const serial = new Lfsr31(0x2468_ace1);
      const block = new Lfsr31(0x2468_ace1);
      for (let n = 0; n < 500; n += 1) {
        let expected = 0;
        for (let i = 0; i < count; i += 1) expected = (expected << 1) | serial.nextBit();
        expect(block.nextBits(count)).toBe(expected);
        expect(block.value).toBe(serial.value);
      }
    }
  });

  it('avoids the all-zero state', () => {
    expect(lfsrState(0)).toBe(DEFAULT_LFSR_SEED);
    expect(lfsrState(2 ** 31)).toBe(DEFAULT_LFSR_SEED);
    expect(lfsrState(5)).toBe(5);
  });
});

describe('LFSR table', () => {
  const base = { sampleRate: 48_000, durationSec: 1 };

  it('regenerates the same table from the same seed', () => {
    const a = generateLfsrTable({ ...base, clockHz: 12_000, bits: 8, seed: 1234 });
    const b = generateLfsrTable({ ...base, clockHz: 12_000, bits: 8, seed: 1234 });
    const c = generateLfsrTable({ ...base, clockHz: 12_000, bits: 8, seed: 1235 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('outputs only +/-1 at 1 bit', () => {
    const table = generateLfsrTable({ ...base, clockHz: 48_000, bits: 1 });
    expect([...new Set(table)].sort()).toEqual([-1, 1]);
  });

  it('outputs 16 levels at 4 bits and stays within +/-1 at 16 bits', () => {
    const four = generateLfsrTable({ ...base, clockHz: 48_000, bits: 4 });
    const levels = [...new Set(four)].sort((a, b) => a - b);
    expect(levels).toHaveLength(16);
    expect(levels[0]).toBe(-1);
    expect(levels.at(-1)).toBe(1);
    levels.forEach((level, u) => expect(level).toBeCloseTo(2 * u / 15 - 1, 6));
    const sixteen = generateLfsrTable({ ...base, clockHz: 48_000, bits: 16 });
    expect(Math.max(...sixteen)).toBeLessThanOrEqual(1);
    expect(Math.min(...sixteen)).toBeGreaterThanOrEqual(-1);
    expect(new Set(sixteen).size).toBeGreaterThan(20_000);
  });

  it('holds each value for 10 samples at 4.8 kHz in a 48 kHz context', () => {
    const table = generateLfsrTable({ ...base, clockHz: 4_800, bits: 8 });
    const points = changePoints(table);
    expect(points.every(point => point % 10 === 0)).toBe(true);
    // Equal neighbours (1/256 per update) are the only missing boundaries.
    expect(points.length).toBeGreaterThan(4_800 * .98);
  });

  it('keeps the mean update rate for non-integer hold ratios', () => {
    for (const [sampleRate, clockHz] of [[44_100, 4_800], [48_000, 7_000], [44_100, 1_234.5], [96_000, 333]] as const) {
      const durationSec = 10;
      const updates = lfsrUpdateCount(sampleRate, clockHz, durationSec);
      expect(Math.abs(updates / durationSec - clockHz)).toBeLessThanOrEqual(.05);
      const table = generateLfsrTable({ sampleRate, clockHz, bits: 16, durationSec });
      // 16-bit values almost never repeat, so change points count the updates (minus the first value).
      const points = changePoints(table);
      expect(points.length).toBeGreaterThanOrEqual(updates - 1 - 3);
      expect(points.length).toBeLessThanOrEqual(updates - 1);
      // Every hold is floor or ceil of the exact ratio.
      const ratio = sampleRate * durationSec / updates;
      const holds = points.slice(1).map((point, index) => point - points[index]!);
      expect(holds.every(hold => hold >= Math.floor(ratio) && hold <= Math.ceil(ratio) * 2)).toBe(true);
    }
  });

  it('wraps the loop on an update boundary', () => {
    // 44.1 kHz / 4.8 kHz: the last hold ends exactly at the table end, so the seam is an ordinary update.
    const sampleRate = 44_100, clockHz = 4_800, durationSec = 10;
    const updates = lfsrUpdateCount(sampleRate, clockHz, durationSec);
    const frames = sampleRate * durationSec;
    const lastStart = Math.floor((updates - 1) * frames / updates);
    const table = generateLfsrTable({ sampleRate, clockHz, bits: 16, durationSec });
    const ratio = frames / updates;
    expect(frames - lastStart).toBeGreaterThanOrEqual(Math.floor(ratio));
    expect(frames - lastStart).toBeLessThanOrEqual(Math.ceil(ratio));
    expect(table.subarray(lastStart).every(value => value === table[lastStart])).toBe(true);
  });

  it('clocks the LFSR N times per value', () => {
    const table = generateLfsrTable({ sampleRate: 1_000, durationSec: 1, clockHz: 1_000, bits: 3, seed: 99 });
    const lfsr = new Lfsr31(99);
    for (let k = 0; k < 50; k += 1) expect(table[k]).toBeCloseTo(2 * lfsr.nextBits(3) / 7 - 1, 6);
  });
});
