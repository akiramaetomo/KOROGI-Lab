export const EDITOR_CARDS = {
  osc1: { label: 'OSC1', rank: 'small', panel: 'sources' },
  osc2: { label: 'OSC2', rank: 'small', panel: 'sources' },
  mod: { label: 'MOD', rank: 'small', panel: 'modulation' },
  penv: { label: 'PEnv', rank: 'medium', panel: 'modulation' },
  filter1: { label: 'FILTER1', rank: 'small', panel: 'filters' },
  filter2: { label: 'FILTER2', rank: 'small', panel: 'filters' },
  fenv: { label: 'FEnv', rank: 'medium', panel: 'fenv' },
  aenv: { label: 'AEnv', rank: 'medium', panel: 'amp' },
  burst: { label: 'BURST', rank: 'small', panel: 'burst' },
  fx1: { label: 'FX1', rank: 'small', panel: 'voice-effects' },
  detune: { label: 'DETUNE', rank: 'small', panel: 'output' },
  sequence: { label: 'SEQUENCE', rank: 'large', panel: 'triggering' }
} as const;
export type EditorCardId = keyof typeof EDITOR_CARDS;
export type EditorRank = 'small' | 'medium' | 'large';
export const DEFAULT_EDITOR_LAYOUT: readonly EditorCardId[] = ['osc1', 'osc2'];
// One internal unit is 1/3 AoFW, fixed to the reference iPad geometry.
export const EDITOR_REFERENCE_WIDTH = 908;
export const EDITOR_CARD_GAP = 8;
export const EDITOR_UNIT_PX = (EDITOR_REFERENCE_WIDTH + EDITOR_CARD_GAP) / 6;
const minimum = (id: EditorCardId) => ({ small: 2, medium: 3, large: 4 })[EDITOR_CARDS[id].rank];
export function editorCapacity(width = EDITOR_REFERENCE_WIDTH): number {
  return Math.max(6, (width + EDITOR_CARD_GAP) / EDITOR_UNIT_PX);
}
export function minimumEditorWidth(cards: readonly EditorCardId[]): number {
  return Math.max(0, cards.reduce((total, id) => total + minimum(id), 0) * EDITOR_UNIT_PX - EDITOR_CARD_GAP);
}
export function fitsEditorLayout(cards: readonly EditorCardId[], width = EDITOR_REFERENCE_WIDTH): boolean {
  return cards.reduce((total, id) => total + minimum(id), 0) <= editorCapacity(width) + 1e-6;
}
export function normalizeEditorLayout(raw: unknown): EditorCardId[] {
  if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || !Object.hasOwn(EDITOR_CARDS, id)))
    throw new Error('Invalid editor card ID.');
  if (new Set(raw).size !== raw.length) throw new Error('Editor cards must be unique.');
  const cards = raw as EditorCardId[];
  return [...cards];
}
export function addEditorCard(cards: readonly EditorCardId[], id: EditorCardId, width = EDITOR_REFERENCE_WIDTH): EditorCardId[] {
  if (cards.includes(id)) return [...cards];
  const added = [...cards, id];
  if (fitsEditorLayout(added, width)) return added;
  const replaced = [...cards.slice(0, -1), id];
  return fitsEditorLayout(replaced, width) ? replaced : [id];
}
export function editorCardWidths(cards: readonly EditorCardId[], width = EDITOR_REFERENCE_WIDTH): number[] {
  return rankedEditorWidths(cards.map(id => EDITOR_CARDS[id].rank), width);
}
export function rankedEditorWidths(ranks: readonly EditorRank[], width = EDITOR_REFERENCE_WIDTH): number[] {
  const allocated = ranks.map(rank => ({ small: 2, medium: 3, large: 4 })[rank]);
  let remaining = Math.max(0, editorCapacity(width) - allocated.reduce((a, b) => a + b, 0));
  for (const rank of ['large', 'medium', 'small'] as const) {
    const indices = ranks.flatMap((item, index) => item === rank ? [index] : []);
    if (!indices.length) continue;
    const maximum = { small: 3, medium: 4, large: 6 }[rank];
    const growth = Math.min(maximum - allocated[indices[0]!]!, remaining / indices.length);
    indices.forEach(index => { allocated[index]! += growth; });
    remaining = Math.max(0, remaining - growth * indices.length);
  }
  return allocated;
}
