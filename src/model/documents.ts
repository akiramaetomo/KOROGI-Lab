import { DEFAULT_EDITOR_LAYOUT, normalizeEditorLayout } from './editorLayout';
import { DEFAULT_CHANNEL_SETTINGS, DEFAULT_EFFECT_SLOT_SETTINGS, defaultLfsrSettings, defaultMultiSettings, LIMITS } from '../audio/constants';
import { isValidPartialCount } from '../audio/dsp/multiOscillator';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { maxSongBars } from './recordingLimits';
import { isPatternBars } from './stretch';
import { defaultPatternBars, frameBarsForSong, patternBarsFromSelections } from './songFrame';
import { clamp } from '../audio/dsp/params';
import type { BusSettings, ChannelSettings, EffectSlotSettings, FilterOrder, FilterType, PatternBars, PlaybackSource, SessionDocument, SongSettings, TimbreDocument, UserPattern, UserPatternId } from '../audio/types';
import { checkChoice, checkShape, isRecord } from './patch';
import { emptyGatePatterns, emptyPitchPatterns, LEGACY_USER_PATTERN_IDS, normalizeTriggerRecording, USER_PATTERN_IDS } from './triggerRecording';
import { defaultAutoSequence, defaultSequenceSettings, normalizePitchRecording, normalizeSequenceSettings } from './sequencePitch';

