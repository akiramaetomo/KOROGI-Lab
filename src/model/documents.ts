import { DEFAULT_CHANNEL_SETTINGS, DEFAULT_EFFECT_SLOT_SETTINGS, LIMITS } from '../audio/constants';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { clamp } from '../audio/dsp/params';
import type { BusSettings, ChannelSettings, EffectSlotSettings, PlaybackSource, SessionDocument, TimbreDocument, UserPattern } from '../audio/types';
import { checkChoice, checkShape, isRecord } from './patch';
import { emptyUserPatterns, normalizeTriggerRecording, USER_PATTERN_IDS } from './triggerRecording';

export const DEFAULT_CHANNEL_MIX = { gainDb: P.level.defaultValue, muted: false, balance: P.balance.defaultValue, pan: P.pan.defaultValue };
export const LAB_SLOT_IDS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
export function defaultBus(): BusSettings {
  return { gainDb: P['bus-gain'].defaultValue, gainEnabled: true, effects: [
    { ...DEFAULT_EFFECT_SLOT_SETTINGS, type: 'chorus' }, { ...DEFAULT_EFFECT_SLOT_SETTINGS, type: 'reverb' }
  ] };
}
export function defaultTimbre(name = 'Standard'): TimbreDocument {
  return { formatVersion: 'KOROGI-Lab/timbre-v7', name, settings: structuredClone(DEFAULT_CHANNEL_SETTINGS), detuneRangeCent: P['detune-range'].defaultValue, detuneNormalized: 0, patterns: emptyUserPatterns(), playbackSource: { kind: 'auto' } };
}

function bounded(value: number, range: { min: number; max: number }): number {
  return clamp(value, range.min, range.max);
}

function effect(value: EffectSlotSettings, fallback: Exclude<EffectSlotSettings['type'], 'off'>): EffectSlotSettings {
  checkChoice(value.type, ['off', 'distortion', 'delay', 'chorus', 'reverb'], 'effect type');
  return {
    enabled: value.enabled && value.type !== 'off', type: value.type === 'off' ? fallback : value.type,
    distortionDriveDb: bounded(value.distortionDriveDb, LIMITS.distortionDriveDb),
    distortionWet: bounded(value.distortionWet, LIMITS.effectWet),
    delayTimeSec: bounded(value.delayTimeSec, LIMITS.delaySec),
    delayFeedback: bounded(value.delayFeedback, LIMITS.delayFeedback),
    delayWet: bounded(value.delayWet, LIMITS.effectWet),
    chorusRateHz: bounded(value.chorusRateHz, LIMITS.chorusRateHz),
    chorusDepthSec: bounded(value.chorusDepthSec, LIMITS.chorusDepthSec),
    chorusWet: bounded(value.chorusWet, LIMITS.effectWet),
    reverbDecaySec: bounded(value.reverbDecaySec, LIMITS.reverbDecaySec),
    reverbWet: bounded(value.reverbWet, LIMITS.effectWet)
  };
}

