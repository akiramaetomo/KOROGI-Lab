import { describe, expect, it } from 'vitest';
import { defaultBus, defaultTimbre, normalizeSession, normalizeTimbre } from './documents';

describe('FEnv persistence boundary', () => {
  it('preserves independent settings, enabled state and card order in both formats', () => {
    const timbre = defaultTimbre(); timbre.editorLayout = ['fenv', 'aenv'];
    timbre.settings.blocksEnabled.fenv = true;
    Object.assign(timbre.settings.filterEnvelope, { mode: 'one-shot', amountCent: -4800, sustain: 0,
      releaseTiming: 'rate', releaseCurve: 'linear', attackSec: 0, decaySec: 0, releaseSec: 0 });
    const round = normalizeTimbre(JSON.parse(JSON.stringify(timbre)));
    expect(round).toEqual(timbre);
    const session = normalizeSession({ formatVersion: 'KOROGI-Lab/session-v14', name: 'FEnv', savedAt: '',
      channels: [{ id: '1', gainDb: 0, muted: false, balance: .5, pan: 0, timbre }],
      near: defaultBus(), far: defaultBus(), crossfade: .5, masterGainDb: -18, masterMuted: false });
    expect(session.channels[0]!.timbre).toEqual(timbre);
  });

  it('migrates v12 with neutral FEnv and retained empty/card layouts', () => {
    for (const layout of [[], ['filter1', 'aenv']]) {
      const legacy = JSON.parse(JSON.stringify(defaultTimbre())); legacy.formatVersion = 'KOROGI-Lab/timbre-v12';
      legacy.editorLayout = layout; delete legacy.settings.filterEnvelope; delete legacy.settings.blocksEnabled.fenv;
      const result = normalizeTimbre(legacy);
      expect(result.settings.filterEnvelope).toEqual({ ...defaultTimbre().settings.filterEnvelope, amountCent: 0 });
      expect(result.settings.blocksEnabled.fenv).toBe(false); expect(result.editorLayout).toEqual(layout);
    }
  });

  it('rejects missing/nonfinite settings, invalid enums, Rate/Exponential, block types and card IDs', () => {
    const mutations = [
      (x: any) => delete x.settings.filterEnvelope,
      (x: any) => x.settings.filterEnvelope.amountCent = NaN,
      (x: any) => x.settings.filterEnvelope.mode = 'broken',
      (x: any) => x.settings.filterEnvelope.attackCurve = 'broken',
      (x: any) => x.settings.filterEnvelope.releaseTiming = 'rate',
      (x: any) => x.settings.blocksEnabled.fenv = 'true',
      (x: any) => x.editorLayout = ['unknown']
    ];
    for (const mutate of mutations) { const value = defaultTimbre(); mutate(value); expect(() => normalizeTimbre(value)).toThrow(); }
  });
});