export const DEFAULT_CHANNEL_MIX = { gainDb: P.level.defaultValue, muted: false, balance: P.balance.defaultValue, pan: P.pan.defaultValue };
export const LAB_SLOT_IDS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
export function defaultSongSettings(): SongSettings {
  return { bpm: P['song-bpm'].defaultValue, speed: P['song-speed'].defaultValue, frameBars: P['song-frame'].defaultValue, timingMode: 'bars' };
}
function validSongTiming(raw: unknown): raw is Record<string, unknown> & { bpm: number; speed: number; timingMode: SongSettings['timingMode'] } {
  return isRecord(raw) && Number.isInteger(raw.bpm) && (raw.bpm as number) >= P['song-bpm'].min && (raw.bpm as number) <= P['song-bpm'].max &&
    ['original', 'bars'].includes(raw.timingMode as string) && typeof raw.speed === 'number' && Number.isFinite(raw.speed) &&
    raw.speed >= P['song-speed'].min && raw.speed <= P['song-speed'].max;
}
export function normalizeSongSettings(raw: unknown): SongSettings {
  if (!validSongTiming(raw) || !Number.isInteger(raw.frameBars) || (raw.frameBars as number) < P['song-frame'].min ||
    (raw.frameBars as number) > Math.min(P['song-frame'].max, maxSongBars(raw.bpm)))
    throw new Error(`Song requires Seconds or Bars timing, BPM 30–480, Speed 0.25–4 and a Frame of ${P['song-frame'].min} to ${P['song-frame'].max} whole bars.`);
  return { bpm: raw.bpm, speed: raw.speed, frameBars: raw.frameBars as number, timingMode: raw.timingMode };
}
/** Pattern bars of a Song saved before SongFrame (session-v18 to v20): one count per Pattern number for every timbre. */
function legacySongBars(raw: unknown): PatternBars {
  if (!validSongTiming(raw) || !Array.isArray(raw.bars) || raw.bars.length !== USER_PATTERN_IDS.length ||
    raw.bars.some(bar => typeof bar !== 'number' || !isPatternBars(bar, maxSongBars(raw.bpm))))
    throw new Error('Song requires Seconds or Bars timing, BPM 30–480, Speed 0.25–4 and eight bar counts (1/2, 1/4, 1/8, 1/16 or 1 to 32 whole bars) within 300 seconds each.');
  return [...raw.bars] as PatternBars;
}
export function defaultBus(): BusSettings {
  return { gainDb: P['bus-gain'].defaultValue, gainEnabled: true, effects: [
    { ...DEFAULT_EFFECT_SLOT_SETTINGS, type: 'chorus' }, { ...DEFAULT_EFFECT_SLOT_SETTINGS, type: 'reverb' }
  ] };
}
export function defaultTimbre(name = 'Standard'): TimbreDocument {
  return { formatVersion: 'KOROGI-Lab/timbre-v21', name, editorLayout: DEFAULT_EDITOR_LAYOUT.map(column => [...column]), settings: structuredClone(DEFAULT_CHANNEL_SETTINGS), detuneRangeCent: P['detune-range'].defaultValue, detuneNormalized: 0,
    gatePatterns: emptyGatePatterns(), pitchPatterns: emptyPitchPatterns(), patternBars: defaultPatternBars(), sequence: {
      gateMode: 'auto', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1, stretch: false
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

/** Formats that store the ADSR PEnv; older files have their PEnv replaced by the neutral default. */
const NEW_PITCH_ENVELOPE_FORMATS: readonly string[] = ['KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'];

/** What a load migrated, so the UI reports it without re-deriving format versions. */
export interface LoadNotices { legacyPitchEnvelopeIgnored: boolean }

/** A timbre file saved before SongFrame has its Pattern bars read from its selections at the current BPM. */
export interface TimbreLoadNotices extends LoadNotices { patternBarsFromSelections: boolean }

/**
 * A Session load also reports Pattern bars above the 32-bar limit that were read as 32, and the Frame length
 * (in bars) when Song sections of different lengths before SongFrame now share it, else null.
 */
export interface SessionLoadNotices extends LoadNotices { songBarsCapped: boolean; songFrameMerged: number | null }

/** Song of a saved file with whole Pattern bars above the limit read as the limit (files from before the 32-bar cap). */
function capSavedSongBars(song: unknown): unknown {
  if (!isRecord(song) || !Array.isArray(song.bars)) return song;
  return { ...song, bars: song.bars.map(bar => Number.isInteger(bar) && (bar as number) > P['song-bars'].max ? P['song-bars'].max : bar) };
}
function songBarsAboveLimit(song: unknown): boolean {
  return isRecord(song) && Array.isArray(song.bars) && song.bars.some(bar => Number.isInteger(bar) && (bar as number) > P['song-bars'].max);
}

function timbreNotices(raw: unknown): LoadNotices {
  return { legacyPitchEnvelopeIgnored: !NEW_PITCH_ENVELOPE_FORMATS.includes((raw as { formatVersion?: string }).formatVersion ?? '') };
}

/**
 * Pure boundary: reject invalid types/enums, normalize finite values, strip unknown fields. Files saved before
 * SongFrame (timbre-v17 and older) read their Pattern bars from their selections at `bpm` (ADR 0011).
 */
export function normalizeTimbre(raw: unknown, bpm: number = P['song-bpm'].defaultValue): TimbreDocument {
  requireFormat(raw, ['KOROGI-Lab/timbre-v2', 'KOROGI-Lab/timbre-v3', 'KOROGI-Lab/timbre-v4', 'KOROGI-Lab/timbre-v5', 'KOROGI-Lab/timbre-v6', 'KOROGI-Lab/timbre-v7', 'KOROGI-Lab/timbre-v8', 'KOROGI-Lab/timbre-v9', 'KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21']);
  const rawRecord = raw as Record<string, unknown>;
  const format = rawRecord.formatVersion as string;
  const modern = ['KOROGI-Lab/timbre-v9', 'KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format);
  const newEnvelope = NEW_PITCH_ENVELOPE_FORMATS.includes(format);
  const independentEnvelope = ['KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format);
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
  if (!modern && !Array.isArray(sequenced.patterns)) throw new Error('Pattern 1 and Pattern 2 are required.');
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
  if (!modern && (!oldPatterns || oldPatterns.length !== LEGACY_USER_PATTERN_IDS.length)) throw new Error('Pattern 1 and Pattern 2 are required.');
  if (!modern && oldPatterns && (new Set(oldPatterns.map(item => item.id)).size !== LEGACY_USER_PATTERN_IDS.length ||
    LEGACY_USER_PATTERN_IDS.some(id => !oldPatterns.some(item => item.id === id)))) throw new Error('Pattern IDs must be unique and complete.');
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
      // Legacy files predate the 1200-cent default; keep their original 200-cent fallback.
      pitchScaleCent: legacyPitch[index]?.settings?.pitchScaleCent ?? 200 })),
    sequence: { gateMode: oldPlayback.kind === 'auto' ? 'auto' : 'user', gateUserId: oldPlayback.kind === 'auto' ? 'user-1' : oldPlayback.patternId,
      pitchUserId: oldPlayback.kind === 'auto' ? 'user-3' : oldPlayback.patternId,
      recordSpeed: selectedSettings?.recordSpeed ?? 1, playSpeed: selectedSettings?.playSpeed ?? 1 }
  };
  if (format === 'KOROGI-Lab/timbre-v16') for (const lane of ['gatePatterns', 'pitchPatterns'] as const) {
    const patterns = migrated[lane] as Array<{ id: string }> | undefined;
    if (!Array.isArray(patterns) || patterns.length !== 3 ||
      USER_PATTERN_IDS.slice(0, 3).some(id => !patterns.some(item => item.id === id)) ||
      new Set(patterns.map(item => item.id)).size !== 3) throw new Error(`Old ${lane} must contain Pattern 1–3 exactly once.`);
  }
  const editorLayout = ['KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format)
    ? normalizeEditorLayout(rawRecord.editorLayout, !['KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format)) : DEFAULT_EDITOR_LAYOUT.map(column => [...column]);
  const pitchPatternsWithAmount = Array.isArray(migrated.pitchPatterns)
    ? migrated.pitchPatterns.map((item: Record<string, any>) => ({ ...item,
      ...(!['KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format) ? { filterAmountCent: 0 } : {}),
      ...(!['KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format) ? { pitchMode: { ...item.pitchMode, scale: 'equal',
        portamentoSec: item.pitchMode?.portamentoSec ?? 0 } } : {}) }))
    : migrated.pitchPatterns;
  const eightPatterns = format === 'KOROGI-Lab/timbre-v17' || format === 'KOROGI-Lab/timbre-v18' || format === 'KOROGI-Lab/timbre-v19' || format === 'KOROGI-Lab/timbre-v20' || format === 'KOROGI-Lab/timbre-v21';
  const newFormat = format === 'KOROGI-Lab/timbre-v16' || eightPatterns;
  const expandedGate = eightPatterns ? migrated.gatePatterns : [...migrated.gatePatterns, ...emptyGatePatterns().slice(migrated.gatePatterns.length)];
  const expandedPitch = eightPatterns ? migrated.pitchPatterns : [...migrated.pitchPatterns, ...emptyPitchPatterns().slice(migrated.pitchPatterns.length)];
  const value = { ...migrated, gatePatterns: expandedGate, pitchPatterns: expandedPitch.map((item: Record<string, unknown>, index: number) => ({
    ...item, ...(index < pitchPatternsWithAmount.length ? pitchPatternsWithAmount[index] : {}), ...(!newFormat ? { filterAmountWide: false } : {}) })), editorLayout, formatVersion: 'KOROGI-Lab/timbre-v21', settings: {
    ...(withSequencePitch.settings as Record<string, unknown>),
    // Multi OSC (timbre-v19): every older file plays Single and starts Multi from the defaults.
    ...(!['KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format) ? Object.fromEntries((['osc1', 'osc2'] as const).map(key => [key,
      { ...(withSequencePitch.settings as Record<string, any>)[key], voiceMode: 'single', multi: defaultMultiSettings() }])) : {}),
    ...(!['KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format) ? {
      filterEnvelope: { ...structuredClone(DEFAULT_CHANNEL_SETTINGS.filterEnvelope), amountCent: 0 },
      blocksEnabled: { ...(withSequencePitch.settings as ChannelSettings).blocksEnabled, fenv: false }
    } : {}),
    pitchEnvelope: { ...(newEnvelope ? (withSequencePitch.settings as Record<string, any>).pitchEnvelope : structuredClone(DEFAULT_CHANNEL_SETTINGS.pitchEnvelope)),
      ...(!newFormat ? { curve: 'linear' } : {}) },
    filterEnvelope: { ...(['KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format)
      ? (withSequencePitch.settings as Record<string, any>).filterEnvelope
      : { ...DEFAULT_CHANNEL_SETTINGS.filterEnvelope, amountCent: 0 }),
      ...(!newFormat ? { amountWide: false } : {}) },
    burst: ['KOROGI-Lab/timbre-v7', 'KOROGI-Lab/timbre-v8', 'KOROGI-Lab/timbre-v9', 'KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17', 'KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes(format)
      ? (sequenced.settings as Record<string, unknown>).burst
      : structuredClone(DEFAULT_CHANNEL_SETTINGS.burst)
  } } as unknown as TimbreDocument;
  const rawEnvelope = value.settings?.ampEnvelope;
  const rawAuto = value.settings?.autoTrigger as Record<string, any>;
  const legacyRepeat = rawAuto?.toffSec === undefined ? rawAuto?.repeatSec : rawAuto.tonSec + rawAuto.toffSec;
  const repeatSec = rawEnvelope?.mode === 'one-shot' && !value.settings.burst.enabled
    ? rawAuto?.oneShotRepeatSec ?? legacyRepeat : legacyRepeat;
  // OSC2 audio routes (timbre-v20): older files keep their sound with Balance center, no FEnv on Filter2, and a default AEnv2.
  const osc2Audio = format === 'KOROGI-Lab/timbre-v20' || format === 'KOROGI-Lab/timbre-v21' ? {} : { oscBalance: 0, filter2FenvDepth: 0,
    ampEnvelope2: structuredClone(DEFAULT_CHANNEL_SETTINGS.ampEnvelope2), blocksEnabled: { ...value.settings.blocksEnabled, aenv2: true } };
  // LFSR Noise was added within timbre-v20; files saved before it keep their source and start LFSR from the defaults.
  const withLfsr = (osc: Record<string, unknown>) => isRecord(osc) ? { ...osc, lfsr: osc.lfsr ?? defaultLfsrSettings() } : osc;
  // FILTER2 Stage2, FEnv Target and Shelf/Peak gain were added within timbre-v20; files saved before them keep their sound
  // (Stage2 Off, FEnv on Stage1, 0 dB). The short-lived Path B experiment (filter2PathB) is ignored.
  const rawSettings = value.settings as unknown as Record<string, unknown>;
  const withFilterGain = (f: unknown) => isRecord(f) ? { ...f, gainDb: f.gainDb ?? 0 } : f;
  // Filter Q is linear from timbre-v21 (ADR 0017). Older files stored Web Audio's dB value for LPF/HPF (the v2 'off' reads as LPF):
  // convert it losslessly, so the sound stays the same; the [0.1, 30] bounds below only clip values above 29.54 dB.
  const dbQ = format !== 'KOROGI-Lab/timbre-v21';
  const linearQ = (f: unknown, offIsLowpass: boolean) => isRecord(f) && dbQ && typeof f.q === 'number' &&
    (f.type === 'lowpass' || f.type === 'highpass' || (offIsLowpass && f.type === 'off')) ? { ...f, q: 10 ** (f.q / 20) } : f;
  const filterAdditions = { filter1: withFilterGain(linearQ(rawSettings.filter1, true)), filter2: withFilterGain(linearQ(rawSettings.filter2, true)),
    filter2Stage2: withFilterGain(linearQ(rawSettings.filter2Stage2, false) ?? structuredClone(DEFAULT_CHANNEL_SETTINGS.filter2Stage2)),
    filter2FenvTarget: rawSettings.filter2FenvTarget ?? DEFAULT_CHANNEL_SETTINGS.filter2FenvTarget };
  const withCurves = { ...value, settings: { ...value.settings, ...osc2Audio, ...filterAdditions,
    osc1: withLfsr(value.settings.osc1 as unknown as Record<string, unknown>), osc2: withLfsr(value.settings.osc2 as unknown as Record<string, unknown>),
    pitchEnvelope: { ...value.settings.pitchEnvelope,
      ...(!independentEnvelope ? { mode: rawEnvelope?.mode ?? 'gate' } : {}) },
    ampEnvelope: {
    attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential', mode: 'gate', ...rawEnvelope,
    releaseTiming: newEnvelope ? rawEnvelope?.releaseTiming : 'time'
  }, autoTrigger: independentEnvelope ? rawAuto : { tonSec: rawAuto?.tonSec, repeatSec } } } as TimbreDocument;
  if (!Array.isArray(withCurves.gatePatterns) || withCurves.gatePatterns.length !== USER_PATTERN_IDS.length ||
    !Array.isArray(withCurves.pitchPatterns) || withCurves.pitchPatterns.length !== USER_PATTERN_IDS.length) throw new Error('Eight Gate and Pitch patterns are required.');
  const { editorLayout: _layout, ...template } = defaultTimbre();
  // Multi Table rows vary in number; the oscillator normalizer checks them instead of the fixed-shape template.
  for (const osc of [template.settings.osc1, template.settings.osc2]) delete (osc.multi as Partial<typeof osc.multi>).partials;
  // Stretch was added within timbre-v17; files saved before it play at their own speed.
  const selection = { ...withCurves.sequence, stretch: withCurves.sequence.stretch ?? false };
  // Song's per-Pattern choice was added within timbre-v17; files saved before it play every Pattern.
  const gateInput = withCurves.gatePatterns.map(item => ({ ...item, inSong: item.inSong ?? true }));
  // SongFrame (timbre-v18) stores bars per Pattern number; older files derive them once the Patterns are read.
  const savedBars = format === 'KOROGI-Lab/timbre-v18' || format === 'KOROGI-Lab/timbre-v19' || (format === 'KOROGI-Lab/timbre-v20' || format === 'KOROGI-Lab/timbre-v21') ? (rawRecord.patternBars as unknown) : null;
  if (savedBars !== null && (!Array.isArray(savedBars) || savedBars.length !== USER_PATTERN_IDS.length ||
    savedBars.some(bar => typeof bar !== 'number' || !isPatternBars(bar, P['song-bars'].max))))
    throw new Error('Timbre requires eight Pattern bar counts (1/2, 1/4, 1/8, 1/16 or 1 to 32 whole bars).');
  checkShape({ ...withCurves, sequence: selection, gatePatterns: gateInput, patternBars: savedBars ?? defaultPatternBars() }, template, 'timbre');
  checkChoice(selection.gateMode, ['auto', 'user'], 'Gate mode');
  checkChoice(selection.gateUserId, USER_PATTERN_IDS, 'Gate Pattern'); checkChoice(selection.pitchUserId, USER_PATTERN_IDS, 'Pitch Pattern');
  const normalizePatterns = <T extends { id: string }>(items: T[], lane: 'Gate' | 'Pitch') => {
    const ids = new Set(items.map(item => item.id));
    if (ids.size !== USER_PATTERN_IDS.length || USER_PATTERN_IDS.some(id => !ids.has(id))) throw new Error(`${lane} Pattern IDs must be unique and complete.`);
  };
  normalizePatterns(gateInput, 'Gate'); normalizePatterns(withCurves.pitchPatterns, 'Pitch');
  const gatePatterns = gateInput.map(item => ({ id: item.id, recording: normalizeTriggerRecording(item.recording), muted: item.muted, inSong: item.inSong }));
  const pitchPatterns = withCurves.pitchPatterns.map(item => {
    const settings = normalizeSequenceSettings({ pitchMode: item.pitchMode, pitchScaleCent: item.pitchScaleCent, filterAmountCent: item.filterAmountCent,
      filterAmountWide: item.filterAmountWide, recordSpeed: 1, playSpeed: 1 });
    return { id: item.id, recording: normalizePitchRecording(item.recording), muted: item.muted,
      pitchMode: settings.pitchMode, pitchScaleCent: settings.pitchScaleCent, filterAmountCent: settings.filterAmountCent, filterAmountWide: settings.filterAmountWide };
  });
  const patternBars = savedBars ? [...savedBars] as PatternBars : patternBarsFromSelections({ gatePatterns, pitchPatterns }, bpm);
  const speeds = normalizeSequenceSettings({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200,
    recordSpeed: selection.recordSpeed, playSpeed: selection.playSpeed });
  const ch = withCurves.settings;
  const oscillator = (osc: ChannelSettings['osc1'], range: typeof LIMITS.osc1Hz | typeof LIMITS.osc2Hz, integer: boolean): ChannelSettings['osc1'] => {
    checkChoice(osc.sourceType, ['sine', 'sawtooth', 'triangle', 'square', 'white-noise', 'lfsr-noise'], 'oscillator source');
    checkChoice(osc.voiceMode, ['single', 'multi'], 'oscillator Single/Multi');
    checkChoice(osc.multi.definition, ['table', 'spread'], 'Multi definition');
    const partials: unknown = osc.multi.partials;
    if (!Array.isArray(partials) || !isValidPartialCount(partials.length) || partials.some(item => !isRecord(item) ||
      typeof item.ratio !== 'number' || !Number.isFinite(item.ratio) || typeof item.amplitude !== 'number' || !Number.isFinite(item.amplitude)))
      throw new Error(`Multi Table requires ${LIMITS.multiCount.min} to ${LIMITS.multiCount.max} rows of finite ratio and amplitude.`);
    if (!Number.isInteger(osc.multi.spread.count) || osc.multi.spread.count < LIMITS.multiCount.min || osc.multi.spread.count > LIMITS.multiCount.max)
      throw new Error(`Multi Spread count must be an integer from ${LIMITS.multiCount.min} to ${LIMITS.multiCount.max}.`);
    const hz = bounded(osc.baseFrequencyHz, range);
    return { sourceType: osc.sourceType, baseFrequencyHz: integer ? Math.round(hz) : hz, dutyRatio: bounded(osc.dutyRatio, LIMITS.dutyRatio),
      lfsr: { clockHz: bounded(osc.lfsr.clockHz, LIMITS.lfsrClockHz), bits: Math.round(bounded(osc.lfsr.bits, LIMITS.lfsrBits)) },
      voiceMode: osc.voiceMode, multi: { definition: osc.multi.definition,
        partials: osc.multi.partials.map(item => ({ ratio: bounded(item.ratio, LIMITS.multiRatio), amplitude: bounded(item.amplitude, LIMITS.multiAmplitude) })),
        spread: { count: osc.multi.spread.count, spreadCent: bounded(osc.multi.spread.spreadCent, LIMITS.multiSpreadCent) } } };
  };
  // FILTER1 keeps LPF/BPF/HPF at 2nd/4th; FILTER2 stages add Shelf/Peak and the 1st order (LPF/HPF/Shelf only).
  const FILTER2_TYPES: FilterType[] = ['lowpass', 'bandpass', 'highpass', 'lowshelf', 'highshelf', 'peaking'];
  const filter = (f: ChannelSettings['filter1'], label: string, types: FilterType[], orders: FilterOrder[], keepOff = false) => {
    checkChoice(f.type, types, `${label} type`);
    checkChoice(f.order, orders, `${label} order`);
    if (f.order === 1 && (f.type === 'bandpass' || f.type === 'peaking')) throw new Error(`${label}: the 1st order is LPF, HPF or Shelf only.`);
    return { type: f.type === 'off' && !keepOff ? 'lowpass' as const : f.type, order: f.order, frequencyHz: bounded(f.frequencyHz, LIMITS.filterHz),
      q: bounded(f.q, LIMITS.filterQ), gainDb: bounded(f.gainDb, LIMITS.filterGainDb) };
  };
  checkChoice(ch.mod.mode, ['off', 'am', 'fm'], 'MOD mode');
  checkChoice(ch.phaseMode, ['sync', 'free'], 'phase mode');
  checkChoice(ch.filter2Route, ['mod', 'filter1-cutoff', 'aenv-in', 'aenv-out'], 'FILTER2 route');
  checkChoice(ch.filter2FenvTarget, ['stage1', 'stage2', 'both'], 'FILTER2 FEnv Target');
  const amplitude = (env: ChannelSettings['ampEnvelope'], label: string): ChannelSettings['ampEnvelope'] => {
    for (const curve of ['attackCurve', 'decayCurve', 'releaseCurve'] as const) {
      checkChoice(env[curve], ['exponential', 'linear'], `${label} ${curve}`);
    }
    checkChoice(env.mode, ['gate', 'one-shot'], `${label} mode`);
    checkChoice(env.releaseTiming, ['time', 'rate'], `${label} Release Timing`);
    if (env.releaseTiming === 'rate' && env.releaseCurve !== 'linear') throw new Error(`${label} Rate requires a Linear Release curve.`);
    return {
      attackSec: bounded(env.attackSec, LIMITS.envelopeSec), decaySec: bounded(env.decaySec, LIMITS.envelopeSec),
      sustain: bounded(env.sustain, LIMITS.sustain), releaseSec: bounded(env.releaseSec, LIMITS.envelopeSec),
      attackCurve: env.attackCurve, decayCurve: env.decayCurve, releaseCurve: env.releaseCurve,
      releaseTiming: env.releaseTiming, mode: env.mode
    };
  };
  const ampEnvelope = amplitude(ch.ampEnvelope, 'AEnv');
  const ampEnvelope2 = amplitude(ch.ampEnvelope2, 'AEnv2');
  checkChoice(ch.pitchEnvelope.mode, ['gate', 'one-shot'], 'PEnv mode');
  checkChoice(ch.pitchEnvelope.curve, ['linear', 'logarithmic'], 'PEnv curve');
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
      curve: ch.pitchEnvelope.curve,
      start: bounded(ch.pitchEnvelope.start, LIMITS.pitchLevel), attack: bounded(ch.pitchEnvelope.attack, LIMITS.pitchLevel),
      sustain: bounded(ch.pitchEnvelope.sustain, LIMITS.pitchLevel), release: bounded(ch.pitchEnvelope.release, LIMITS.pitchLevel),
      attackSec: bounded(ch.pitchEnvelope.attackSec, LIMITS.pitchTimeSec), decaySec: bounded(ch.pitchEnvelope.decaySec, LIMITS.pitchTimeSec),
      releaseSec: bounded(ch.pitchEnvelope.releaseSec, LIMITS.pitchTimeSec), scale: bounded(ch.pitchEnvelope.scale, LIMITS.pitchScale),
      releaseTiming: ch.pitchEnvelope.releaseTiming
    },
    mod: { mode: ch.mod.mode === 'off' ? 'am' : ch.mod.mode, amDepth: bounded(ch.mod.amDepth, LIMITS.amDepth), amOffset: bounded(ch.mod.amOffset, LIMITS.amOffset), fmDepthCent: bounded(ch.mod.fmDepthCent, LIMITS.fmDepthCent) },
    filter1: { ...filter(ch.filter1, 'FILTER1', ['off', 'lowpass', 'bandpass', 'highpass'], [2, 4]), gainDb: 0 },
    filter2: filter(ch.filter2, 'FILTER2', ['off', ...FILTER2_TYPES], [1, 2, 4]),
    filter2Stage2: filter(ch.filter2Stage2, 'FILTER2 Stage2', ['off', ...FILTER2_TYPES], [1, 2, 4], true),
    filter2FenvTarget: ch.filter2FenvTarget,
    filter2Route: ch.filter2Route, filter1CutoffDepthCent: bounded(ch.filter1CutoffDepthCent, LIMITS.filter1CutoffDepthCent),
    oscBalance: bounded(ch.oscBalance, LIMITS.oscBalance), filter2FenvDepth: bounded(ch.filter2FenvDepth, LIMITS.filter2FenvDepth),
    ampEnvelope, ampEnvelope2,
    filterEnvelope: {
      attackSec: bounded(ch.filterEnvelope.attackSec, LIMITS.filterEnvelopeAttack),
      decaySec: bounded(ch.filterEnvelope.decaySec, LIMITS.filterEnvelopeDecay),
      sustain: bounded(ch.filterEnvelope.sustain, LIMITS.filterEnvelopeSustain),
      releaseSec: bounded(ch.filterEnvelope.releaseSec, LIMITS.filterEnvelopeRelease),
      amountCent: bounded(ch.filterEnvelope.amountCent, { min: ch.filterEnvelope.amountWide ? -7200 : -4800, max: ch.filterEnvelope.amountWide ? 7200 : 4800 }),
      amountWide: ch.filterEnvelope.amountWide,
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
  return { formatVersion: 'KOROGI-Lab/timbre-v21', name: value.name.trim() || 'Untitled', editorLayout, settings,
    detuneRangeCent: bounded(value.detuneRangeCent, LIMITS.detuneRangeCent), detuneNormalized: clamp(value.detuneNormalized, -1, 1),
    gatePatterns, pitchPatterns, patternBars, sequence: { gateMode: selection.gateMode, gateUserId: selection.gateUserId, pitchUserId: selection.pitchUserId,
      recordSpeed: speeds.recordSpeed, playSpeed: speeds.playSpeed, stretch: selection.stretch } };
}

export function normalizeSession(raw: unknown): SessionDocument {
  requireFormat(raw, ['KOROGI-Lab/session-v2', 'KOROGI-Lab/session-v3', 'KOROGI-Lab/session-v4', 'KOROGI-Lab/session-v5', 'KOROGI-Lab/session-v6', 'KOROGI-Lab/session-v7', 'KOROGI-Lab/session-v8', 'KOROGI-Lab/session-v9', 'KOROGI-Lab/session-v10', 'KOROGI-Lab/session-v11', 'KOROGI-Lab/session-v12', 'KOROGI-Lab/session-v13', 'KOROGI-Lab/session-v14', 'KOROGI-Lab/session-v15', 'KOROGI-Lab/session-v16', 'KOROGI-Lab/session-v17', 'KOROGI-Lab/session-v18', 'KOROGI-Lab/session-v19', 'KOROGI-Lab/session-v20', 'KOROGI-Lab/session-v21', 'KOROGI-Lab/session-v22', 'KOROGI-Lab/session-v23']);
  if (!isRecord(raw) || !Array.isArray(raw.channels)) throw new Error('Session channels must be an array.');
  checkShape(raw, { formatVersion: '', name: '', savedAt: '', near: defaultBus(), far: defaultBus(), crossfade: 0, masterGainDb: 0, masterMuted: false }, 'session');
  const value = raw as unknown as SessionDocument;
  const legacyPan = !['KOROGI-Lab/session-v5', 'KOROGI-Lab/session-v6', 'KOROGI-Lab/session-v7', 'KOROGI-Lab/session-v8', 'KOROGI-Lab/session-v9', 'KOROGI-Lab/session-v10', 'KOROGI-Lab/session-v11', 'KOROGI-Lab/session-v12', 'KOROGI-Lab/session-v13', 'KOROGI-Lab/session-v14', 'KOROGI-Lab/session-v15', 'KOROGI-Lab/session-v16', 'KOROGI-Lab/session-v17', 'KOROGI-Lab/session-v18', 'KOROGI-Lab/session-v19', 'KOROGI-Lab/session-v20', 'KOROGI-Lab/session-v21', 'KOROGI-Lab/session-v22', 'KOROGI-Lab/session-v23'].includes(value.formatVersion);
  const ids = new Set<string>();
  const rawBpm = isRecord(value.song) && Number.isInteger(value.song.bpm) ? value.song.bpm as number : P['song-bpm'].defaultValue;
  const channels = value.channels.map(channel => {
    const withPan = legacyPan ? { ...channel, pan: P.pan.defaultValue } : channel;
    checkShape(withPan, { id: '', ...DEFAULT_CHANNEL_MIX }, 'channel');
    if (!channel.id.trim() || ids.has(channel.id)) throw new Error('Channel IDs must be nonempty and unique.');
    ids.add(channel.id);
    return { id: channel.id, gainDb: bounded(channel.gainDb, LIMITS.channelLevelDb), muted: channel.muted, balance: clamp(channel.balance, P.balance.min, P.balance.max), pan: clamp(withPan.pan, P.pan.min, P.pan.max),
      timbre: channel.timbre === null ? null : normalizeTimbre(channel.timbre, rawBpm) };
  });
  const bus = (b: BusSettings): BusSettings => ({ gainEnabled: b.gainEnabled, gainDb: bounded(b.gainDb, LIMITS.busGainDb), effects: [effect(b.effects[0], 'chorus'), effect(b.effects[1], 'reverb')] });
  const song = ['KOROGI-Lab/session-v21', 'KOROGI-Lab/session-v22', 'KOROGI-Lab/session-v23'].includes(value.formatVersion) ? normalizeSongSettings(value.song) : legacySong(value, channels).song;
  // The time mode is app-wide (ADR 0010): a Session that stretched any timbre opens in Bars.
  if (channels.some(channel => channel.timbre?.sequence.stretch)) song.timingMode = 'bars';
  return { formatVersion: 'KOROGI-Lab/session-v23', name: value.name.trim() || 'Untitled', savedAt: value.savedAt,
    channels, near: bus(value.near), far: bus(value.far), crossfade: clamp(value.crossfade, P.crossfade.min / 100, P.crossfade.max / 100), masterGainDb: bounded(value.masterGainDb, LIMITS.masterGainDb), masterMuted: value.masterMuted,
    song };
}

/**
 * Song of a Session saved before SongFrame (ADR 0011). Each timbre takes the old per-number bars as its Pattern bars
 * (session-v17 and older had none: one bar). The Frame becomes the longest Song section, so `merged` reports the
 * Frame when any section had another length.
 */
function legacySong(value: SessionDocument, channels: SessionDocument['channels']): { song: SongSettings; merged: number | null } {
  const raw = value.song as unknown;
  const saved = isRecord(raw) ? capSavedSongBars(raw) as Record<string, unknown> : {};
  const format: string = value.formatVersion;
  const timing = format === 'KOROGI-Lab/session-v20' ? saved
    : format === 'KOROGI-Lab/session-v19' ? { ...saved, speed: 1 }
      : format === 'KOROGI-Lab/session-v18' ? { ...saved, timingMode: 'bars', speed: 1 } : null;
  const fallback = defaultSongSettings();
  const bars = timing ? legacySongBars(timing) : defaultPatternBars();
  const timbres = channels.flatMap(channel => channel.timbre ? [channel.timbre] : []);
  for (const timbre of timbres) timbre.patternBars = [...bars] as PatternBars;
  const frameBars = frameBarsForSong(timbres) ?? fallback.frameBars;
  const sections = USER_PATTERN_IDS.flatMap((id, index) => timbres.some(timbre => {
    const gate = timbre.gatePatterns.find(item => item.id === id);
    return !!gate?.recording && gate.inSong;
  }) ? [index] : []);
  const merged = sections.some(index => bars[index] !== frameBars) ? frameBars : null;
  const song = timing ? { bpm: timing.bpm as number, speed: timing.speed as number, timingMode: timing.timingMode as SongSettings['timingMode'], frameBars }
    // Sessions before Song Timing (v17 and older) played in Seconds; they keep it although a new app starts in Bars.
    : { ...fallback, timingMode: 'original' as const, frameBars };
  return { song, merged };
}

function requireFormat(raw: unknown, accepted: readonly string[]): void {
  if (!isRecord(raw) || !accepted.includes(raw.formatVersion as string)) {
    throw new Error(`Unsupported file format: ${accepted.join(' or ')} required. v1 and legacy v4 are not supported because TIMBRE input is now fixed at -18 dB.`);
  }
}

export function parseTimbre(text: string): TimbreDocument {
  return parseTimbreWithNotices(text).timbre;
}

/** `bpm` reads the Pattern bars of a file saved before SongFrame: pass the Session BPM it is loaded into. */
export function parseTimbreWithNotices(text: string, bpm: number = P['song-bpm'].defaultValue): { timbre: TimbreDocument; notices: TimbreLoadNotices } {
  const raw: unknown = JSON.parse(text);
  const timbre = normalizeTimbre(raw, bpm);
  return { timbre, notices: { ...timbreNotices(raw), patternBarsFromSelections: !['KOROGI-Lab/timbre-v18', 'KOROGI-Lab/timbre-v19', 'KOROGI-Lab/timbre-v20', 'KOROGI-Lab/timbre-v21'].includes((raw as { formatVersion?: string }).formatVersion ?? '') } };
}

export function parseSession(text: string): SessionDocument {
  return normalizeSession(JSON.parse(text));
}
/** Lab-specific topology validation; the audio engine accepts other channel counts. */
export function parseLabSession(text: string): SessionDocument {
  return parseLabSessionWithNotices(text).session;
}

export function parseLabSessionWithNotices(text: string): { session: SessionDocument; notices: SessionLoadNotices } {
  const raw: unknown = JSON.parse(text);
  const session = labTopology(normalizeSession(raw));
  const merged = isRecord(raw) && !['KOROGI-Lab/session-v21', 'KOROGI-Lab/session-v22', 'KOROGI-Lab/session-v23'].includes(raw.formatVersion as string)
    ? legacySong(raw as unknown as SessionDocument, session.channels).merged : null;
  const timbres = isRecord(raw) && Array.isArray(raw.channels)
    ? raw.channels.map(channel => (isRecord(channel) ? channel.timbre : null)).filter(timbre => timbre != null) : [];
  return { session, notices: { legacyPitchEnvelopeIgnored: timbres.some(timbre => timbreNotices(timbre).legacyPitchEnvelopeIgnored),
    songBarsCapped: isRecord(raw) && raw.formatVersion !== 'KOROGI-Lab/session-v17' && songBarsAboveLimit(raw.song), songFrameMerged: merged } };
}

function labTopology(session: SessionDocument): SessionDocument {
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
