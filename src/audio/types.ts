import type { EditorLayout } from '../model/editorLayout';
export type OscSourceType = 'sine' | 'sawtooth' | 'triangle' | 'square' | 'white-noise';
export type PhaseMode = 'sync' | 'free';
export type ModMode = 'off' | 'am' | 'fm';
/** OSC2/FILTER2 destination: control (MOD, F1 CUTOFF) or audio mixed at the AEnv1 input / output. */
export type Filter2Route = 'mod' | 'filter1-cutoff' | 'aenv-in' | 'aenv-out';
export type FilterType = 'off' | 'lowpass' | 'bandpass' | 'highpass';
export type FilterOrder = 2 | 4;
export type BusAssignment = 'near' | 'far';
export type EffectType = 'off' | 'distortion' | 'delay' | 'chorus' | 'reverb';
export type EffectSlotIndex = 1 | 2 | 3;
export type BusEffectSlotIndex = 2 | 3;
export type ChannelBlock = 'osc1' | 'osc2' | 'penv' | 'mod' | 'filter1' | 'filter2' | 'aenv' | 'aenv2' | 'fenv';

export type OscVoiceMode = 'single' | 'multi';
export type MultiDefinition = 'table' | 'spread';
/** One internal oscillator of Multi: frequency ratio to the OSC Base Frequency and linear gain. */
export interface OscPartial { ratio: number; amplitude: number }
export interface MultiOscillatorSettings {
  definition: MultiDefinition;
  partials: OscPartial[]; // Table definition, 1 .. 16 rows
  spread: { count: number; spreadCent: number }; // symmetric, equally spaced, gain 1/N each
}

export interface OscillatorSettings {
  sourceType: OscSourceType;
  baseFrequencyHz: number;
  dutyRatio: number; // 0.01 .. 0.99; used by square only
  voiceMode: OscVoiceMode; // Multi sums partials of the same waveform; white noise stays single
  multi: MultiOscillatorSettings;
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
  /** OSC1/OSC2 path balance for the audio routes, -1 (OSC1 only) .. 0 (both unity) .. +1 (OSC2 only). */
  oscBalance: number;
  /** Shared FEnv applied to Filter2 as a signed ratio of the FEnv Amount, -1..+1. */
  filter2FenvDepth: number;
  ampEnvelope: AmplitudeEnvelopeSettings;
  /** OSC2 path envelope; sounds only in the AEnv OUT route. */
  ampEnvelope2: AmplitudeEnvelopeSettings;
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
  formatVersion: 'KOROGI-Lab/timbre-v20';
  name: string;
  settings: ChannelSettings;
  detuneRangeCent: number;
  detuneNormalized: number;
  gatePatterns: GatePattern[];
  pitchPatterns: PitchPattern[];
  patternBars: PatternBars;
  sequence: SequenceSelection;
}

export type UserPatternId = 'user-1' | 'user-2' | 'user-3' | 'user-4' | 'user-5' | 'user-6' | 'user-7' | 'user-8';
/** Bars of each Pattern number of one timbre (1/16 to 32): its loop length under Bars (ADR 0011). */
export type PatternBars = [number, number, number, number, number, number, number, number];
/** `frameBars` is the SongFrame: every Song section's length and the Play All restart period under Bars (ADR 0011). */
export interface SongSettings { bpm: number; speed: number; frameBars: number; timingMode: 'original' | 'bars' }
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
/** `inSong` lets Song play or rest this timbre at the Pattern number; Play and Play All ignore it. */
export interface GatePattern { id: UserPatternId; recording: TriggerRecording | null; muted: boolean; inSong: boolean }
export interface PitchPattern { id: UserPatternId; recording: PitchRecording | null; muted: boolean; pitchMode: PitchMode; pitchScaleCent: number; filterAmountCent: number; filterAmountWide: boolean }
export interface SequenceSelection {
  gateMode: 'auto' | 'user'; gateUserId: UserPatternId; pitchUserId: UserPatternId;
  recordSpeed: number; playSpeed: number;
  /** Play All / Play: fit the selection to its Pattern's bars at the Session BPM (Gate Pattern first). */
  stretch: boolean;
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
  formatVersion: 'KOROGI-Lab/session-v23';
  name: string;
  savedAt: string;
  channels: SessionChannel[];
  near: BusSettings;
  far: BusSettings;
  crossfade: number;
  masterGainDb: number;
  masterMuted: boolean;
  song: SongSettings;
}

export type GateScheduleEvent =
  | { kind: 'on'; time: number }
  | { kind: 'off'; time: number }
  | { kind: 'cancel'; time: number }
  | { kind: 'reset'; time: number };
