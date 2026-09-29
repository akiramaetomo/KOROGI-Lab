import type { EditorLayout } from '../model/editorLayout';
export type OscSourceType = 'sine' | 'sawtooth' | 'triangle' | 'square' | 'white-noise';
export type PhaseMode = 'sync' | 'free';
export type ModMode = 'off' | 'am' | 'fm';
export type Filter2Route = 'mod' | 'filter1-cutoff';
export type FilterType = 'off' | 'lowpass' | 'bandpass' | 'highpass';
export type FilterOrder = 2 | 4;
export type BusAssignment = 'near' | 'far';
export type EffectType = 'off' | 'distortion' | 'delay' | 'chorus' | 'reverb';
export type EffectSlotIndex = 1 | 2 | 3;
export type BusEffectSlotIndex = 2 | 3;
export type ChannelBlock = 'osc1' | 'osc2' | 'penv' | 'mod' | 'filter1' | 'filter2' | 'aenv' | 'fenv';

export interface OscillatorSettings {
  sourceType: OscSourceType;
  baseFrequencyHz: number;
  dutyRatio: number; // 0.01 .. 0.99; used by square only
}

export interface PitchEnvelopeSettings {
  mode: 'gate' | 'one-shot';
    curve: 'linear' | 'logarithmic';
  start: number; // P0, ratio relative to base frequency: -1 .. 1
  attack: number; // Pa
  sustain: number; // Ps
  release: number; // Pr
  attackSec: number;
  decaySec: number;
  releaseSec: number;
  scale: number; // 0 .. 1
  releaseTiming: ReleaseTiming;
}

export type ReleaseTiming = 'time' | 'rate';

export interface ModSettings {
  mode: ModMode;
  amDepth: number; // 0 .. 2
  amOffset: number; // 0 .. 2; 1 = conventional AM, 0 = ring modulation
  fmDepthCent: number; // 0 .. 4800
}

export interface FilterSettings {
  type: FilterType;
  order: FilterOrder;
  frequencyHz: number;
  q: number;
}

export interface ADSREnvelopeSettings {
  attackSec: number;
  decaySec: number;
  sustain: number;
  releaseSec: number;
  attackCurve?: EnvelopeCurve;
  decayCurve?: EnvelopeCurve;
  releaseCurve?: EnvelopeCurve;
  releaseTiming?: ReleaseTiming;
  mode?: 'gate' | 'one-shot';
}

export interface AmplitudeEnvelopeSettings extends ADSREnvelopeSettings {}
export interface FilterEnvelopeSettings extends ADSREnvelopeSettings { amountCent: number; amountWide: boolean; }

export type EnvelopeCurve = 'exponential' | 'linear';

/** Auto play repeats until explicitly stopped. */
export interface AutoTriggerSettings {
  tonSec: number;
  repeatSec: number;
}

/** Timbre articulation: repeat short AEnv One-shot pulse groups while an input Gate is held. */
export interface BurstSettings {
  enabled: boolean;
  pulseCountMin: number;
  pulseCountMax: number;
  pulseIntervalSec: number;
  pulseIntervalJitter: number;
  groupPeriodSec: number;
  groupPeriodJitter: number;
}

export interface ChannelSettings {
  blocksEnabled: Record<ChannelBlock, boolean>;
  phaseMode: PhaseMode;
  osc1: OscillatorSettings;
  osc2: OscillatorSettings;
  pitchEnvelope: PitchEnvelopeSettings;
  mod: ModSettings;
  filter1: FilterSettings;
  filter2: FilterSettings;
  filter2Route: Filter2Route;
  filter1CutoffDepthCent: number;
  ampEnvelope: AmplitudeEnvelopeSettings;
  filterEnvelope: FilterEnvelopeSettings;
  fx1: EffectSlotSettings;
  autoTrigger: AutoTriggerSettings;
  burst: BurstSettings;
}

