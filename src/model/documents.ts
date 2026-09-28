import { DEFAULT_EDITOR_LAYOUT, normalizeEditorLayout } from './editorLayout';
import { DEFAULT_CHANNEL_SETTINGS, DEFAULT_EFFECT_SLOT_SETTINGS, LIMITS } from '../audio/constants';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { clamp } from '../audio/dsp/params';
import type { BusSettings, ChannelSettings, EffectSlotSettings, PlaybackSource, SessionDocument, TimbreDocument, UserPattern, UserPatternId } from '../audio/types';
import { checkChoice, checkShape, isRecord } from './patch';
import { emptyGatePatterns, emptyPitchPatterns, LEGACY_USER_PATTERN_IDS, normalizeTriggerRecording, USER_PATTERN_IDS } from './triggerRecording';
import { defaultAutoSequence, defaultSequenceSettings, normalizePitchRecording, normalizeSequenceSettings } from './sequencePitch';

export const DEFAULT_CHANNEL_MIX = { gainDb: P.level.defaultValue, muted: false, balance: P.balance.defaultValue, pan: P.pan.defaultValue };
export const LAB_SLOT_IDS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
export function defaultBus(): BusSettings {
  return { gainDb: P['bus-gain'].defaultValue, gainEnabled: true, effects: [
    { ...DEFAULT_EFFECT_SLOT_SETTINGS, type: 'chorus' }, { ...DEFAULT_EFFECT_SLOT_SETTINGS, type: 'reverb' }
  ] };
}
export function defaultTimbre(name = 'Standard'): TimbreDocument {
  return { formatVersion: 'KOROGI-Lab/timbre-v15', name, editorLayout: DEFAULT_EDITOR_LAYOUT.map(column => [...column]), settings: structuredClone(DEFAULT_CHANNEL_SETTINGS), detuneRangeCent: P['detune-range'].defaultValue, detuneNormalized: 0,
    gatePatterns: emptyGatePatterns(), pitchPatterns: emptyPitchPatterns(), sequence: {
      gateMode: 'auto', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1
    } };
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
  requireFormat(raw, ['KOROGI-Lab/timbre-v2', 'KOROGI-Lab/timbre-v3', 'KOROGI-Lab/timbre-v4', 'KOROGI-Lab/timbre-v5', 'KOROGI-Lab/timbre-v6', 'KOROGI-Lab/timbre-v7', 'KOROGI-Lab/timbre-v8', 'KOROGI-Lab/timbre-v9', 'KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15']);
  const rawRecord = raw as Record<string, unknown>;
  const format = rawRecord.formatVersion as string;
  const modern = ['KOROGI-Lab/timbre-v9', 'KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15'].includes(format);
  const newEnvelope = ['KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15'].includes(format);
  const independentEnvelope = ['KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15'].includes(format);
  const old = format === 'KOROGI-Lab/timbre-v2';
  const legacyPatterns = !modern && !['KOROGI-Lab/timbre-v6', 'KOROGI-Lab/timbre-v7', 'KOROGI-Lab/timbre-v8'].includes(format);
  const legacyRecording = ['KOROGI-Lab/timbre-v4', 'KOROGI-Lab/timbre-v5'].includes(format) ? rawRecord.recording : null;
  const oldSource = rawRecord.playbackSource as Record<string, unknown> | undefined;
  let legacySource: PlaybackSource = { kind: 'auto' };
  if (format === 'KOROGI-Lab/timbre-v5') {
    if (oldSource?.kind === 'user' && oldSource.patternId === 'recording-1') legacySource = { kind: 'user', patternId: 'user-1' };
    else if (oldSource?.kind !== 'auto') throw new Error('Invalid playback source.');
  }
  const migratedPatterns = LEGACY_USER_PATTERN_IDS.map((id, index) => ({ id, recording: index === 0 ? legacyRecording : null }));
  const sequenced = (legacyPatterns ? { ...rawRecord, patterns: migratedPatterns,
    playbackSource: legacySource,
    settings: { ...(rawRecord.settings as Record<string, unknown>), phaseMode: 'free',
      ...(old ? { filter2Route: 'mod', filter1CutoffDepthCent: P['filter1-cutoff-depth'].defaultValue } : {}) } } : rawRecord) as Record<string, any>;
  if (!modern && !Array.isArray(sequenced.patterns)) throw new Error('User 1 and User 2 patterns are required.');
  const withSequencePitch: Record<string, any> = modern || format === 'KOROGI-Lab/timbre-v8' ? sequenced : {
    ...sequenced,
    autoSequence: defaultAutoSequence(),
    patterns: sequenced.patterns.map((pattern: Record<string, any>) => ({
      id: pattern.id,
      gateRecording: pattern.recording ?? null,
      pitchRecording: null,
      settings: defaultSequenceSettings()
    }))
  };
  const oldPatterns = withSequencePitch.patterns as UserPattern[] | undefined;
  if (!modern && (!oldPatterns || oldPatterns.length !== LEGACY_USER_PATTERN_IDS.length)) throw new Error('User 1 and User 2 patterns are required.');
  if (!modern && oldPatterns && (new Set(oldPatterns.map(item => item.id)).size !== LEGACY_USER_PATTERN_IDS.length ||
    LEGACY_USER_PATTERN_IDS.some(id => !oldPatterns.some(item => item.id === id)))) throw new Error('User pattern IDs must be unique and complete.');
  const oldPattern = (id: UserPatternId) => oldPatterns?.find(item => item.id === id);
  const oldPlayback = (withSequencePitch.playbackSource ?? { kind: 'auto' }) as PlaybackSource;
  if (!modern) {
    checkChoice(oldPlayback.kind, ['auto', 'user'], 'playback source');
    if (oldPlayback.kind === 'user') checkChoice(oldPlayback.patternId, LEGACY_USER_PATTERN_IDS, 'playback source');
  }
  const oldAuto = (withSequencePitch.autoSequence ?? defaultAutoSequence()) as ReturnType<typeof defaultAutoSequence>;
  const selectedSettings = oldPlayback.kind === 'auto' ? oldAuto.settings : oldPattern(oldPlayback.patternId)?.settings;
  const legacyPitch = [oldPattern('user-1'), oldPattern('user-2'), { pitchRecording: oldAuto.pitchRecording, settings: oldAuto.settings }];
  const migrated = modern ? withSequencePitch : {
    ...withSequencePitch,
    gatePatterns: USER_PATTERN_IDS.map(id => ({ id, recording: oldPattern(id)?.gateRecording ?? null, muted: false })),
    pitchPatterns: USER_PATTERN_IDS.map((id, index) => ({ id, recording: legacyPitch[index]?.pitchRecording ?? null,
      muted: false, pitchMode: legacyPitch[index]?.settings?.pitchMode ?? { kind: 'smooth' },
      pitchScaleCent: legacyPitch[index]?.settings?.pitchScaleCent ?? P['sequence-pitch-scale'].defaultValue })),
    sequence: { gateMode: oldPlayback.kind === 'auto' ? 'auto' : 'user', gateUserId: oldPlayback.kind === 'auto' ? 'user-1' : oldPlayback.patternId,
      pitchUserId: oldPlayback.kind === 'auto' ? 'user-3' : oldPlayback.patternId,
      recordSpeed: selectedSettings?.recordSpeed ?? 1, playSpeed: selectedSettings?.playSpeed ?? 1 }
  };
  const editorLayout = ['KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15'].includes(format)
    ? normalizeEditorLayout(rawRecord.editorLayout, format !== 'KOROGI-Lab/timbre-v15') : DEFAULT_EDITOR_LAYOUT.map(column => [...column]);
  const pitchPatternsWithAmount = Array.isArray(migrated.pitchPatterns)
    ? migrated.pitchPatterns.map((item: Record<string, unknown>) => ({ ...item,
      ...(!['KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15'].includes(format) ? { filterAmountCent: 0 } : {}) }))
    : migrated.pitchPatterns;
  const value = { ...migrated, pitchPatterns: pitchPatternsWithAmount, editorLayout, formatVersion: 'KOROGI-Lab/timbre-v15', settings: {
    ...(withSequencePitch.settings as Record<string, unknown>),
    ...(!['KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15'].includes(format) ? {
      filterEnvelope: { ...structuredClone(DEFAULT_CHANNEL_SETTINGS.filterEnvelope), amountCent: 0 },
      blocksEnabled: { ...(withSequencePitch.settings as ChannelSettings).blocksEnabled, fenv: false }
    } : {}),
    pitchEnvelope: newEnvelope ? (withSequencePitch.settings as Record<string, unknown>).pitchEnvelope : structuredClone(DEFAULT_CHANNEL_SETTINGS.pitchEnvelope),
    burst: ['KOROGI-Lab/timbre-v7', 'KOROGI-Lab/timbre-v8', 'KOROGI-Lab/timbre-v9', 'KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15'].includes(format)
      ? (sequenced.settings as Record<string, unknown>).burst
      : structuredClone(DEFAULT_CHANNEL_SETTINGS.burst)
  } } as unknown as TimbreDocument;
  const rawEnvelope = value.settings?.ampEnvelope;
  const rawAuto = value.settings?.autoTrigger as Record<string, any>;
  const legacyRepeat = rawAuto?.toffSec === undefined ? rawAuto?.repeatSec : rawAuto.tonSec + rawAuto.toffSec;
  const repeatSec = rawEnvelope?.mode === 'one-shot' && !value.settings.burst.enabled
    ? rawAuto?.oneShotRepeatSec ?? legacyRepeat : legacyRepeat;
  const withCurves = { ...value, settings: { ...value.settings,
    pitchEnvelope: { ...value.settings.pitchEnvelope,
      ...(!independentEnvelope ? { mode: rawEnvelope?.mode ?? 'gate' } : {}) },
    ampEnvelope: {
    attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential', mode: 'gate', ...rawEnvelope,
    releaseTiming: newEnvelope ? rawEnvelope?.releaseTiming : 'time'
  }, autoTrigger: independentEnvelope ? rawAuto : { tonSec: rawAuto?.tonSec, repeatSec } } } as TimbreDocument;
  if (!Array.isArray(withCurves.gatePatterns) || withCurves.gatePatterns.length !== USER_PATTERN_IDS.length ||
    !Array.isArray(withCurves.pitchPatterns) || withCurves.pitchPatterns.length !== USER_PATTERN_IDS.length) throw new Error('Three Gate and Pitch patterns are required.');
  const { editorLayout: _layout, ...template } = defaultTimbre();
  checkShape(withCurves, template, 'timbre');
  const selection = withCurves.sequence;
  checkChoice(selection.gateMode, ['auto', 'user'], 'Gate mode');
  checkChoice(selection.gateUserId, USER_PATTERN_IDS, 'Gate User'); checkChoice(selection.pitchUserId, USER_PATTERN_IDS, 'Pitch User');
  const normalizePatterns = <T extends { id: string }>(items: T[], lane: 'Gate' | 'Pitch') => {
    const ids = new Set(items.map(item => item.id));
    if (ids.size !== USER_PATTERN_IDS.length || USER_PATTERN_IDS.some(id => !ids.has(id))) throw new Error(`${lane} User IDs must be unique and complete.`);
  };
  normalizePatterns(withCurves.gatePatterns, 'Gate'); normalizePatterns(withCurves.pitchPatterns, 'Pitch');
  const gatePatterns = withCurves.gatePatterns.map(item => ({ id: item.id, recording: normalizeTriggerRecording(item.recording), muted: item.muted }));
  const pitchPatterns = withCurves.pitchPatterns.map(item => {
    const settings = normalizeSequenceSettings({ pitchMode: item.pitchMode, pitchScaleCent: item.pitchScaleCent, filterAmountCent: item.filterAmountCent, recordSpeed: 1, playSpeed: 1 });
    return { id: item.id, recording: normalizePitchRecording(item.recording), muted: item.muted,
      pitchMode: settings.pitchMode, pitchScaleCent: settings.pitchScaleCent, filterAmountCent: settings.filterAmountCent };
  });
  const speeds = normalizeSequenceSettings({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200,
    recordSpeed: selection.recordSpeed, playSpeed: selection.playSpeed });
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
  checkChoice(ch.ampEnvelope.releaseTiming, ['time', 'rate'], 'AEnv Release Timing');
  if (ch.ampEnvelope.releaseTiming === 'rate' && ch.ampEnvelope.releaseCurve !== 'linear') throw new Error('AEnv Rate requires a Linear Release curve.');
  checkChoice(ch.pitchEnvelope.mode, ['gate', 'one-shot'], 'PEnv mode');
  checkChoice(ch.pitchEnvelope.releaseTiming, ['time', 'rate'], 'PEnv Release Timing');
  if (!Number.isInteger(ch.burst.pulseCountMin) || ch.burst.pulseCountMin < LIMITS.burstCount.min || ch.burst.pulseCountMin > LIMITS.burstCount.max ||
    !Number.isInteger(ch.burst.pulseCountMax) || ch.burst.pulseCountMax < LIMITS.burstCount.min || ch.burst.pulseCountMax > LIMITS.burstCount.max) {
    throw new Error('BURST pulse counts must be integers from 1 to 8.');
  }
  if (ch.burst.pulseCountMin > ch.burst.pulseCountMax) throw new Error('BURST minimum pulse count must not exceed maximum.');
  checkChoice(ch.filterEnvelope.mode, ['gate', 'one-shot'], 'FEnv mode');
  for (const phase of ['attackCurve', 'decayCurve', 'releaseCurve'] as const)
    checkChoice(ch.filterEnvelope[phase], ['linear', 'exponential'], `FEnv ${phase}`);
  checkChoice(ch.filterEnvelope.releaseTiming, ['time', 'rate'], 'FEnv Release timing');
  if (ch.filterEnvelope.releaseTiming === 'rate' && ch.filterEnvelope.releaseCurve !== 'linear')
    throw new Error('FEnv Rate requires Linear Release.');
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
    pitchEnvelope: {
      mode: ch.pitchEnvelope.mode,
      start: bounded(ch.pitchEnvelope.start, LIMITS.pitchLevel), attack: bounded(ch.pitchEnvelope.attack, LIMITS.pitchLevel),
      sustain: bounded(ch.pitchEnvelope.sustain, LIMITS.pitchLevel), release: bounded(ch.pitchEnvelope.release, LIMITS.pitchLevel),
      attackSec: bounded(ch.pitchEnvelope.attackSec, LIMITS.pitchTimeSec), decaySec: bounded(ch.pitchEnvelope.decaySec, LIMITS.pitchTimeSec),
      releaseSec: bounded(ch.pitchEnvelope.releaseSec, LIMITS.pitchTimeSec), scale: bounded(ch.pitchEnvelope.scale, LIMITS.pitchScale),
      releaseTiming: ch.pitchEnvelope.releaseTiming
    },
    mod: { mode: ch.mod.mode === 'off' ? 'am' : ch.mod.mode, amDepth: bounded(ch.mod.amDepth, LIMITS.amDepth), amOffset: bounded(ch.mod.amOffset, LIMITS.amOffset), fmDepthCent: bounded(ch.mod.fmDepthCent, LIMITS.fmDepthCent) },
    filter1: filter(ch.filter1), filter2: filter(ch.filter2),
    filter2Route: ch.filter2Route, filter1CutoffDepthCent: bounded(ch.filter1CutoffDepthCent, LIMITS.filter1CutoffDepthCent),
    ampEnvelope: {
      attackSec: bounded(ch.ampEnvelope.attackSec, LIMITS.envelopeSec), decaySec: bounded(ch.ampEnvelope.decaySec, LIMITS.envelopeSec),
      sustain: bounded(ch.ampEnvelope.sustain, LIMITS.sustain), releaseSec: bounded(ch.ampEnvelope.releaseSec, LIMITS.envelopeSec),
      attackCurve: ch.ampEnvelope.attackCurve, decayCurve: ch.ampEnvelope.decayCurve, releaseCurve: ch.ampEnvelope.releaseCurve,
      releaseTiming: ch.ampEnvelope.releaseTiming, mode: ch.ampEnvelope.mode
    },
    filterEnvelope: {
      attackSec: bounded(ch.filterEnvelope.attackSec, LIMITS.filterEnvelopeAttack),
      decaySec: bounded(ch.filterEnvelope.decaySec, LIMITS.filterEnvelopeDecay),
      sustain: bounded(ch.filterEnvelope.sustain, LIMITS.filterEnvelopeSustain),
      releaseSec: bounded(ch.filterEnvelope.releaseSec, LIMITS.filterEnvelopeRelease),
      amountCent: bounded(ch.filterEnvelope.amountCent, LIMITS.filterEnvelopeAmount),
      attackCurve: ch.filterEnvelope.attackCurve, decayCurve: ch.filterEnvelope.decayCurve, releaseCurve: ch.filterEnvelope.releaseCurve,
      releaseTiming: ch.filterEnvelope.releaseTiming, mode: ch.filterEnvelope.mode
    },
    fx1: effect(ch.fx1, 'distortion'),
    autoTrigger: { tonSec: bounded(ch.autoTrigger.tonSec, LIMITS.triggerSec),
      repeatSec: bounded(ch.autoTrigger.repeatSec, { min: P.trepeat.min / 1000, max: P.trepeat.max / 1000 }) },
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
  return { formatVersion: 'KOROGI-Lab/timbre-v15', name: value.name.trim() || 'Untitled', editorLayout, settings,
    detuneRangeCent: bounded(value.detuneRangeCent, LIMITS.detuneRangeCent), detuneNormalized: clamp(value.detuneNormalized, -1, 1),
    gatePatterns, pitchPatterns, sequence: { gateMode: selection.gateMode, gateUserId: selection.gateUserId, pitchUserId: selection.pitchUserId,
      recordSpeed: speeds.recordSpeed, playSpeed: speeds.playSpeed } };
}

