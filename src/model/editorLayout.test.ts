import { describe, expect, it } from 'vitest';
import { addEditorCard, editorCardWidths, normalizeEditorLayout, minimumEditorWidth, EDITOR_CARDS } from './editorLayout';
import { defaultTimbre, normalizeTimbre, normalizeSession, defaultBus, DEFAULT_CHANNEL_MIX } from './documents';

describe('editor layout capacity and file boundary', () => {
  it('accepts all bounded combinations, including Large + Small and two Medium cards', () => {
    for (const cards of [['osc1', 'mod', 'filter1'], ['penv', 'aenv'], ['penv', 'osc1'], ['sequence', 'filter1']] as const)
      expect(normalizeEditorLayout(cards)).toEqual(cards);
    expect(editorCardWidths(['osc1', 'mod', 'filter1'])).toEqual([2, 2, 2]);
    expect(editorCardWidths(['sequence', 'filter1'])).toEqual([4, 2]);
    expect(editorCardWidths(['penv', 'aenv'])).toEqual([3, 3]);
    expect(editorCardWidths(['aenv', 'osc1'])).toEqual([4, 2]);
    expect(editorCardWidths(['osc1'])).toEqual([3]);
    expect(editorCardWidths(['penv'])).toEqual([4]);
    expect(editorCardWidths(['sequence'])).toEqual([6]);
  });
  it('appends, reselects, replaces only the rightmost, or falls back to a single card', () => {
    expect(addEditorCard(['osc1'], 'filter1')).toEqual(['osc1', 'filter1']);
    expect(addEditorCard(['osc1', 'filter1'], 'osc1')).toEqual(['osc1', 'filter1']);
    expect(addEditorCard(['osc1', 'filter1', 'mod'], 'osc2')).toEqual(['osc1', 'filter1', 'osc2']);
    expect(addEditorCard(['osc1', 'filter1', 'mod'], 'sequence')).toEqual(['sequence']);
    expect(addEditorCard(['penv', 'aenv'], 'filter1')).toEqual(['penv', 'filter1']);
  });
  it('rejects unknown IDs, duplicate cards and malformed layouts independently of screen width', () => {
    for (const raw of [['bad'], ['osc1', 'osc1'], null, {}, [1]])
      expect(() => normalizeEditorLayout(raw)).toThrow();
  });
  it('round-trips card order and an explicitly empty layout in Timbre and Session files', () => {
    const timbre = { ...defaultTimbre(), editorLayout: normalizeEditorLayout(['filter1', 'osc1']) };
    expect(normalizeTimbre(timbre)).toEqual(timbre);
    const empty = { ...defaultTimbre(), editorLayout: [] };
    const session = normalizeSession({ formatVersion: 'KOROGI-Lab/session-v13', name: 'Editors', savedAt: '',
      channels: [{ id: '1', ...DEFAULT_CHANNEL_MIX, timbre }, { id: '2', ...DEFAULT_CHANNEL_MIX, timbre: empty }],
      near: defaultBus(), far: defaultBus(), crossfade: .5, masterGainDb: -18, masterMuted: false });
    expect(normalizeSession(JSON.parse(JSON.stringify(session)))).toEqual(session);
    expect(session.channels[1]!.timbre!.editorLayout).toEqual([]);
  });
  it('migrates old files to defaults and rejects invalid new metadata', () => {
    const legacy = { ...defaultTimbre(), formatVersion: 'KOROGI-Lab/timbre-v11', editorLayout: ['sequence'] };
    expect(normalizeTimbre(legacy).editorLayout).toEqual(['osc1', 'osc2']);
    for (const raw of [undefined, ['osc1', 'osc1'], ['bad']])
      expect(() => normalizeTimbre({ ...defaultTimbre(), editorLayout: raw })).toThrow();
  });
  it('grows in rank order, shares space equally and stops at fixed upper widths', () => {
    expect(editorCardWidths(['sequence', 'osc1'], minimumEditorWidth(['sequence', 'osc1']) + 100)[0]).toBeGreaterThan(4);
    const boundary = 1366; // 908 + 450 + the 8px gap.
    expect(editorCardWidths(['sequence', 'osc1'], boundary)).toEqual([6, 3]);
    expect(editorCardWidths(['sequence', 'osc1'], 2400)).toEqual([6, 3]);
    const medium = editorCardWidths(['penv', 'aenv'], 1100);
    expect(medium[0]).toBe(medium[1]); expect(medium[0]).toBeGreaterThan(3); expect(medium[0]).toBeLessThan(4);
    expect(addEditorCard(['osc1', 'osc2', 'mod'], 'filter1', 1300)).toEqual(['osc1', 'osc2', 'mod', 'filter1']);
    expect(editorCardWidths(['sequence', 'penv', 'osc1'], 908)).toEqual([4, 3, 2]);
  });
  it('restores every unique card from a wide-screen file on a narrow screen', () => {
    const editorLayout = normalizeEditorLayout(Object.keys(EDITOR_CARDS));
    const timbre = { ...defaultTimbre(), editorLayout };
    expect(normalizeTimbre(JSON.parse(JSON.stringify(timbre))).editorLayout).toEqual(editorLayout);
    expect(editorCardWidths(editorLayout, 320)).toEqual([2, 2, 2, 3, 2, 2, 3, 3, 2, 2, 2, 4]);
  });
});
