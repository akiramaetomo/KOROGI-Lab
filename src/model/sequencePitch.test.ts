import { describe, expect, it } from 'vitest';
import {
  defaultAutoSequence,
  defaultSequenceSettings,
  normalizePitchRecording,
  normalizeSequenceSettings,
  pitchValueAt,
  quantizePitchValue,
  pitchPositions,
  simplifyPitchPoints
} from './sequencePitch';

describe('sequence pitch data boundary', () => {
  it('provides the accepted defaults and normalizes bounded settings', () => {
    expect(defaultAutoSequence()).toEqual({ pitchRecording: null, settings: defaultSequenceSettings() });
    expect(defaultSequenceSettings()).toEqual({
      pitchScaleCent: 1200, filterAmountCent: 0, filterAmountWide: false, pitchMode: { kind: 'smooth' }, recordSpeed: 1, playSpeed: 1
    });
    expect(normalizeSequenceSettings({ pitchScaleCent: 3000,
      pitchMode: { kind: 'stepped', stepsPerSide: 12, portamentoSec: 10 }, recordSpeed: .1, playSpeed: 8 })).toEqual({
      pitchScaleCent: 2400, filterAmountCent: 0, filterAmountWide: false,
      pitchMode: { kind: 'stepped', stepsPerSide: 12, scale: 'equal', portamentoSec: 5 }, recordSpeed: .25, playSpeed: 4
    });
    expect(() => normalizeSequenceSettings({ ...defaultSequenceSettings(), pitchMode: { kind: 'stepped', stepsPerSide: 25, portamentoSec: 0 } })).toThrow('pitch mode');
    // A negative Scale (inverted Pitch motion) is kept and bounded at −2400.
    expect(normalizeSequenceSettings({ ...defaultSequenceSettings(), pitchScaleCent: -1200 }).pitchScaleCent).toBe(-1200);
    expect(normalizeSequenceSettings({ ...defaultSequenceSettings(), pitchScaleCent: -3000 }).pitchScaleCent).toBe(-2400);
  });

  it('validates complete ordered pitch takes without changing performance data', () => {
    const take = { durationSec: 2, selectionStartSec: .25, selectionEndSec: 1.75,
      points: [{ timeSec: 0, valueNormalized: -.5 }, { timeSec: 1, valueNormalized: .25 }, { timeSec: 2, valueNormalized: 0 }] };
    expect(normalizePitchRecording(take)).toEqual(take);
    expect(() => normalizePitchRecording({ ...take, points: take.points.slice(1) })).toThrow('start and end');
    expect(() => normalizePitchRecording({ ...take, points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 0, valueNormalized: 1 }] })).toThrow('point');
    expect(() => normalizePitchRecording({ ...take, points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 2, valueNormalized: 1.01 }] })).toThrow('point');
  });

  it('quantizes around the center and simplifies a linear gesture without changing its curve', () => {
    expect(quantizePitchValue(.37, 4)).toBe(.25);
    expect(quantizePitchValue(-.9, 4)).toBe(-1);
    const points = [0, .5, 1, 1.5, 2].map(timeSec => ({ timeSec, valueNormalized: timeSec / 2 }));
    const simplified = simplifyPitchPoints(points);
    expect(simplified).toEqual([points[0], points.at(-1)]);
    for (const time of [.25, .75, 1.25, 1.75]) expect(pitchValueAt(simplified, time)).toBeCloseTo(time / 2, 12);
  });

  it('uses musical cent positions, mirrors them around the root, and keeps zero-step motion continuous', () => {
    expect(pitchPositions(7, 'major', 1200)).toEqual([-1, -11 / 12, -.75, -7 / 12, -5 / 12, -1 / 3, -1 / 6,
      0, 1 / 6, 1 / 3, 5 / 12, 7 / 12, .75, 11 / 12, 1]);
    expect(quantizePitchValue(.37, 7, 'major', 1200)).toBe(1 / 3);
    expect(quantizePitchValue(-.37, 7, 'major', 1200)).toBe(-1 / 3);
    expect(quantizePitchValue(.33, 7, 'just-major', 1200)).toBeCloseTo(Math.log2(5 / 4), 8);
    expect(quantizePitchValue(.37, 0, 'minor-blues', 1200)).toBe(.37);
    expect(quantizePitchValue(.37, 7, 'major', 0)).toBe(.37);
    // An inverting (negative) Scale uses the same symmetric normalized positions.
    expect(pitchPositions(7, 'major', -1200)).toEqual(pitchPositions(7, 'major', 1200));
    expect(quantizePitchValue(.37, 7, 'major', -1200)).toBe(1 / 3);
  });

  it('preserves legacy glides and validates the Wide filter range', () => {
    const base = defaultSequenceSettings();
    expect(normalizeSequenceSettings({ ...base, pitchMode: { kind: 'stepped', stepsPerSide: 2, portamentoSec: 4.5 } }).pitchMode)
      .toEqual({ kind: 'stepped', stepsPerSide: 2, scale: 'equal', portamentoSec: 4.5 });
    expect(normalizeSequenceSettings({ ...base, filterAmountCent: 7000, filterAmountWide: true }).filterAmountCent).toBe(7000);
    expect(normalizeSequenceSettings({ ...base, filterAmountCent: 7000, filterAmountWide: false }).filterAmountCent).toBe(4800);
  });
});
