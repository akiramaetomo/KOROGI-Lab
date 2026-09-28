import { describe, expect, it } from 'vitest';
import { addEditorCard, editorCardWidths, normalizeEditorLayout, minimumEditorWidth, EDITOR_CARDS } from './editorLayout';
import { defaultTimbre, normalizeTimbre, normalizeSession, defaultBus, DEFAULT_CHANNEL_MIX } from './documents';

describe('editor columns and file boundary', () => {
  it('uses the widest rank in each column and stacks when horizontal capacity is exhausted', () => {
    expect(editorCardWidths([['sequence'], ['osc1', 'filter1']])).toEqual([4, 2]);
    expect(minimumEditorWidth([['sequence'], ['osc1', 'filter1']])).toBeCloseTo(908);
    expect(addEditorCard([['sequence'], ['osc1']], 'filter1')).toEqual([['sequence'], ['osc1', 'filter1']]);
    expect(addEditorCard([['osc1'], ['osc2']], 'filter1')).toEqual([['osc1'], ['osc2'], ['filter1']]);
    expect(addEditorCard([['osc1'], ['osc2'], ['filter1']], 'mod')).toEqual([['osc1'], ['osc2'], ['filter1', 'mod']]);
    expect(addEditorCard([['osc1'], ['osc2'], ['filter1', 'mod']], 'burst')).toEqual([['osc1'], ['osc2', 'burst'], ['filter1', 'mod']]);
    expect(addEditorCard([['sequence'], ['osc1', 'filter1']], 'mod')).toEqual([['sequence'], ['mod']]);
    expect(addEditorCard([['osc1'], ['filter1'], ['mod']], 'sequence')).toEqual([['sequence']]);
  });
  it('validates unique cards, nonempty columns, two-card depth and Large isolation', () => {
    expect(normalizeEditorLayout([['sequence'], ['osc1', 'filter1']])).toEqual([['sequence'], ['osc1', 'filter1']]);
    for (const raw of [null, ['osc1'], [[]], [['bad']], [['osc1', 'osc1']], [['osc1', 'osc2', 'mod']], [['sequence', 'osc1']], [['osc1'], ['osc1']]])
      expect(() => normalizeEditorLayout(raw)).toThrow();
  });
  it('round-trips stacked Timbre and Session layouts and migrates flat v14 layouts', () => {
    const timbre = { ...defaultTimbre(), editorLayout: normalizeEditorLayout([['sequence'], ['osc1', 'filter1']]) };
    expect(normalizeTimbre(timbre)).toEqual(timbre);
    const session = normalizeSession({ formatVersion: 'KOROGI-Lab/session-v16', name: 'Editors', savedAt: '',
      channels: [{ id: '1', ...DEFAULT_CHANNEL_MIX, timbre }], near: defaultBus(), far: defaultBus(), crossfade: .5, masterGainDb: -18, masterMuted: false });
    expect(session.channels[0]!.timbre!.editorLayout).toEqual([['sequence'], ['osc1', 'filter1']]);
    const legacy = { ...defaultTimbre(), formatVersion: 'KOROGI-Lab/timbre-v14', editorLayout: ['filter1', 'osc1'] };
    expect(normalizeTimbre(legacy).editorLayout).toEqual([['filter1'], ['osc1']]);
    const old = { ...defaultTimbre(), formatVersion: 'KOROGI-Lab/timbre-v11', editorLayout: ['sequence'] };
    expect(normalizeTimbre(old).editorLayout).toEqual([['osc1'], ['osc2']]);
  });
  it('retains wide layouts and rank caps across screen widths', () => {
    const layout = Object.keys(EDITOR_CARDS).map(id => [id]) as ReturnType<typeof normalizeEditorLayout>;
    expect(normalizeEditorLayout(layout)).toEqual(layout);
    expect(editorCardWidths([['sequence'], ['osc1']], 1366)).toEqual([6, 3]);
    expect(editorCardWidths([['sequence'], ['osc1']], 2400)).toEqual([6, 3]);
    expect(editorCardWidths(layout, 320)).toHaveLength(layout.length);
  });
});