/** Pure boundary: reject invalid types/enums, normalize finite values, strip unknown fields. */
export function normalizeTimbre(raw: unknown): TimbreDocument {
  requireFormat(raw, ['KOROGI-Lab/timbre-v2', 'KOROGI-Lab/timbre-v3', 'KOROGI-Lab/timbre-v4', 'KOROGI-Lab/timbre-v5', 'KOROGI-Lab/timbre-v6', 'KOROGI-Lab/timbre-v7']);
  const rawRecord = raw as Record<string, unknown>;
  const format = rawRecord.formatVersion as string;
  const old = format === 'KOROGI-Lab/timbre-v2';
  const legacyPatterns = !['KOROGI-Lab/timbre-v6', 'KOROGI-Lab/timbre-v7'].includes(format);
  const legacyRecording = ['KOROGI-Lab/timbre-v4', 'KOROGI-Lab/timbre-v5'].includes(format) ? rawRecord.recording : null;
  const oldSource = rawRecord.playbackSource as Record<string, unknown> | undefined;
  let legacySource: PlaybackSource = { kind: 'auto' };
  if (format === 'KOROGI-Lab/timbre-v5') {
    if (oldSource?.kind === 'user' && oldSource.patternId === 'recording-1') legacySource = { kind: 'user', patternId: 'user-1' };
    else if (oldSource?.kind !== 'auto') throw new Error('Invalid playback source.');
  }
  const migratedPatterns = emptyUserPatterns();
  migratedPatterns[0]!.recording = legacyRecording as UserPattern['recording'];
  const sequenced = (legacyPatterns ? { ...rawRecord, patterns: migratedPatterns,
    playbackSource: legacySource,
    settings: { ...(rawRecord.settings as Record<string, unknown>), phaseMode: 'free',
      ...(old ? { filter2Route: 'mod', filter1CutoffDepthCent: P['filter1-cutoff-depth'].defaultValue } : {}) } } : rawRecord) as Record<string, unknown>;
  const value = { ...sequenced, formatVersion: 'KOROGI-Lab/timbre-v7', settings: {
    ...(sequenced.settings as Record<string, unknown>),
    burst: format === 'KOROGI-Lab/timbre-v7'
      ? (sequenced.settings as Record<string, unknown>).burst
      : structuredClone(DEFAULT_CHANNEL_SETTINGS.burst)
  } } as unknown as TimbreDocument;
  const rawEnvelope = value.settings?.ampEnvelope;
  const rawAuto = value.settings?.autoTrigger;
  const withCurves = { ...value, settings: { ...value.settings, ampEnvelope: {
    attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential', mode: 'gate', ...rawEnvelope
  }, autoTrigger: { oneShotRepeatSec: Math.min(P.trepeat.max / 1000,
    (rawAuto?.tonSec ?? 0) + (rawAuto?.toffSec ?? 0)), ...rawAuto } } } as TimbreDocument;
  if (!Array.isArray(withCurves.patterns) || withCurves.patterns.length !== USER_PATTERN_IDS.length) {
    throw new Error('User 1 and User 2 patterns are required.');
  }
  checkShape(withCurves, defaultTimbre(), 'timbre');
  const source = withCurves.playbackSource as PlaybackSource;
  if (source.kind === 'auto') checkShape(source, { kind: 'auto' }, 'playback source');
  else if (source.kind === 'user') { checkShape(source, { kind: 'user', patternId: 'user-1' }, 'playback source'); checkChoice(source.patternId, USER_PATTERN_IDS, 'pattern ID'); }
  else throw new Error('Invalid playback source.');
  const patternIds = new Set<string>();
  const patterns = withCurves.patterns.map(pattern => {
    checkChoice(pattern.id, USER_PATTERN_IDS, 'pattern ID');
    if (patternIds.has(pattern.id)) throw new Error('User pattern IDs must be unique.');
    patternIds.add(pattern.id);
    return { id: pattern.id, recording: normalizeTriggerRecording(pattern.recording) };
  });
  if (USER_PATTERN_IDS.some(id => !patternIds.has(id))) throw new Error('User 1 and User 2 patterns are required.');
  const ch = withCurves.settings;
  const oscillator = (osc: ChannelSettings['osc1'], range: typeof LIMITS.osc1Hz | typeof LIMITS.osc2Hz, integer: boolean) => {
    checkChoice(osc.sourceType, ['sine', 'sawtooth', 'triangle', 'square', 'white-noise'], 'oscillator source');
    const hz = bounded(osc.baseFrequencyHz, range);
    return { sourceType: osc.sourceType, baseFrequencyHz: integer ? Math.round(hz) : hz, dutyRatio: bounded(osc.dutyRatio, LIMITS.dutyRatio) };
  };
  const filter = (f: ChannelSettings['filter1']) => {
    checkChoice(f.type, ['off', 'lowpass', 'bandpass', 'highpass'], 'filter type');
    checkChoice(f.order, [2, 4], 'filter order');
    return { type: f.type === 'off' ? 'lowpass' as const : f.type, order: f.order, frequencyHz: bounded(f.frequencyHz, LIMITS.filterHz), q: bounded(f.q, LIMITS.filterQ) };
  };
  checkChoice(ch.mod.mode, ['off', 'am', 'fm'], 'MOD mode');
  checkChoice(ch.phaseMode, ['sync', 'free'], 'phase mode');
  checkChoice(ch.filter2Route, ['mod', 'filter1-cutoff'], 'FILTER2 route');
  for (const curve of ['attackCurve', 'decayCurve', 'releaseCurve'] as const) {
    checkChoice(ch.ampEnvelope[curve], ['exponential', 'linear'], `AEnv ${curve}`);
  }
  checkChoice(ch.ampEnvelope.mode, ['gate', 'one-shot'], 'AEnv mode');
  if (!Number.isInteger(ch.burst.pulseCountMin) || ch.burst.pulseCountMin < LIMITS.burstCount.min || ch.burst.pulseCountMin > LIMITS.burstCount.max ||
    !Number.isInteger(ch.burst.pulseCountMax) || ch.burst.pulseCountMax < LIMITS.burstCount.min || ch.burst.pulseCountMax > LIMITS.burstCount.max) {
    throw new Error('BURST pulse counts must be integers from 1 to 8.');
  }
  if (ch.burst.pulseCountMin > ch.burst.pulseCountMax) throw new Error('BURST minimum pulse count must not exceed maximum.');
  const burstRange = (value: number, range: { min: number; max: number }, label: string) => {
    if (value < range.min || value > range.max) throw new Error(`BURST ${label} is outside its supported range.`);
    return value;
  };
  const blocksEnabled = Object.fromEntries(Object.keys(DEFAULT_CHANNEL_SETTINGS.blocksEnabled).map(key => [key, ch.blocksEnabled[key as keyof typeof ch.blocksEnabled]])) as ChannelSettings['blocksEnabled'];
  if (ch.mod.mode === 'off') blocksEnabled.mod = false;
  if (ch.filter1.type === 'off') blocksEnabled.filter1 = false;
  if (ch.filter2.type === 'off') blocksEnabled.filter2 = false;
  const settings: ChannelSettings = {
    blocksEnabled,
    phaseMode: ch.phaseMode,
    osc1: oscillator(ch.osc1, LIMITS.osc1Hz, true), osc2: oscillator(ch.osc2, LIMITS.osc2Hz, false),
    pitchEnvelope: { amount: bounded(ch.pitchEnvelope.amount, LIMITS.pitchAmount), transitionTimeSec: bounded(ch.pitchEnvelope.transitionTimeSec, LIMITS.pitchTransitionSec) },
    mod: { mode: ch.mod.mode === 'off' ? 'am' : ch.mod.mode, amDepth: bounded(ch.mod.amDepth, LIMITS.amDepth), amOffset: bounded(ch.mod.amOffset, LIMITS.amOffset), fmDepthCent: bounded(ch.mod.fmDepthCent, LIMITS.fmDepthCent) },
    filter1: filter(ch.filter1), filter2: filter(ch.filter2),
    filter2Route: ch.filter2Route, filter1CutoffDepthCent: bounded(ch.filter1CutoffDepthCent, LIMITS.filter1CutoffDepthCent),
    ampEnvelope: {
      attackSec: bounded(ch.ampEnvelope.attackSec, LIMITS.envelopeSec), decaySec: bounded(ch.ampEnvelope.decaySec, LIMITS.envelopeSec),
      sustain: bounded(ch.ampEnvelope.sustain, LIMITS.sustain), releaseSec: bounded(ch.ampEnvelope.releaseSec, LIMITS.envelopeSec),
      attackCurve: ch.ampEnvelope.attackCurve, decayCurve: ch.ampEnvelope.decayCurve, releaseCurve: ch.ampEnvelope.releaseCurve, mode: ch.ampEnvelope.mode
    },
    fx1: effect(ch.fx1, 'distortion'),
    autoTrigger: { tonSec: bounded(ch.autoTrigger.tonSec, LIMITS.triggerSec), toffSec: bounded(ch.autoTrigger.toffSec, LIMITS.triggerOffSec),
      oneShotRepeatSec: bounded(ch.autoTrigger.oneShotRepeatSec!, { min: P.trepeat.min / 1000, max: P.trepeat.max / 1000 }) },
    burst: {
      enabled: ch.ampEnvelope.mode === 'one-shot' && ch.burst.enabled,
      pulseCountMin: ch.burst.pulseCountMin,
      pulseCountMax: ch.burst.pulseCountMax,
      pulseIntervalSec: burstRange(ch.burst.pulseIntervalSec, LIMITS.burstPulseIntervalSec, 'pulse interval'),
      pulseIntervalJitter: burstRange(ch.burst.pulseIntervalJitter, LIMITS.burstJitter, 'pulse jitter'),
      groupPeriodSec: burstRange(ch.burst.groupPeriodSec, LIMITS.burstGroupPeriodSec, 'group period'),
      groupPeriodJitter: burstRange(ch.burst.groupPeriodJitter, LIMITS.burstJitter, 'group jitter')
    }
  };
  return { formatVersion: 'KOROGI-Lab/timbre-v7', name: value.name.trim() || 'Untitled', settings,
    detuneRangeCent: bounded(value.detuneRangeCent, LIMITS.detuneRangeCent), detuneNormalized: clamp(value.detuneNormalized, -1, 1),
    patterns, playbackSource: structuredClone(source) };
}

