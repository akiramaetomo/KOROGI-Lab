import { PARAMETER_RANGES, parameterValueBounds, type ParameterKey, type ParameterRange } from './parameterRanges';

/** Audited DSP envelope, independent of the author's PoC tuning values. */
const SAFETY: Record<ParameterKey, { min: number; max: number }> = {
  'osc1-frequency': { min: 1, max: 20_000 }, 'osc2-frequency': { min: .1, max: 20_000 },
  // PeriodicWave coefficients stay finite at these narrow pulse widths.
  'osc1-duty': { min: .5, max: 99.5 }, 'osc2-duty': { min: .5, max: 99.5 },
  'penv-start': { min: -100, max: 100 }, 'penv-attack-level': { min: -100, max: 100 },
  'penv-sustain-level': { min: -100, max: 100 }, 'penv-release-level': { min: -100, max: 100 },
  'penv-attack-time': { min: 0, max: 5_000 }, 'penv-decay-time': { min: 0, max: 5_000 },
  'penv-release-time': { min: 0, max: 5_000 }, 'penv-scale': { min: 0, max: 1 },
  'am-depth': { min: 0, max: 200 }, 'am-offset': { min: 0, max: 2 }, 'fm-depth': { min: 0, max: 4_800 },
  'filter-frequency': { min: .1, max: 20_000 }, 'filter-q': { min: .1, max: 30 },
  'filter1-cutoff-depth': { min: 0, max: 4_800 },
  attack: { min: 0, max: 5_000 }, decay: { min: 0, max: 5_000 }, sustain: { min: 0, max: 1 }, release: { min: 0, max: 5_000 },
  'fenv-amount': { min: -7_200, max: 7_200 },
  'fenv-attack': { min: 0, max: 5_000 }, 'fenv-decay': { min: 0, max: 5_000 },
  'fenv-sustain': { min: 0, max: 1 }, 'fenv-release': { min: 0, max: 5_000 },
  // 5 ms on/off yields at most ten event pairs in the 100 ms scheduler lookahead.
  ton: { min: 5, max: 10_000 }, trepeat: { min: 10, max: 10_000 }, toff: { min: 5, max: 10_000 },
  'burst-count-min': { min: 1, max: 8 }, 'burst-count-max': { min: 1, max: 8 },
  'burst-pulse-interval': { min: 5, max: 250 }, 'burst-pulse-jitter': { min: 0, max: 50 },
  'burst-group-period': { min: 10, max: 6_000 }, 'burst-group-jitter': { min: 0, max: 50 },
  'record-length': { min: 1, max: 300 },
  'sequence-filter-amount': { min: -7_200, max: 7_200 },
  'sequence-pitch-input': { min: -1, max: 1 }, 'sequence-pitch-scale': { min: 0, max: 2_400 },
  'sequence-pitch-steps': { min: 0, max: 24 }, 'sequence-portamento': { min: 0, max: 1_000 },
  'sequence-record-speed': { min: .25, max: 4 }, 'sequence-play-speed': { min: .25, max: 4 },
  // tanh waveshaping has bounded output even at 48 dB input drive.
  'fx-dist-drive': { min: 0, max: 48 }, 'fx-dist-wet': { min: 0, max: 100 },
  'fx-delay-time': { min: 1, max: 2_000 }, 'fx-delay-feedback': { min: 0, max: 95 }, 'fx-delay-wet': { min: 0, max: 100 },
  'fx-chorus-rate': { min: .05, max: 10 }, 'fx-chorus-depth': { min: 0, max: 10 }, 'fx-chorus-wet': { min: 0, max: 100 },
  'fx-reverb-decay': { min: .1, max: 10 }, 'fx-reverb-wet': { min: 0, max: 100 },
  'bus-gain': { min: -60, max: 6 }, crossfade: { min: 0, max: 100 }, 'master-gain': { min: -60, max: 0 },
  'detune-range': { min: 0, max: 100 }, level: { min: -60, max: 6 }, balance: { min: 0, max: 1 }, pan: { min: -1, max: 1 }
};

const SOURCE = 'src/config/parameterRanges.ts';
const fail = (key: string, field: string, reason: string): never => { throw new Error(`${SOURCE}: ${key}.${field}: ${reason}`); };

