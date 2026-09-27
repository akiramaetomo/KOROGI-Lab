import { describe, it, expect } from 'vitest';
import { defaultBus, defaultTimbre, DEFAULT_CHANNEL_MIX, LAB_SLOT_IDS, normalizeTimbre, normalizeSession, parseTimbre, parseLabSession, parseSession } from './documents';
import type { SessionDocument } from '../audio/types';
import { PARAMETER_RANGES as P, parameterValueBounds } from '../config/parameterRanges';

function session(): SessionDocument {
  return { formatVersion: 'KOROGI-Lab/session-v15', name: 'Four', savedAt: '2026-09-19', channels: ['1', '2', '3', '4'].map(id => ({ id, ...DEFAULT_CHANNEL_MIX, timbre: id === '1' ? defaultTimbre() : null })),
    near: defaultBus(), far: defaultBus(), crossfade: .5, masterGainDb: -18, masterMuted: false };
}
function legacy(assignment = 'mix1') {
  return { formatVersion: 'KOROGI-Lab/0.1-harness-1ch-v4', patchName: 'Legacy', savedAt: 'then', globalDetuneRangeCent: 30,
    channel1: { settings: { ...defaultTimbre().settings, busAssignment: assignment }, detuneNormalized: .4 }, mix1: { ...defaultBus(), gainDb: -7 }, mix2: { ...defaultBus(), gainDb: -12 }, masterGainDb: -22 };
}
describe('Timbre and session boundaries', () => {
  it('preserves independent Filter Amounts and migrates old documents to zero', () => {
    const timbre = defaultTimbre();
    timbre.pitchPatterns.forEach((item, index) => { item.filterAmountCent = [-4800, 0, 4800][index]!; });
    expect(normalizeTimbre(timbre).pitchPatterns.map(item => item.filterAmountCent)).toEqual([-4800, 0, 4800]);
    const full = session(); full.channels[0]!.timbre = timbre;
    expect(parseLabSession(JSON.stringify(full)).channels[0]!.timbre!.pitchPatterns.map(item => item.filterAmountCent)).toEqual([-4800, 0, 4800]);
    const old = structuredClone(timbre) as unknown as Record<string, any>;
    old.formatVersion = 'KOROGI-Lab/timbre-v13';
    old.pitchPatterns.forEach((item: Record<string, unknown>) => { delete item.filterAmountCent; });
    expect(normalizeTimbre(old).pitchPatterns.map(item => item.filterAmountCent)).toEqual([0, 0, 0]);
    for (const invalid of [undefined, null, '1200', NaN, Infinity]) {
      const bad = structuredClone(timbre); bad.pitchPatterns[0]!.filterAmountCent = invalid as number;
      expect(() => normalizeTimbre(bad)).toThrow();
    }
    timbre.pitchPatterns[0]!.filterAmountCent = -6000;
    expect(normalizeTimbre(timbre).pitchPatterns[0]!.filterAmountCent).toBe(-4800);
  });
  it('discards old PEnv Amount/Time, keeps the other timbre data, and validates new Release pairs', () => {
    const old = structuredClone(defaultTimbre()) as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/timbre-v9';
    const oldSettings = old.settings as Record<string, unknown>;
    oldSettings.pitchEnvelope = { amount: -.1, transitionTimeSec: .2 };
    oldSettings.autoTrigger = { tonSec: .25, toffSec: .25, oneShotRepeatSec: .5 };
    delete (oldSettings.ampEnvelope as Record<string, unknown>).releaseTiming;
    const migrated = normalizeTimbre(old);
    expect(migrated.formatVersion).toBe('KOROGI-Lab/timbre-v14');
    expect(migrated.settings.pitchEnvelope).toEqual(defaultTimbre().settings.pitchEnvelope);
    expect(migrated.settings.ampEnvelope.releaseTiming).toBe('time');
    const newTimbre = defaultTimbre();
    newTimbre.settings.pitchEnvelope = { mode: 'one-shot', start: -.5, attack: 1, sustain: 0, release: -1,
      attackSec: 0, decaySec: .03, releaseSec: .03, scale: 0, releaseTiming: 'rate' };
    newTimbre.settings.ampEnvelope.releaseCurve = 'linear';
    newTimbre.settings.ampEnvelope.releaseTiming = 'rate';
    expect(normalizeTimbre(newTimbre).settings.pitchEnvelope).toEqual(newTimbre.settings.pitchEnvelope);
    newTimbre.settings.ampEnvelope.releaseCurve = 'exponential';
    expect(() => normalizeTimbre(newTimbre)).toThrow('Rate requires a Linear Release');
  });
  it('loads old AEnv files in Gate mode and migrates the effective Auto repeat', () => {
    const old = defaultTimbre();
    old.formatVersion = 'KOROGI-Lab/timbre-v10' as typeof old.formatVersion;
    delete old.settings.ampEnvelope.mode;
    old.settings.autoTrigger = { tonSec: .25, toffSec: .25 } as unknown as typeof old.settings.autoTrigger;
    const restored = normalizeTimbre(old);
    expect(restored.settings.ampEnvelope.mode).toBe('gate');
    expect(restored.settings.autoTrigger.repeatSec).toBeCloseTo(.5);
    restored.settings.ampEnvelope.mode = 'one-shot';
    restored.settings.autoTrigger.repeatSec = .08;
    expect(parseTimbre(JSON.stringify(restored)).settings.autoTrigger).toEqual({
      tonSec: .25, repeatSec: .08
    });
    Reflect.set(restored.settings.ampEnvelope, 'mode', 'invalid');
    expect(() => normalizeTimbre(restored)).toThrow('AEnv mode');
  });
  it('inherits PEnv mode and effective Auto period from a v10 One-shot timbre', () => {
    const old = defaultTimbre();
    old.formatVersion = 'KOROGI-Lab/timbre-v10' as typeof old.formatVersion;
    old.settings.ampEnvelope.mode = 'one-shot';
    delete (old.settings.pitchEnvelope as Partial<typeof old.settings.pitchEnvelope>).mode;
    old.settings.autoTrigger = { tonSec: .2, toffSec: .3, oneShotRepeatSec: .08 } as unknown as typeof old.settings.autoTrigger;
    const migrated = normalizeTimbre(old);
    expect(migrated.settings.pitchEnvelope.mode).toBe('one-shot');
    expect(migrated.settings.autoTrigger).toEqual({ tonSec: .2, repeatSec: .08 });
    (old.settings.burst as { enabled: boolean }).enabled = true;
    expect(normalizeTimbre(old).settings.autoTrigger.repeatSec).toBeCloseTo(.5);
    const current = defaultTimbre();
    delete (current.settings.pitchEnvelope as Partial<typeof current.settings.pitchEnvelope>).mode;
    expect(() => normalizeTimbre(current)).toThrow('pitchEnvelope.mode must be string');
  });
  it('migrates v6 to BURST OFF and validates current BURST settings', () => {
    const old = defaultTimbre() as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/timbre-v6';
    old.patterns = [{ id: 'user-1', recording: null }, { id: 'user-2', recording: null }];
    old.playbackSource = { kind: 'auto' };
    delete (old.settings as Record<string, unknown>).burst;
    expect(normalizeTimbre(old).settings.burst).toEqual({
      enabled: false, pulseCountMin: 3, pulseCountMax: 3, pulseIntervalSec: .025,
      pulseIntervalJitter: 0, groupPeriodSec: .1, groupPeriodJitter: 0
    });
    const timbre = defaultTimbre(); timbre.settings.ampEnvelope.mode = 'one-shot';
    timbre.settings.burst = { enabled: true, pulseCountMin: 1, pulseCountMax: 3, pulseIntervalSec: .03,
      pulseIntervalJitter: .2, groupPeriodSec: .12, groupPeriodJitter: .1 };
    expect(normalizeTimbre(timbre).settings.burst).toEqual(timbre.settings.burst);
    timbre.settings.ampEnvelope.mode = 'gate';
    expect(normalizeTimbre(timbre).settings.burst.enabled).toBe(false);
    timbre.settings.ampEnvelope.mode = 'one-shot'; timbre.settings.burst.pulseCountMin = 4; timbre.settings.burst.pulseCountMax = 2;
    expect(() => normalizeTimbre(timbre)).toThrow('minimum pulse count');
    timbre.settings.burst.pulseCountMin = 1; timbre.settings.burst.pulseCountMax = 3; timbre.settings.burst.pulseIntervalSec = .251;
    expect(() => normalizeTimbre(timbre)).toThrow('pulse interval');
  });
  it('preserves curve choices and loads older timbres with exponential curves', () => {
    const timbre = defaultTimbre();
    timbre.settings.ampEnvelope.attackCurve = 'linear';
    timbre.settings.ampEnvelope.releaseCurve = 'linear';
    expect(parseTimbre(JSON.stringify(timbre)).settings.ampEnvelope).toMatchObject({
      attackCurve: 'linear', decayCurve: 'exponential', releaseCurve: 'linear'
    });
    const old = structuredClone(timbre);
    delete old.settings.ampEnvelope.attackCurve;
    delete old.settings.ampEnvelope.decayCurve;
    delete old.settings.ampEnvelope.releaseCurve;
    expect(normalizeTimbre(old).settings.ampEnvelope).toMatchObject({
      attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential'
    });
    Reflect.set(timbre.settings.ampEnvelope, 'attackCurve', 'invalid');
    expect(() => normalizeTimbre(timbre)).toThrow('AEnv attackCurve');
  });
  it('round-trips embedded and empty slots without mixing routing into timbres', () => {
    const value = session(); value.channels[0]!.muted = true; value.channels[0]!.balance = .7; value.channels[0]!.pan = -.65;
    value.far.effects[1].type = 'delay'; value.masterMuted = true;
    const restored = parseLabSession(JSON.stringify(value));
    expect(restored.channels.slice(0, 4)).toEqual(value.channels);
    expect(restored.channels.slice(4)).toEqual(LAB_SLOT_IDS.slice(4).map(id => ({ id, ...DEFAULT_CHANNEL_MIX, timbre: null })));
    expect(restored.near).toEqual(value.near);
    expect(restored.far).toEqual(value.far);
    expect(restored.masterMuted).toBe(true);
    const eight = structuredClone(restored);
    eight.channels[7]!.timbre = defaultTimbre('Eighth');
    eight.channels[7]!.gainDb = -12;
    expect(parseLabSession(JSON.stringify(eight))).toEqual(eight);
    expect(parseTimbre(JSON.stringify(value.channels[0]!.timbre))).toEqual(defaultTimbre());
    expect(defaultTimbre().settings).not.toHaveProperty('channelGainDb');
    expect(defaultTimbre().settings.blocksEnabled).not.toHaveProperty('channelGain');
    expect(value.channels[0]!.timbre).not.toHaveProperty('pan');
  });
  it('normalizes all finite ranges and rejects invalid types, non-finite values and enums', () => {
    const timbre = defaultTimbre(); timbre.settings.osc1.baseFrequencyHz = 1234.6; timbre.settings.mod.amOffset = 10;
    timbre.settings.fx1.delayFeedback = 4; timbre.detuneRangeCent = -3;
    const result = normalizeTimbre(timbre);
    expect(result.settings.osc1.baseFrequencyHz).toBe(1235); expect(result.settings.mod.amOffset).toBe(2);
    expect(result.settings.fx1.delayFeedback).toBe(.95); expect(result.detuneRangeCent).toBe(0);
    timbre.settings.osc2.baseFrequencyHz = NaN; expect(() => normalizeTimbre(timbre)).toThrow('finite number');
    timbre.settings.osc2.baseFrequencyHz = 30;
    expect(() => normalizeTimbre({ ...timbre, settings: { ...timbre.settings, fx1: { ...timbre.settings.fx1, type: 'bad' } } })).toThrow('effect type');
    expect(() => normalizeTimbre({ ...timbre, settings: { ...timbre.settings, blocksEnabled: { ...timbre.settings.blocksEnabled, aenv: 'false' } } })).toThrow('boolean');
  });
  it('turns legacy internal OFF choices into the sole block switch without changing bypass', () => {
    const old = session();
    const timbre = old.channels[0]!.timbre!;
    timbre.settings.mod.mode = 'off';
    timbre.settings.filter1.type = 'off';
    timbre.settings.filter2.type = 'off';
    timbre.settings.blocksEnabled.mod = true;
    timbre.settings.blocksEnabled.filter1 = true;
    timbre.settings.blocksEnabled.filter2 = true;
    timbre.settings.fx1.type = 'off'; timbre.settings.fx1.enabled = true;
    old.near.effects[0].type = 'off'; old.near.effects[0].enabled = true;
    old.far.effects[1].type = 'off'; old.far.effects[1].enabled = true;
    const migrated = normalizeSession(old);
    const settings = migrated.channels[0]!.timbre!.settings;
    expect(settings.blocksEnabled.mod).toBe(false);
    expect(settings.blocksEnabled.filter1).toBe(false);
    expect(settings.blocksEnabled.filter2).toBe(false);
    expect(settings.mod.mode).toBe('am');
    expect(settings.filter1.type).toBe('lowpass');
    expect(settings.filter2.type).toBe('lowpass');
    expect(settings.fx1).toMatchObject({ type: 'distortion', enabled: false });
    expect(migrated.near.effects[0]).toMatchObject({ type: 'chorus', enabled: false });
    expect(migrated.far.effects[1]).toMatchObject({ type: 'reverb', enabled: false });
    expect(normalizeSession(migrated)).toEqual(migrated);
  });
  it('migrates v2 routing to MOD and clamps saved values to the edited bounds', () => {
    const old = session() as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/session-v2';
    const channels = old.channels as Array<Record<string, unknown>>;
    const timbre = channels[0]!.timbre as Record<string, unknown>;
    timbre.formatVersion = 'KOROGI-Lab/timbre-v2';
    const settings = timbre.settings as Record<string, unknown>;
    delete settings.filter2Route; delete settings.filter1CutoffDepthCent;
    (settings.mod as Record<string, unknown>).mode = 'off';
    (settings.blocksEnabled as Record<string, unknown>).mod = true;
    (settings.filter1 as Record<string, unknown>).type = 'off';
    (settings.blocksEnabled as Record<string, unknown>).filter1 = true;
    (settings.autoTrigger as Record<string, unknown>).tonSec = 10;
    (settings.autoTrigger as Record<string, unknown>).toffSec = .001;
    (settings.osc1 as Record<string, unknown>).baseFrequencyHz = .01;
    (settings.osc2 as Record<string, unknown>).baseFrequencyHz = 1_000_000;
    channels[0]!.gainDb = 6;
    const migrated = parseLabSession(JSON.stringify(old));
    expect(migrated.formatVersion).toBe('KOROGI-Lab/session-v15');
    expect(migrated.channels.every(channel => channel.pan === 0)).toBe(true);
    expect(migrated.channels[0]!.timbre?.formatVersion).toBe('KOROGI-Lab/timbre-v14');
    expect(migrated.channels[0]!.timbre?.settings.phaseMode).toBe('free');
    expect(migrated.channels[0]!.timbre?.settings.filter2Route).toBe('mod');
    expect(migrated.channels[0]!.timbre?.settings.filter1CutoffDepthCent).toBe(1200);
    expect(migrated.channels[0]!.timbre?.settings.mod.mode).toBe('am');
    expect(migrated.channels[0]!.timbre?.settings.blocksEnabled.mod).toBe(false);
    expect(migrated.channels[0]!.timbre?.settings.filter1.type).toBe('lowpass');
    expect(migrated.channels[0]!.timbre?.settings.blocksEnabled.filter1).toBe(false);
    expect(migrated.channels[0]!.timbre?.settings.autoTrigger).toEqual({ tonSec: 3, repeatSec: 6 });
    expect(migrated.channels[0]!.gainDb).toBe(0);
    expect(migrated.channels[0]!.timbre?.settings.osc1.baseFrequencyHz).toBe(parameterValueBounds(P['osc1-frequency']).min);
    expect(migrated.channels[0]!.timbre?.settings.osc2.baseFrequencyHz).toBe(parameterValueBounds(P['osc2-frequency']).max);
    const invalid = defaultTimbre();
    Reflect.set(invalid.settings, 'filter2Route', 'unknown');
    expect(() => normalizeTimbre(invalid)).toThrow('FILTER2 route');
  });
  it('loads v3 with empty User patterns and preserves two current recordings independently', () => {
    const old = structuredClone(session()) as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/session-v3';
    const channels = old.channels as Array<Record<string, unknown>>;
    const oldTimbre = channels[0]!.timbre as Record<string, unknown>;
    oldTimbre.formatVersion = 'KOROGI-Lab/timbre-v3'; delete oldTimbre.patterns; delete oldTimbre.playbackSource;
    expect(normalizeSession(old).channels[0]!.timbre?.gatePatterns.map(pattern => pattern.recording)).toEqual([null, null, null]);
    const current = session();
    current.channels[0]!.timbre!.gatePatterns[0]!.recording = { durationSec: 12, selectionStartSec: 2, selectionEndSec: 9,
      gates: [{ onSec: 1, offSec: 3 }, { onSec: 8, offSec: 10 }] };
    current.channels[0]!.timbre!.gatePatterns[1]!.recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
      gates: [{ onSec: .2, offSec: .4 }] };
    expect(normalizeSession(current).channels[0]!.timbre!.gatePatterns).toEqual(current.channels[0]!.timbre!.gatePatterns);
    current.channels[0]!.timbre!.gatePatterns[0]!.recording!.gates[1]!.offSec = 13;
    expect(() => normalizeSession(current)).toThrow('trigger gate');
  });
  it('migrates v4 timbre and v5 session to Auto while retaining the User take', () => {
    const old = structuredClone(session()) as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/session-v5';
    const timbre = (old.channels as Array<Record<string, unknown>>)[0]!.timbre as Record<string, unknown>;
    timbre.formatVersion = 'KOROGI-Lab/timbre-v4'; delete timbre.playbackSource;
    timbre.recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .2 }] };
    const migrated = normalizeSession(old);
    expect(migrated.formatVersion).toBe('KOROGI-Lab/session-v15');
    expect(migrated.channels[0]!.timbre!.sequence.gateMode).toBe('auto');
    expect(migrated.channels[0]!.timbre!.gatePatterns[0]!.recording).toEqual(timbre.recording);
    expect(migrated.channels[0]!.timbre!.gatePatterns[1]!.recording).toBeNull();
    expect(migrated.channels[0]!.timbre!.settings.phaseMode).toBe('free');
    const user = defaultTimbre(); user.sequence.gateMode = 'user';
    expect(normalizeTimbre(user).sequence.gateMode).toBe('user');
    Reflect.set(user.sequence, 'gateUserId', 'other');
    expect(() => normalizeTimbre(user)).toThrow('Gate User');
    const duplicate = defaultTimbre(); duplicate.gatePatterns[1]!.id = 'user-1';
    expect(() => normalizeTimbre(duplicate)).toThrow('unique');
    const missing = defaultTimbre(); missing.gatePatterns.pop();
    expect(() => normalizeTimbre(missing)).toThrow('Three Gate and Pitch');
    const oldUnknown = structuredClone(old) as unknown as Record<string, unknown>;
    const oldUnknownTimbre = (oldUnknown.channels as Array<Record<string, unknown>>)[0]!.timbre as Record<string, unknown>;
    oldUnknownTimbre.formatVersion = 'KOROGI-Lab/timbre-v5';
    oldUnknownTimbre.playbackSource = { kind: 'user', patternId: 'unknown' };
    expect(() => normalizeSession(oldUnknown)).toThrow('playback source');
  });
  it('migrates v7 Gate patterns to v8 lanes and round-trips current Pitch data', () => {
    const old = defaultTimbre() as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/timbre-v7';
    delete old.autoSequence;
    old.patterns = [{ id: 'user-1', recording: { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
      gates: [{ onSec: .1, offSec: .4 }] } }, { id: 'user-2', recording: null }];
    const migrated = normalizeTimbre(old);
    expect(migrated.formatVersion).toBe('KOROGI-Lab/timbre-v14');
    expect(migrated.pitchPatterns[2]!.recording).toBeNull();
    expect(migrated.gatePatterns[0]!.recording).toEqual((old.patterns as Array<Record<string, unknown>>)[0]!.recording);
    expect(migrated.pitchPatterns.map(pattern => pattern.recording)).toEqual([null, null, null]);

    migrated.pitchPatterns[2]!.recording = { durationSec: 2, selectionStartSec: .25, selectionEndSec: 1.75,
      points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1, valueNormalized: .5 }, { timeSec: 2, valueNormalized: -.25 }] };
    migrated.pitchPatterns[2]!.pitchScaleCent = 1200;
    migrated.pitchPatterns[2]!.pitchMode = { kind: 'stepped', stepsPerSide: 12, portamentoSec: .08 };
    migrated.sequence.recordSpeed = 2; migrated.sequence.playSpeed = .5;
    migrated.pitchPatterns[1]!.recording = structuredClone(migrated.pitchPatterns[2]!.recording);
    migrated.pitchPatterns[1]!.pitchMode = structuredClone(migrated.pitchPatterns[2]!.pitchMode);
    expect(parseTimbre(JSON.stringify(migrated))).toEqual(migrated);

    migrated.pitchPatterns[1]!.recording!.points[1]!.valueNormalized = 2;
    expect(() => normalizeTimbre(migrated)).toThrow('pitch recording point');
  });
  it('migrates all three v8 Pitch lanes and the selected source without losing values', () => {
    const old = defaultTimbre() as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/timbre-v8';
    const point = (value: number) => ({ durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
      points: [{ timeSec: 0, valueNormalized: value }, { timeSec: 1, valueNormalized: value }] });
    old.autoSequence = { pitchRecording: point(.3), settings: { pitchScaleCent: 0, pitchMode: { kind: 'smooth' }, recordSpeed: 2, playSpeed: .5 } };
    old.patterns = [
      { id: 'user-1', gateRecording: null, pitchRecording: point(.1), settings: { pitchScaleCent: 333, pitchMode: { kind: 'smooth' }, recordSpeed: 3, playSpeed: 3 } },
      { id: 'user-2', gateRecording: null, pitchRecording: point(.2), settings: { pitchScaleCent: 600, pitchMode: { kind: 'smooth' }, recordSpeed: 4, playSpeed: 4 } }
    ];
    old.playbackSource = { kind: 'auto' };
    const migrated = normalizeTimbre(old);
    expect(migrated.pitchPatterns.map(item => item.recording?.points[0]?.valueNormalized)).toEqual([.1, .2, .3]);
    expect(migrated.pitchPatterns.map(item => item.pitchScaleCent)).toEqual([333, 600, 0]);
    expect(migrated.sequence).toEqual({ gateMode: 'auto', gateUserId: 'user-1', pitchUserId: 'user-3', recordSpeed: 2, playSpeed: .5 });
    expect(normalizeTimbre(migrated)).toEqual(migrated);
    old.playbackSource = { kind: 'user', patternId: 'user-2' };
    expect(normalizeTimbre(old).sequence).toEqual({ gateMode: 'user', gateUserId: 'user-2', pitchUserId: 'user-2', recordSpeed: 4, playSpeed: 4 });
    old.playbackSource = { kind: 'user', patternId: 'user-3' };
    expect(() => normalizeTimbre(old)).toThrow('playback source');
  });
  it('migrates v2-v4 sessions to centered pan and validates pan in v5', () => {
    for (const version of [2, 3, 4]) {
      const old = structuredClone(session()) as unknown as Record<string, unknown>;
      old.formatVersion = `KOROGI-Lab/session-v${version}`;
      const channels = old.channels as Array<Record<string, unknown>>;
      channels.forEach(channel => { delete channel.pan; });
      expect(normalizeSession(old).channels.map(channel => channel.pan)).toEqual([0, 0, 0, 0]);
    }
    const value = session(); value.channels[0]!.pan = 2;
    expect(normalizeSession(value).channels[0]!.pan).toBe(1);
    value.channels[0]!.pan = -2;
    expect(normalizeSession(value).channels[0]!.pan).toBe(-1);
    Reflect.deleteProperty(value.channels[0]!, 'pan');
    expect(() => normalizeSession(value)).toThrow('channel.pan');
    Reflect.set(value.channels[0]!, 'pan', Number.NaN);
    expect(() => normalizeSession(value)).toThrow('finite number');
  });
  it('validates topology before application and keeps generic channel counts in the engine format', () => {
    const value = session(); value.channels.pop();
    expect(parseSession(JSON.stringify(value)).channels).toHaveLength(3);
    expect(() => parseLabSession(JSON.stringify(value))).toThrow('slots 1–4 or 1–8');
    const five = session(); five.channels.push({ id: '5', ...DEFAULT_CHANNEL_MIX, timbre: null });
    expect(() => parseLabSession(JSON.stringify(five))).toThrow('no gaps');
    const wrongEight = parseLabSession(JSON.stringify(session())); wrongEight.channels[6]!.id = '9';
    expect(() => parseLabSession(JSON.stringify(wrongEight))).toThrow('no gaps');
    value.channels[1]!.id = '1'; expect(() => normalizeSession(value)).toThrow('unique');
    const missing = session() as unknown as Record<string, unknown>; delete missing.crossfade;
    expect(() => normalizeSession(missing)).toThrow('crossfade');
    const fx = session(); fx.near.effects.pop(); expect(() => normalizeSession(fx)).toThrow('FX2, FX3');
    const invalid = session(); Reflect.set(invalid.channels[0]!, 'timbre', undefined); expect(() => normalizeSession(invalid)).toThrow('timbre');
  });
  it('rejects previous timbre, session and v4 formats with a reference-level explanation', () => {
    for (const formatVersion of ['KOROGI-Lab/timbre-v1', 'KOROGI-Lab/session-v1', 'KOROGI-Lab/0.1-harness-1ch-v4']) {
      const text = JSON.stringify({ ...legacy(), formatVersion });
      expect(() => parseTimbre(text)).toThrow('fixed at -18 dB');
      expect(() => parseSession(text)).toThrow('fixed at -18 dB');
    }
  });
  it('does not revive old formats or accept a whole session as a timbre', () => {
    for (const version of ['', '-v2', '-v3']) {
      const text = JSON.stringify({ ...legacy(), formatVersion: `KOROGI-Lab/0.1-harness-1ch${version}` });
      expect(() => parseTimbre(text)).toThrow(); expect(() => parseSession(text)).toThrow();
    }
    expect(() => parseTimbre(JSON.stringify(session()))).toThrow();
  });
});
