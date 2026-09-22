import { describe, expect, it } from 'vitest';
import { checkShape } from './patch';
import { defaultTimbre, normalizeSession, defaultBus, DEFAULT_CHANNEL_MIX } from './documents';

describe('File validation before audio application', () => {
  it('rejects non-finite controls and invalid switch types', () => {
    const timbre = defaultTimbre();
    const invalid = structuredClone(timbre);
    Reflect.set(invalid.settings.fx1, 'distortionDriveDb', null);
    expect(() => checkShape(invalid, timbre, 'timbre')).toThrow('finite number');
    Reflect.set(invalid.settings.blocksEnabled, 'aenv', 'false');
    expect(() => checkShape(invalid, timbre, 'timbre')).toThrow('boolean');
  });
  it('rejects missing source FX and incorrect shared FX counts', () => {
    const timbre = defaultTimbre();
    const missing = structuredClone(timbre); Reflect.deleteProperty(missing.settings, 'fx1');
    expect(() => checkShape(missing, timbre, 'timbre')).toThrow('fx1');
    for (const count of [0, 1, 3]) {
      const near = defaultBus(); Reflect.set(near, 'effects', Array.from({ length: count }, () => defaultBus().effects[0]));
      expect(() => normalizeSession({ formatVersion: 'KOROGI-Lab/session-v5', name: 'Test', savedAt: '', channels: [{ id: '1', ...DEFAULT_CHANNEL_MIX, timbre }],
        near, far: defaultBus(), crossfade: .5, masterGainDb: -18, masterMuted: false })).toThrow('FX2, FX3');
    }
  });
});
