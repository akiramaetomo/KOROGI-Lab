import { describe, expect, it } from 'vitest';
import { firstOrderCoefficients, firstOrderResponse } from './firstOrderFilter';

const FS = 48_000;
const db = ([re, im]: [number, number]) => 10 * Math.log10(re * re + im * im);
const deg = ([re, im]: [number, number]) => Math.atan2(im, re) * 180 / Math.PI;

describe('1st-order IIR sections', () => {
  it('meet -3 dB and +/-45 degrees at the prewarped cutoff, with unity pass band', () => {
    for (const cutoff of [20, 1_500, 8_000, 18_000]) {
      const hp = firstOrderCoefficients('highpass', cutoff, FS), lp = firstOrderCoefficients('lowpass', cutoff, FS);
      expect(db(firstOrderResponse(hp, cutoff, FS))).toBeCloseTo(-3.0103, 3);
      expect(db(firstOrderResponse(lp, cutoff, FS))).toBeCloseTo(-3.0103, 3);
      expect(deg(firstOrderResponse(hp, cutoff, FS))).toBeCloseTo(45, 3);
      expect(deg(firstOrderResponse(lp, cutoff, FS))).toBeCloseTo(-45, 3);
      expect(db(firstOrderResponse(hp, FS / 2 - 1e-6, FS))).toBeCloseTo(0, 3);
      expect(db(firstOrderResponse(lp, 1e-6, FS))).toBeCloseTo(0, 3);
    }
  });


  it('shelves reach the set gain at DC (low) or Nyquist (high), unity at the other end, and are flat at 0 dB', () => {
    for (const gainDb of [-24, -6, 6, 24]) {
      const low = firstOrderCoefficients('lowshelf', 1_000, FS, gainDb), high = firstOrderCoefficients('highshelf', 1_000, FS, gainDb);
      expect(db(firstOrderResponse(low, 1e-6, FS))).toBeCloseTo(gainDb, 3);
      expect(db(firstOrderResponse(low, FS / 2 - 1e-6, FS))).toBeCloseTo(0, 3);
      expect(db(firstOrderResponse(high, FS / 2 - 1e-6, FS))).toBeCloseTo(gainDb, 3);
      expect(db(firstOrderResponse(high, 1e-6, FS))).toBeCloseTo(0, 3);
      // At the corner (the pole), |H| = sqrt((1 + G^2) / 2) for the shelved side's gain G.
      const g = 10 ** (gainDb / 20), corner = 10 * Math.log10((1 + g * g) / 2);
      expect(db(firstOrderResponse(low, 1_000, FS))).toBeCloseTo(corner, 3);
      expect(db(firstOrderResponse(high, 1_000, FS))).toBeCloseTo(corner, 3);
    }
    for (const type of ['lowshelf', 'highshelf'] as const)
      for (const hz of [20, 1_000, 15_000]) expect(db(firstOrderResponse(firstOrderCoefficients(type, 2_000, FS, 0), hz, FS))).toBeCloseTo(0, 6);
  });
});
