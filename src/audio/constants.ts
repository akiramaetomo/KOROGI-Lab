import type { ChannelSettings, EffectSlotSettings } from './types';
import { PARAMETER_RANGES as P, parameterValueBounds } from '../config/parameterRanges';

export const PARAM_SMOOTH_SEC = 0.010;
export const STRUCTURE_FADE_SEC = 0.010;

export const LIMITS = {
  oscillatorHz: { min: 0.1, max: 20_000 },
  osc1Hz: parameterValueBounds(P['osc1-frequency']),
  osc2Hz: parameterValueBounds(P['osc2-frequency']),
  dutyRatio: { min: P['osc1-duty'].min / 100, max: P['osc1-duty'].max / 100 },
  pitchLevel: { min: P['penv-start'].min / 100, max: P['penv-start'].max / 100 },
  pitchTimeSec: { min: P['penv-attack-time'].min / 1000, max: P['penv-attack-time'].max / 1000 },
  pitchScale: { min: P['penv-scale'].min, max: P['penv-scale'].max },
  amDepth: { min: P['am-depth'].min / 100, max: P['am-depth'].max / 100 },
  amOffset: { min: P['am-offset'].min, max: P['am-offset'].max },
  fmDepthCent: { min: P['fm-depth'].min, max: P['fm-depth'].max },
  filterHz: { min: P['filter-frequency'].min, max: P['filter-frequency'].max },
  filterQ: { min: P['filter-q'].min, max: P['filter-q'].max },
  filter1CutoffDepthCent: { min: P['filter1-cutoff-depth'].min, max: P['filter1-cutoff-depth'].max },
  envelopeSec: { min: P.attack.min / 1000, max: P.attack.max / 1000 },
  filterEnvelopeAmount: { min: P['fenv-amount'].min, max: P['fenv-amount'].max },
  filterEnvelopeAttack: { min: P['fenv-attack'].min / 1000, max: P['fenv-attack'].max / 1000 },
  filterEnvelopeDecay: { min: P['fenv-decay'].min / 1000, max: P['fenv-decay'].max / 1000 },
  filterEnvelopeRelease: { min: P['fenv-release'].min / 1000, max: P['fenv-release'].max / 1000 },
  filterEnvelopeSustain: { min: P['fenv-sustain'].min, max: P['fenv-sustain'].max },
  sustain: { min: P.sustain.min, max: P.sustain.max },
  channelLevelDb: { min: P.level.min, max: P.level.max },
  detuneRangeCent: { min: P['detune-range'].min, max: P['detune-range'].max },
  triggerSec: { min: P.ton.min / 1000, max: P.ton.max / 1000 },
  triggerOffSec: { min: P.toff.min / 1000, max: P.toff.max / 1000 },
  burstCount: { min: P['burst-count-min'].min, max: P['burst-count-max'].max },
  burstPulseIntervalSec: { min: P['burst-pulse-interval'].min / 1000, max: P['burst-pulse-interval'].max / 1000 },
  burstJitter: { min: P['burst-pulse-jitter'].min / 100, max: P['burst-pulse-jitter'].max / 100 },
  burstGroupPeriodSec: { min: P['burst-group-period'].min / 1000, max: P['burst-group-period'].max / 1000 },
  effectWet: { min: P['fx-dist-wet'].min / 100, max: P['fx-dist-wet'].max / 100 },
  distortionDriveDb: { min: P['fx-dist-drive'].min, max: P['fx-dist-drive'].max },
  delaySec: { min: P['fx-delay-time'].min / 1000, max: P['fx-delay-time'].max / 1000 },
  delayFeedback: { min: P['fx-delay-feedback'].min / 100, max: P['fx-delay-feedback'].max / 100 },
  chorusRateHz: { min: P['fx-chorus-rate'].min, max: P['fx-chorus-rate'].max },
  chorusDepthSec: { min: P['fx-chorus-depth'].min / 1000, max: P['fx-chorus-depth'].max / 1000 },
  reverbDecaySec: { min: P['fx-reverb-decay'].min, max: P['fx-reverb-decay'].max },
  busGainDb: { min: P['bus-gain'].min, max: P['bus-gain'].max },
  masterGainDb: { min: P['master-gain'].min, max: P['master-gain'].max }
} as const;