export interface EffectSlotSettings {
  enabled: boolean;
  type: EffectType;
  distortionDriveDb: number;
  distortionWet: number;
  delayTimeSec: number;
  delayFeedback: number;
  delayWet: number;
  chorusRateHz: number;
  chorusDepthSec: number;
  chorusWet: number;
  reverbDecaySec: number;
  reverbWet: number;
}

export type EffectParameter = Exclude<keyof EffectSlotSettings, 'enabled' | 'type'>;

export interface BusSettings {
  gainEnabled: boolean;
  gainDb: number;
  effects: [EffectSlotSettings, EffectSlotSettings]; // FX2, FX3
}

export interface TimbreDocument {
  editorLayout: EditorLayout;
  formatVersion: 'KOROGI-Lab/timbre-v16';
  name: string;
  settings: ChannelSettings;
  detuneRangeCent: number;
  detuneNormalized: number;
  gatePatterns: GatePattern[];
  pitchPatterns: PitchPattern[];
  sequence: SequenceSelection;
}

export type UserPatternId = 'user-1' | 'user-2' | 'user-3';
export type PitchScaleMode = 'equal' | 'just-major' | 'major' | 'natural-minor' | 'dorian' | 'major-blues' | 'minor-blues';
export type PitchMode = { kind: 'smooth'; scale?: PitchScaleMode; portamentoSec?: number }
  | { kind: 'stepped'; stepsPerSide: number; portamentoSec: number; scale?: PitchScaleMode };
export interface SequenceSettings {
  pitchScaleCent: number;
  filterAmountCent: number;
  filterAmountWide: boolean;
  pitchMode: PitchMode;
  recordSpeed: number;
  playSpeed: number;
}
export interface PitchPoint { timeSec: number; valueNormalized: number }
export interface PitchRecording {
  durationSec: number;
  selectionStartSec: number;
  selectionEndSec: number;
  points: PitchPoint[];
}
export interface AutoSequence { pitchRecording: PitchRecording | null; settings: SequenceSettings }
export interface UserPattern {
  id: UserPatternId;
  gateRecording: TriggerRecording | null;
  pitchRecording: PitchRecording | null;
  settings: SequenceSettings;
}
export type PlaybackSource = { kind: 'auto' } | { kind: 'user'; patternId: UserPatternId };
export interface GatePattern { id: UserPatternId; recording: TriggerRecording | null; muted: boolean }
export interface PitchPattern { id: UserPatternId; recording: PitchRecording | null; muted: boolean; pitchMode: PitchMode; pitchScaleCent: number; filterAmountCent: number; filterAmountWide: boolean }
export interface SequenceSelection {
  gateMode: 'auto' | 'user'; gateUserId: UserPatternId; pitchUserId: UserPatternId;
  recordSpeed: number; playSpeed: number;
}
export type MasterInputMode = 'common-space' | 'fx1-direct';

export interface TriggerGate { onSec: number; offSec: number }
export interface TriggerRecording {
  durationSec: number;
  selectionStartSec: number;
  selectionEndSec: number;
  gates: TriggerGate[];
}

export interface ChannelMixSettings {
  gainDb: number;
  muted: boolean;
  balance: number; // 0 = Near, 1 = Far
  pan: number; // -1 = Left, 0 = Center, 1 = Right
}

export interface SessionChannel extends ChannelMixSettings {
  id: string;
  timbre: TimbreDocument | null;
}

/** The engine does not impose the Lab UI's four-slot limit. */
export interface SessionDocument {
  formatVersion: 'KOROGI-Lab/session-v17';
  name: string;
  savedAt: string;
  channels: SessionChannel[];
  near: BusSettings;
  far: BusSettings;
  crossfade: number;
  masterGainDb: number;
  masterMuted: boolean;
}

export type GateScheduleEvent =
  | { kind: 'on'; time: number }
  | { kind: 'off'; time: number }
  | { kind: 'cancel'; time: number }
  | { kind: 'reset'; time: number };
