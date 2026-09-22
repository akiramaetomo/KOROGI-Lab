import { describe, it, expect } from 'vitest';
import { defaultBus, defaultTimbre, DEFAULT_CHANNEL_MIX, LAB_SLOT_IDS, normalizeTimbre, normalizeSession, parseTimbre, parseLabSession, parseSession } from './documents';
import type { SessionDocument } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';

function session(): SessionDocument {
  return { formatVersion: 'KOROGI-Lab/session-v8', name: 'Four', savedAt: '2026-09-19', channels: ['1', '2', '3', '4'].map(id => ({ id, ...DEFAULT_CHANNEL_MIX, timbre: id === '1' ? defaultTimbre() : null })),
    near: defaultBus(), far: defaultBus(), crossfade: .5, masterGainDb: -18, masterMuted: false };
}
function legacy(assignment = 'mix1') {
  return { formatVersion: 'KOROGI-Lab/0.1-harness-1ch-v4', patchName: 'Legacy', savedAt: 'then', globalDetuneRangeCent: 30,
    channel1: { settings: { ...defaultTimbre().settings, busAssignment: assignment }, detuneNormalized: .4 }, mix1: { ...defaultBus(), gainDb: -7 }, mix2: { ...defaultBus(), gainDb: -12 }, masterGainDb: -22 };
}
describe('Timbre and session boundaries', () => {
  it('loads old AEnv files in Gate mode and persists independent one-shot timing', () => {
    const old = defaultTimbre();
    delete old.settings.ampEnvelope.mode;
    delete old.settings.autoTrigger.oneShotRepeatSec;
    const restored = normalizeTimbre(old);
    expect(restored.settings.ampEnvelope.mode).toBe('gate');
    expect(restored.settings.autoTrigger.oneShotRepeatSec).toBeCloseTo(.5);
    restored.settings.ampEnvelope.mode = 'one-shot';
    restored.settings.autoTrigger.oneShotRepeatSec = .08;
    expect(parseTimbre(JSON.stringify(restored)).settings.autoTrigger).toEqual({
      tonSec: .25, toffSec: .25, oneShotRepeatSec: .08
    });
    Reflect.set(restored.settings.ampEnvelope, 'mode', 'invalid');
    expect(() => normalizeTimbre(restored)).toThrow('AEnv mode');
  });
  it('migrates v6 to BURST OFF and validates current BURST settings', () => {
    const old = defaultTimbre() as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/timbre-v6';
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
    (settings.osc1 as Record<string, unknown>).baseFrequencyHz = 1;
    (settings.osc2 as Record<string, unknown>).baseFrequencyHz = 1000;
    channels[0]!.gainDb = 6;
    const migrated = parseLabSession(JSON.stringify(old));
    expect(migrated.formatVersion).toBe('KOROGI-Lab/session-v8');
    expect(migrated.channels.every(channel => channel.pan === 0)).toBe(true);
    expect(migrated.channels[0]!.timbre?.formatVersion).toBe('KOROGI-Lab/timbre-v7');
    expect(migrated.channels[0]!.timbre?.settings.phaseMode).toBe('free');
    expect(migrated.channels[0]!.timbre?.settings.filter2Route).toBe('mod');
    expect(migrated.channels[0]!.timbre?.settings.filter1CutoffDepthCent).toBe(1200);
    expect(migrated.channels[0]!.timbre?.settings.mod.mode).toBe('am');
    expect(migrated.channels[0]!.timbre?.settings.blocksEnabled.mod).toBe(false);
    expect(migrated.channels[0]!.timbre?.settings.filter1.type).toBe('lowpass');
    expect(migrated.channels[0]!.timbre?.settings.blocksEnabled.filter1).toBe(false);
    expect(migrated.channels[0]!.timbre?.settings.autoTrigger).toEqual({ tonSec: 3, toffSec: .005, oneShotRepeatSec: .5 });
    expect(migrated.channels[0]!.gainDb).toBe(0);
    expect(migrated.channels[0]!.timbre?.settings.osc1.baseFrequencyHz).toBe(P['osc1-frequency'].min);
    expect(migrated.channels[0]!.timbre?.settings.osc2.baseFrequencyHz).toBe(P['osc2-frequency'].max);
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
    expect(normalizeSession(old).channels[0]!.timbre?.patterns.map(pattern => pattern.recording)).toEqual([null, null]);
    const current = session();
    current.channels[0]!.timbre!.patterns[0]!.recording = { durationSec: 12, selectionStartSec: 2, selectionEndSec: 9,
      gates: [{ onSec: 1, offSec: 3 }, { onSec: 8, offSec: 10 }] };
    current.channels[0]!.timbre!.patterns[1]!.recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
      gates: [{ onSec: .2, offSec: .4 }] };
    expect(normalizeSession(current).channels[0]!.timbre!.patterns).toEqual(current.channels[0]!.timbre!.patterns);
    current.channels[0]!.timbre!.patterns[0]!.recording!.gates[1]!.offSec = 13;
    expect(() => normalizeSession(current)).toThrow('trigger gate');
  });
  it('migrates v4 timbre and v5 session to Auto while retaining the User take', () => {
    const old = structuredClone(session()) as unknown as Record<string, unknown>;
    old.formatVersion = 'KOROGI-Lab/session-v5';
    const timbre = (old.channels as Array<Record<string, unknown>>)[0]!.timbre as Record<string, unknown>;
    timbre.formatVersion = 'KOROGI-Lab/timbre-v4'; delete timbre.playbackSource;
    timbre.recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .2 }] };
    const migrated = normalizeSession(old);
    expect(migrated.formatVersion).toBe('KOROGI-Lab/session-v8');
    expect(migrated.channels[0]!.timbre!.playbackSource).toEqual({ kind: 'auto' });
    expect(migrated.channels[0]!.timbre!.patterns[0]!.recording).toEqual(timbre.recording);
    expect(migrated.channels[0]!.timbre!.patterns[1]!.recording).toBeNull();
    expect(migrated.channels[0]!.timbre!.settings.phaseMode).toBe('free');
    const user = defaultTimbre(); user.playbackSource = { kind: 'user', patternId: 'user-1' };
    expect(normalizeTimbre(user).playbackSource).toEqual(user.playbackSource);
    Reflect.set(user, 'playbackSource', { kind: 'user', patternId: 'other' });
    expect(() => normalizeTimbre(user)).toThrow('pattern ID');
    const duplicate = defaultTimbre(); duplicate.patterns[1]!.id = 'user-1';
    expect(() => normalizeTimbre(duplicate)).toThrow('unique');
    const missing = defaultTimbre(); missing.patterns.pop();
    expect(() => normalizeTimbre(missing)).toThrow('User 1 and User 2');
    const oldUnknown = structuredClone(old) as unknown as Record<string, unknown>;
    const oldUnknownTimbre = (oldUnknown.channels as Array<Record<string, unknown>>)[0]!.timbre as Record<string, unknown>;
    oldUnknownTimbre.formatVersion = 'KOROGI-Lab/timbre-v5';
    oldUnknownTimbre.playbackSource = { kind: 'user', patternId: 'unknown' };
    expect(() => normalizeSession(oldUnknown)).toThrow('playback source');
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