export function normalizeSession(raw: unknown): SessionDocument {
  requireFormat(raw, ['KOROGI-Lab/session-v2', 'KOROGI-Lab/session-v3', 'KOROGI-Lab/session-v4', 'KOROGI-Lab/session-v5', 'KOROGI-Lab/session-v6', 'KOROGI-Lab/session-v7', 'KOROGI-Lab/session-v8']);
  if (!isRecord(raw) || !Array.isArray(raw.channels)) throw new Error('Session channels must be an array.');
  checkShape(raw, { formatVersion: '', name: '', savedAt: '', near: defaultBus(), far: defaultBus(), crossfade: 0, masterGainDb: 0, masterMuted: false }, 'session');
  const value = raw as unknown as SessionDocument;
  const legacyPan = !['KOROGI-Lab/session-v5', 'KOROGI-Lab/session-v6', 'KOROGI-Lab/session-v7', 'KOROGI-Lab/session-v8'].includes(value.formatVersion);
  const ids = new Set<string>();
  const channels = value.channels.map(channel => {
    const withPan = legacyPan ? { ...channel, pan: P.pan.defaultValue } : channel;
    checkShape(withPan, { id: '', ...DEFAULT_CHANNEL_MIX }, 'channel');
    if (!channel.id.trim() || ids.has(channel.id)) throw new Error('Channel IDs must be nonempty and unique.');
    ids.add(channel.id);
    return { id: channel.id, gainDb: bounded(channel.gainDb, LIMITS.channelLevelDb), muted: channel.muted, balance: clamp(channel.balance, P.balance.min, P.balance.max), pan: clamp(withPan.pan, P.pan.min, P.pan.max),
      timbre: channel.timbre === null ? null : normalizeTimbre(channel.timbre) };
  });
  const bus = (b: BusSettings): BusSettings => ({ gainEnabled: b.gainEnabled, gainDb: bounded(b.gainDb, LIMITS.busGainDb), effects: [effect(b.effects[0], 'chorus'), effect(b.effects[1], 'reverb')] });
  return { formatVersion: 'KOROGI-Lab/session-v8', name: value.name.trim() || 'Untitled', savedAt: value.savedAt,
    channels, near: bus(value.near), far: bus(value.far), crossfade: clamp(value.crossfade, P.crossfade.min / 100, P.crossfade.max / 100), masterGainDb: bounded(value.masterGainDb, LIMITS.masterGainDb), masterMuted: value.masterMuted };
}