export const DEFAULT_EFFECT_SLOT_SETTINGS: EffectSlotSettings = {
  enabled: false,
  type: 'distortion',
  distortionDriveDb: P['fx-dist-drive'].defaultValue,
  distortionWet: P['fx-dist-wet'].defaultValue / 100,
  delayTimeSec: P['fx-delay-time'].defaultValue / 1000,
  delayFeedback: P['fx-delay-feedback'].defaultValue / 100,
  delayWet: P['fx-delay-wet'].defaultValue / 100,
  chorusRateHz: P['fx-chorus-rate'].defaultValue,
  chorusDepthSec: P['fx-chorus-depth'].defaultValue / 1000,
  chorusWet: P['fx-chorus-wet'].defaultValue / 100,
  reverbDecaySec: P['fx-reverb-decay'].defaultValue,
  reverbWet: P['fx-reverb-wet'].defaultValue / 100
};

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  blocksEnabled: { osc1: true, osc2: true, penv: true, mod: false, filter1: false, filter2: false, aenv: true, fenv: false },
  phaseMode: 'sync',
  osc1: { sourceType: 'sine', baseFrequencyHz: P['osc1-frequency'].defaultValue, dutyRatio: P['osc1-duty'].defaultValue / 100 },
  osc2: { sourceType: 'sine', baseFrequencyHz: P['osc2-frequency'].defaultValue, dutyRatio: P['osc2-duty'].defaultValue / 100 },
  pitchEnvelope: { mode: 'gate', start: 0, attack: 0, sustain: 0, release: 0,
    attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'time' },
  mod: { mode: 'am', amDepth: P['am-depth'].defaultValue / 100, amOffset: P['am-offset'].defaultValue, fmDepthCent: P['fm-depth'].defaultValue },
  filter1: { type: 'lowpass', order: 2, frequencyHz: P['filter-frequency'].defaultValue, q: P['filter-q'].defaultValue },
  filter2: { type: 'lowpass', order: 2, frequencyHz: P['filter-frequency'].defaultValue, q: P['filter-q'].defaultValue },
  filter2Route: 'mod',
  filter1CutoffDepthCent: P['filter1-cutoff-depth'].defaultValue,
  ampEnvelope: { attackSec: P.attack.defaultValue / 1000, decaySec: P.decay.defaultValue / 1000, sustain: P.sustain.defaultValue, releaseSec: P.release.defaultValue / 1000,
    attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential', releaseTiming: 'time', mode: 'gate' },
  filterEnvelope: { attackSec: P['fenv-attack'].defaultValue / 1000, decaySec: P['fenv-decay'].defaultValue / 1000,
    sustain: P['fenv-sustain'].defaultValue, releaseSec: P['fenv-release'].defaultValue / 1000, amountCent: P['fenv-amount'].defaultValue,
    attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential', releaseTiming: 'time', mode: 'gate' },
  fx1: structuredClone(DEFAULT_EFFECT_SLOT_SETTINGS),
  autoTrigger: { tonSec: P.ton.defaultValue / 1000, repeatSec: P.trepeat.defaultValue / 1000 },
  burst: {
    enabled: false,
    pulseCountMin: P['burst-count-min'].defaultValue,
    pulseCountMax: P['burst-count-max'].defaultValue,
    pulseIntervalSec: P['burst-pulse-interval'].defaultValue / 1000,
    pulseIntervalJitter: P['burst-pulse-jitter'].defaultValue / 100,
    groupPeriodSec: P['burst-group-period'].defaultValue / 1000,
    groupPeriodJitter: P['burst-group-jitter'].defaultValue / 100
  }
};

// Fixed voice reference level before FX1; not a sound-design parameter.
export const VOICE_FX_INPUT_DB = -18;