export function normalizeSession(raw: unknown): SessionDocument {
  requireFormat(raw, ['KOROGI-Lab/session-v2', 'KOROGI-Lab/session-v3', 'KOROGI-Lab/session-v4', 'KOROGI-Lab/session-v5', 'KOROGI-Lab/session-v6', 'KOROGI-Lab/session-v7', 'KOROGI-Lab/session-v8', 'KOROGI-Lab/session-v9', 'KOROGI-Lab/session-v10', 'KOROGI-Lab/session-v11', 'KOROGI-Lab/session-v12', 'KOROGI-Lab/session-v13', 'KOROGI-Lab/session-v14', 'KOROGI-Lab/session-v15', 'KOROGI-Lab/session-v16']);
  if (!isRecord(raw) || !Array.isArray(raw.channels)) throw new Error('Session channels must be an array.');
  checkShape(raw, { formatVersion: '', name: '', savedAt: '', near: defaultBus(), far: defaultBus(), crossfade: 0, masterGainDb: 0, masterMuted: false }, 'session');
  const value = raw as unknown as SessionDocument;
  const legacyPan = !['KOROGI-Lab/session-v5', 'KOROGI-Lab/session-v6', 'KOROGI-Lab/session-v7', 'KOROGI-Lab/session-v8', 'KOROGI-Lab/session-v9', 'KOROGI-Lab/session-v10', 'KOROGI-Lab/session-v11', 'KOROGI-Lab/session-v12', 'KOROGI-Lab/session-v13', 'KOROGI-Lab/session-v14', 'KOROGI-Lab/session-v15', 'KOROGI-Lab/session-v16'].includes(value.formatVersion);
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
  return { formatVersion: 'KOROGI-Lab/session-v16', name: value.name.trim() || 'Untitled', savedAt: value.savedAt,
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