function requireFormat(raw: unknown, accepted: readonly string[]): void {
  if (!isRecord(raw) || !accepted.includes(raw.formatVersion as string)) {
    throw new Error(`Unsupported file format: ${accepted.join(' or ')} required. v1 and legacy v4 are not supported because TIMBRE input is now fixed at -18 dB.`);
  }
}

export function parseTimbre(text: string): TimbreDocument {
  return normalizeTimbre(JSON.parse(text));
}

export function parseSession(text: string): SessionDocument {
  return normalizeSession(JSON.parse(text));
}
/** Lab-specific topology validation; the audio engine accepts other channel counts. */
export function parseLabSession(text: string): SessionDocument {
  const session = parseSession(text);
  const ids = session.channels.map(channel => channel.id);
  const isFour = ids.length === 4 && LAB_SLOT_IDS.slice(0, 4).every(id => ids.includes(id));
  const isEight = ids.length === 8 && LAB_SLOT_IDS.every(id => ids.includes(id));
  if (!isFour && !isEight) {
    throw new Error('Lab sessions require slots 1–4 or 1–8 with no gaps.');
  }
  if (isFour) for (const id of LAB_SLOT_IDS.slice(4)) session.channels.push({ id, ...DEFAULT_CHANNEL_MIX, timbre: null });
  session.channels.sort((a, b) => Number(a.id) - Number(b.id));
  return session;
}