export function validateParameterRanges(ranges: Record<ParameterKey, ParameterRange> = PARAMETER_RANGES, sampleRate?: number): void {
  for (const key of Object.keys(SAFETY) as ParameterKey[]) {
    const value = ranges[key] as ParameterRange | undefined;
    if (!value || typeof value !== 'object') throw new Error(`${SOURCE}: ${key}: definition is missing`);
    for (const field of ['min', 'max', 'defaultValue', 'step'] as const) {
      if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) fail(key, field, 'must be a finite number');
    }
    if (value.min >= value.max) fail(key, 'max', 'must exceed min');
    if (value.step <= 0 || value.step > value.max - value.min) fail(key, 'step', 'must be positive and no larger than the span');
    if (value.defaultValue < value.min || value.defaultValue > value.max) fail(key, 'defaultValue', 'must lie within min and max');
    if (!['linear', 'log', 'log1p'].includes(value.scale)) fail(key, 'scale', 'must be linear, log or log1p');
    if (value.scale === 'log' && value.min <= 0) fail(key, 'min', 'must be positive for log scale');
    if (value.scale === 'log1p' && value.min < 0) fail(key, 'min', 'must be nonnegative for log1p scale');
    if (!['none', 'span-1-percent', 'ratio-10-percent', 'ratio-30-percent', 'ratio-50-percent', 'cent-100'].includes(value.fine)) fail(key, 'fine', 'unknown Fine mode');
    if ((value.fine.startsWith('ratio-') || value.fine === 'cent-100') && value.min <= 0) fail(key, 'min', 'must be positive for ratio Fine');
    if (value.axis !== 'horizontal' && value.axis !== 'vertical') fail(key, 'axis', 'must be horizontal or vertical');
    if (typeof value.unit !== 'string') fail(key, 'unit', 'must be a string');
    if (value.integer && ![value.min, value.max, value.defaultValue, value.step].every(Number.isInteger)) fail(key, 'integer', 'integer control requires integer bounds, default and step');
    if (value.coarseStep !== undefined && (!Number.isFinite(value.coarseStep) || value.coarseStep <= 0)) fail(key, 'coarseStep', 'must be positive and finite');
    if (value.min < SAFETY[key].min) fail(key, 'min', `below audited safety limit ${SAFETY[key].min}`);
    if (value.max > SAFETY[key].max) fail(key, 'max', `above audited safety limit ${SAFETY[key].max}`);
    for (const field of ['fineMin', 'fineMax'] as const) {
      if (value[field] === undefined) continue;
      if (key !== 'osc1-frequency' && key !== 'osc2-frequency') fail(key, field, 'separate value bounds are supported only for OSC frequency');
      if (!Number.isFinite(value[field])) fail(key, field, 'must be a finite number');
      if (value.integer && !Number.isInteger(value[field])) fail(key, field, 'must be an integer for an integer control');
    }
    const bounds = parameterValueBounds(value);
    if (bounds.min > value.min) fail(key, 'fineMin', 'must be no greater than Coarse min');
    if (bounds.max < value.max) fail(key, 'fineMax', 'must be no smaller than Coarse max');
    if (bounds.min < SAFETY[key].min) fail(key, 'fineMin', `below audited safety limit ${SAFETY[key].min}`);
    if (bounds.max > SAFETY[key].max) fail(key, 'fineMax', `above audited safety limit ${SAFETY[key].max}`);
  }
  if (ranges['fx-delay-feedback'].max >= 100) fail('fx-delay-feedback', 'max', 'feedback must remain below unity');
  for (const [shared, keys] of [
    ['osc1-duty', ['osc2-duty']], ['attack', ['decay', 'release']],
    ['fx-dist-wet', ['fx-delay-wet', 'fx-chorus-wet', 'fx-reverb-wet']]
  ] as const) {
    for (const key of keys) {
      if (ranges[key].min !== ranges[shared].min || ranges[key].max !== ranges[shared].max) {
        fail(key, 'min/max', `must match ${shared} while the DSP uses a shared limit`);
      }
    }
  }
  if (ranges.trepeat.min < ranges.ton.min + ranges.toff.min || ranges.trepeat.max > ranges.ton.min + ranges.toff.max)
    fail('trepeat', 'min/max', 'must permit a valid Ton and Toff throughout its range');
  if (ranges.trepeat.defaultValue !== ranges.ton.defaultValue + ranges.toff.defaultValue)
    fail('trepeat', 'defaultValue', 'must equal the default Ton plus Toff');
  if (sampleRate !== undefined) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`AudioContext.sampleRate: invalid ${sampleRate}`);
    const nyquistSafe = sampleRate * .5 * .999;
    for (const key of ['osc1-frequency', 'osc2-frequency', 'filter-frequency'] as const) {
      if (ranges[key].max > nyquistSafe) fail(key, 'max', `exceeds Nyquist-safe ${nyquistSafe.toFixed(1)} Hz at ${sampleRate} Hz sample rate`);
      if (parameterValueBounds(ranges[key]).max > nyquistSafe) fail(key, 'fineMax', `exceeds Nyquist-safe ${nyquistSafe.toFixed(1)} Hz at ${sampleRate} Hz sample rate`);
    }
    // A stereo Float32 impulse occupies 8 bytes per sample; leave a fixed PoC budget.
    const impulseBytes = Math.ceil(sampleRate * ranges['fx-reverb-decay'].max) * 8;
    if (impulseBytes > 8_000_000) fail('fx-reverb-decay', 'max', 'one stereo impulse exceeds the 8 MB PoC allocation budget');
  }
}
