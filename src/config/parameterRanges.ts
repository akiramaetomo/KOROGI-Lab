/**
 * PoC tuning surface. Edit the numbers here, then ask for a range audit.
 * Values are in the displayed units. `defaultValue` is the New/reset value.
 * `scale` maps slider position, `fine` maps its anchored second slider.
 * The independent safety envelope in parameterSafety.ts rejects unsafe edits.
 */
export interface ParameterRange {
  min: number;
  max: number;
  defaultValue: number;
  step: number;
  scale: 'linear' | 'log';
  fine: 'none' | 'span-1-percent' | 'ratio-10-percent' | 'ratio-30-percent' | 'ratio-50-percent' | 'cent-100';
  axis: 'horizontal' | 'vertical';
  unit: string;
  integer?: boolean;
  coarseStep?: number;
}

const horizontal = 'horizontal' as const;
const linear = 'linear' as const;
const log = 'log' as const;

export const PARAMETER_RANGES = {
  // Carrier Hz is intentionally integer; choose +/-10/30/50% Fine here.
  'osc1-frequency': { min: 20, max: 20_000, defaultValue: 4_000, step: 1, coarseStep: 10, scale: linear, fine: 'ratio-50-percent', axis: horizontal, unit: 'Hz', integer: true },
  // OSC2 modulator Hz spans two decades; log travel keeps the low end usable.
  'osc2-frequency': { min: 1, max: 1000, defaultValue: 30, step: .1, scale: log, fine: 'ratio-50-percent', axis: horizontal, unit: 'Hz' },
  // Pulse duty is percent (DSP uses /100); OSC1/2 bounds must currently match.
  'osc1-duty': { min: .5, max: 99.5, defaultValue: 50, step: .5, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  'osc2-duty': { min: .5, max: 99.5, defaultValue: 50, step: .5, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // PEnv amount is signed percent; below -100% would make the pitch ratio nonpositive.
  'penv-amount': { min: -10, max: 10, defaultValue: 0, step: .1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // PEnv transition time is displayed in ms and converted to seconds for DSP.
  'penv-time': { min: 1, max: 5_000, defaultValue: 50, step: 1, scale: log, fine: 'ratio-10-percent', axis: horizontal, unit: 'ms' },
  // AM depth is gain modulation in percent; >100% can invert the waveform.
  'am-depth': { min: 0, max: 200, defaultValue: 50, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // AM offset is unitless gain bias; zero permits ring modulation.
  'am-offset': { min: 0, max: 2, defaultValue: 1, step: .01, scale: linear, fine: 'none', axis: horizontal, unit: '' },
  // FM depth is pitch deviation in cents, not Hz or percent.
  'fm-depth': { min: 0, max: 4_800, defaultValue: 100, step: 1, scale: linear, fine: 'span-1-percent', axis: horizontal, unit: 'cent' },
  // Both filter frequencies use the same 1 Hz to 20 kHz band; max also depends on device Nyquist.
  'filter-frequency': { min: 1, max: 20_000, defaultValue: 1_000, step: .1, scale: log, fine: 'cent-100', axis: horizontal, unit: 'Hz' },
  // Filter Q controls resonance; high values can create pronounced peaks.
  'filter-q': { min: .1, max: 30, defaultValue: .707, step: .01, scale: linear, fine: 'none', axis: horizontal, unit: '' },
  // Filter2 signal shifts Filter1 cutoff by this many cents at a unit signal.
  'filter1-cutoff-depth': { min: 0, max: 4_800, defaultValue: 1_200, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: 'cent' },
  // AEnv times are ms, converted to seconds in DSP. Attack/decay/release bounds currently match.
  attack: { min: 1, max: 5_000, defaultValue: 5, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  decay: { min: 1, max: 5_000, defaultValue: 20, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  // Sustain is the held gain ratio, 0 for silence and 1 for full level.
  sustain: { min: 0, max: 1, defaultValue: .8, step: .01, scale: linear, fine: 'none', axis: horizontal, unit: '' },
  release: { min: 1, max: 5_000, defaultValue: 30, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  // The UI edits ON-to-ON period; saved documents retain Ton and Toff.
  ton: { min: 5, max: 3_000, defaultValue: 250, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  trepeat: { min: 10, max: 6_000, defaultValue: 500, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  toff: { min: 5, max: 5_995, defaultValue: 250, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  // BURST groups AEnv One-shot pulses. Jitter values are symmetric percentages.
  'burst-count-min': { min: 1, max: 8, defaultValue: 3, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '', integer: true },
  'burst-count-max': { min: 1, max: 8, defaultValue: 3, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '', integer: true },
  'burst-pulse-interval': { min: 5, max: 250, defaultValue: 25, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  'burst-pulse-jitter': { min: 0, max: 50, defaultValue: 0, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  'burst-group-period': { min: 10, max: 6_000, defaultValue: 100, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  'burst-group-jitter': { min: 0, max: 50, defaultValue: 0, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // Gate-recording length is an integer UI duration; file validation retains the fixed five-minute safety cap.
  'record-length': { min: 1, max: 300, defaultValue: 30, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: 's', integer: true },
  // All FX slots use these ranges. Wet percent is divided by 100; all Wet bounds currently match.
  // Distortion Drive in dB is pre-shaping gain, not post-FX channel level.
  'fx-dist-drive': { min: 0, max: 48, defaultValue: 12, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: 'dB' },
  'fx-dist-wet': { min: 0, max: 100, defaultValue: 50, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // Delay ms determines the allocated delay length; feedback must remain below 100%.
  'fx-delay-time': { min: 1, max: 2_000, defaultValue: 250, step: 1, scale: log, fine: 'none', axis: horizontal, unit: 'ms' },
  'fx-delay-feedback': { min: 0, max: 95, defaultValue: 30, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  'fx-delay-wet': { min: 0, max: 100, defaultValue: 25, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // Chorus rate is LFO Hz; depth is modulation of delay time in ms.
  'fx-chorus-rate': { min: .05, max: 10, defaultValue: .8, step: .01, scale: log, fine: 'none', axis: horizontal, unit: 'Hz' },
  'fx-chorus-depth': { min: 0, max: 10, defaultValue: 4, step: .1, scale: linear, fine: 'none', axis: horizontal, unit: 'ms' },
  'fx-chorus-wet': { min: 0, max: 100, defaultValue: 25, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // Reverb decay seconds scale the generated stereo impulse; memory use grows with sample rate.
  'fx-reverb-decay': { min: .1, max: 10, defaultValue: 1.5, step: .1, scale: log, fine: 'none', axis: horizontal, unit: 's' },
  'fx-reverb-wet': { min: 0, max: 100, defaultValue: 25, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // Bus Gain and per-voice Level are dB before the common crossfade/master path.
  'bus-gain': { min: -60, max: 6, defaultValue: 0, step: .1, scale: linear, fine: 'none', axis: horizontal, unit: 'dB' },
  // Crossfade is UI percent Far, converted to 0..1 for equal-power mixing.
  crossfade: { min: 0, max: 100, defaultValue: 50, step: 1, scale: linear, fine: 'none', axis: horizontal, unit: '%' },
  // Master Gain is dB ahead of the limiter; keep headroom in multi-voice use.
  'master-gain': { min: -60, max: 0, defaultValue: -18, step: .1, scale: linear, fine: 'none', axis: horizontal, unit: 'dB' },
  // Random detune span is cents around each stored voice offset.
  'detune-range': { min: 0, max: 100, defaultValue: 0, step: .1, scale: linear, fine: 'span-1-percent', axis: horizontal, unit: 'cent' },
  // All eight mixer strips use these same dB and Near/Far ratios.
  level: { min: -40, max: 0, defaultValue: 0, step: .1, scale: linear, fine: 'none', axis: horizontal, unit: 'dB' },
  balance: { min: 0, max: 1, defaultValue: .5, step: .01, scale: linear, fine: 'none', axis: horizontal, unit: '' },
  pan: { min: -1, max: 1, defaultValue: 0, step: .01, scale: linear, fine: 'none', axis: horizontal, unit: '' }
} satisfies Record<string, ParameterRange>;

export type ParameterKey = keyof typeof PARAMETER_RANGES;

export function parameterKeyForInput(id: string): ParameterKey | null {
  if (id === 'filter1-cutoff-depth') return id;
  const key = id.replace(/^fx[123]-/, 'fx-').replace(/^filter[12]-/, 'filter-')
    .replace(/^(near|far)-gain$/, 'bus-gain').replace(/^(level|balance|pan)-[1-4]$/, '$1');
  return Object.hasOwn(PARAMETER_RANGES, key) ? key as ParameterKey : null;
}

export function parameterForInput(id: string): ParameterRange | null {
  const key = parameterKeyForInput(id);
  return key ? PARAMETER_RANGES[key] : null;
}
