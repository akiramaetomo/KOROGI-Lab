import { describe, expect, it } from 'vitest';
import { PARAMETER_RANGES, parameterForInput, parameterValueBounds, type ParameterKey, type ParameterRange } from './parameterRanges';
import { validateParameterRanges } from './parameterSafety';
import { LIMITS } from '../audio/constants';
import { defaultBus, defaultTimbre, normalizeTimbre, normalizeSession, DEFAULT_CHANNEL_MIX, LAB_SLOT_IDS } from '../model/documents';

const copy = (): Record<ParameterKey, ParameterRange> => structuredClone(PARAMETER_RANGES);

describe('author-edited parameter ranges', () => {
  it('audits independent FEnv ranges and maps controls without sharing AEnv definitions', () => {
    for (const phase of ['attack', 'decay', 'sustain', 'release'] as const) {
      expect(parameterForInput(`fenv-${phase}`)).toBe(PARAMETER_RANGES[`fenv-${phase}`]);
      expect(PARAMETER_RANGES[`fenv-${phase}`]).not.toBe(PARAMETER_RANGES[phase]);
    }
    const ranges = copy(); ranges['fenv-amount'].min = -7201;
    expect(() => validateParameterRanges(ranges)).toThrow('fenv-amount.min');
    ranges['fenv-amount'].min = -7200; ranges['fenv-release'].max = 5001;
    expect(() => validateParameterRanges(ranges)).toThrow('fenv-release.max');
  });
  it('accepts the current values and a safe PoC tuning change', () => {
    expect(() => validateParameterRanges(PARAMETER_RANGES, 44_100)).not.toThrow();
    expect(() => validateParameterRanges(PARAMETER_RANGES, 48_000)).not.toThrow();
    expect(PARAMETER_RANGES['osc1-duty'].min).toBe(.5);
    expect(PARAMETER_RANGES.ton.min).toBe(5);
    expect(PARAMETER_RANGES['fx-dist-drive'].max).toBe(48);
    expect(PARAMETER_RANGES['master-gain'].min).toBe(-60);
    expect(PARAMETER_RANGES['osc1-frequency'].fine).toBe('ratio-50-percent');
    expect(parameterValueBounds(PARAMETER_RANGES['osc1-frequency']).max).toBe(20_000);
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
    const ranges = copy();
    ranges['osc1-frequency'].max = 10_000;
    expect(() => validateParameterRanges(ranges, 32_000)).toThrow('osc1-frequency.fineMax: exceeds Nyquist-safe');
  });

  it('shares the independent OSC1 value bounds between UI, DSP and imported timbres', () => {
    expect(parameterForInput('osc1-frequency')).toBe(PARAMETER_RANGES['osc1-frequency']);
    expect(LIMITS.osc1Hz).toEqual({ min: 1, max: 20_000 });
    const timbre = defaultTimbre();
    timbre.settings.osc1.baseFrequencyHz = 20_000;
    expect(normalizeTimbre(timbre).settings.osc1.baseFrequencyHz).toBe(20_000);
    timbre.settings.osc1.baseFrequencyHz = 20_001;
    expect(normalizeTimbre(timbre).settings.osc1.baseFrequencyHz).toBe(20_000);
  });

  it('keeps frequencies outside Coarse through timbre and session round trips', () => {
    for (const [osc1, osc2] of [[5, .5], [15_000, 1500]] as const) {
      const timbre = defaultTimbre();
      timbre.settings.osc1.baseFrequencyHz = osc1;
      timbre.settings.osc2.baseFrequencyHz = osc2;
      expect(normalizeTimbre(JSON.parse(JSON.stringify(timbre))).settings).toEqual(timbre.settings);
      const session = { formatVersion: 'KOROGI-Lab/session-v13', name: 'Fine', savedAt: '2026-09-27',
        channels: LAB_SLOT_IDS.map(id => ({ id, ...DEFAULT_CHANNEL_MIX, timbre: id === '1' ? timbre : null })),
        near: defaultBus(), far: defaultBus(), crossfade: .5, masterGainDb: -18, masterMuted: false };
      expect(normalizeSession(JSON.parse(JSON.stringify(session))).channels[0]!.timbre?.settings).toEqual(timbre.settings);
    }
  });

  it('audits the independent Fine bounds and requires them to contain Coarse', () => {
    const ranges = copy();
    ranges['osc1-frequency'].fineMin = 0;
    expect(() => validateParameterRanges(ranges)).toThrow('osc1-frequency.fineMin: below audited safety limit');
    ranges['osc1-frequency'].fineMin = ranges['osc1-frequency'].min + 1;
    expect(() => validateParameterRanges(ranges)).toThrow('osc1-frequency.fineMin: must be no greater');
    ranges['osc1-frequency'].fineMin = 1;
    ranges['osc1-frequency'].fineMax = 30_000;
    expect(() => validateParameterRanges(ranges)).toThrow('osc1-frequency.fineMax: above audited safety limit');
    ranges['osc1-frequency'].fineMax = Number.NaN;
    expect(() => validateParameterRanges(ranges)).toThrow('osc1-frequency.fineMax: must be a finite number');
    ranges['osc1-frequency'].fineMax = ranges['osc1-frequency'].max - 1;
    expect(() => validateParameterRanges(ranges)).toThrow('osc1-frequency.fineMax: must be no smaller');
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
