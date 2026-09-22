import { describe, expect, it } from 'vitest';
import { PARAMETER_RANGES, parameterForInput, type ParameterKey, type ParameterRange } from './parameterRanges';
import { validateParameterRanges } from './parameterSafety';
import { LIMITS } from '../audio/constants';
import { defaultTimbre, normalizeTimbre } from '../model/documents';

const copy = (): Record<ParameterKey, ParameterRange> => structuredClone(PARAMETER_RANGES);

describe('author-edited parameter ranges', () => {
  it('accepts the current values and a safe PoC tuning change', () => {
    expect(() => validateParameterRanges(PARAMETER_RANGES, 44_100)).not.toThrow();
    expect(() => validateParameterRanges(PARAMETER_RANGES, 48_000)).not.toThrow();
    expect(PARAMETER_RANGES['osc1-duty'].min).toBe(.5);
    expect(PARAMETER_RANGES.ton.min).toBe(5);
    expect(PARAMETER_RANGES['fx-dist-drive'].max).toBe(48);
    expect(PARAMETER_RANGES['master-gain'].min).toBe(-60);
    expect(PARAMETER_RANGES['osc1-frequency'].fine).toBe('ratio-50-percent');
    expect(PARAMETER_RANGES['osc1-frequency'].max).toBe(20_000);
    expect(PARAMETER_RANGES['osc2-frequency'].fine).toBe('ratio-50-percent');
    expect(parameterForInput('pan-1')).toBe(PARAMETER_RANGES.pan);
    for (const mode of ['ratio-10-percent', 'ratio-30-percent', 'ratio-50-percent'] as const) {
      const selectable = copy();
      selectable['osc1-frequency'].fine = mode;
      selectable['osc2-frequency'].fine = mode;
      expect(() => validateParameterRanges(selectable, 48_000)).not.toThrow();
    }
    const ranges = copy();
    ranges['osc2-frequency'].max = 80;
    expect(() => validateParameterRanges(ranges, 48_000)).not.toThrow();
  });

  it('reports the source, entry and field for invalid edits', () => {
    const ranges = copy();
    ranges['filter-frequency'].min = Number.NaN;
    expect(() => validateParameterRanges(ranges)).toThrow('src/config/parameterRanges.ts: filter-frequency.min: must be a finite number');
    ranges['filter-frequency'].min = 20;
    ranges['fx-delay-time'].max = 20_000;
    expect(() => validateParameterRanges(ranges)).toThrow('fx-delay-time.max: above audited safety limit');
  });

  it('rejects a device-dependent Nyquist conflict', () => {
    expect(() => validateParameterRanges(PARAMETER_RANGES, 32_000)).toThrow('osc1-frequency.max: exceeds Nyquist-safe');
  });

  it('shares the OSC1 endpoint between UI, DSP and imported timbres', () => {
    expect(parameterForInput('osc1-frequency')).toBe(PARAMETER_RANGES['osc1-frequency']);
    expect(LIMITS.osc1Hz).toEqual({ min: 20, max: 20_000 });
    const timbre = defaultTimbre();
    timbre.settings.osc1.baseFrequencyHz = 20_000;
    expect(normalizeTimbre(timbre).settings.osc1.baseFrequencyHz).toBe(20_000);
    timbre.settings.osc1.baseFrequencyHz = 20_001;
    expect(normalizeTimbre(timbre).settings.osc1.baseFrequencyHz).toBe(20_000);
  });

  it('uses the same filter band in UI lookup, defaults and import normalization', () => {
    expect(parameterForInput('filter1-frequency')).toBe(PARAMETER_RANGES['filter-frequency']);
    expect(parameterForInput('filter2-frequency')).toBe(PARAMETER_RANGES['filter-frequency']);
    expect(LIMITS.filterHz).toEqual({ min: PARAMETER_RANGES['filter-frequency'].min, max: PARAMETER_RANGES['filter-frequency'].max });
    const timbre = defaultTimbre();
    expect(timbre.settings.filter1.frequencyHz).toBe(PARAMETER_RANGES['filter-frequency'].defaultValue);
    timbre.settings.filter1.frequencyHz = 0;
    expect(normalizeTimbre(timbre).settings.filter1.frequencyHz).toBe(PARAMETER_RANGES['filter-frequency'].min);
  });
});
