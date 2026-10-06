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
export type EditorLayout = EditorCardId[][];
export const DEFAULT_EDITOR_LAYOUT: readonly (readonly EditorCardId[])[] = [['osc1'], ['osc2']];
// One internal unit is 1/3 AoFW, fixed to the reference iPad geometry.
export const EDITOR_REFERENCE_WIDTH = 908;
export const EDITOR_CARD_GAP = 8;
/** Small and Medium cards stack up to this many per column; Large stays alone. */
export const MAX_STACK = 3;
export const EDITOR_UNIT_PX = (EDITOR_REFERENCE_WIDTH + EDITOR_CARD_GAP) / 6;
const rankMinimum = { small: 2, medium: 3, large: 4 } as const;
const minimum = (id: EditorCardId) => rankMinimum[EDITOR_CARDS[id].rank];
const columnMinimum = (column: readonly EditorCardId[]) => Math.max(...column.map(minimum));
/** Placement capacity keeps the reference six units as its floor on narrow screens. */
export function editorCapacity(width = EDITOR_REFERENCE_WIDTH): number {
  return Math.max(6, (width + EDITOR_CARD_GAP) / EDITOR_UNIT_PX);
}
/** Width capacity follows the visible width down to the columns' minimum units. */
export function editorWidthCapacity(ranks: readonly EditorRank[], width = EDITOR_REFERENCE_WIDTH): number {
  return Math.max(ranks.reduce((total, rank) => total + rankMinimum[rank], 0), (width + EDITOR_CARD_GAP) / EDITOR_UNIT_PX);
}
export function minimumEditorWidth(layout: readonly (readonly EditorCardId[])[]): number {
  return Math.max(0, layout.reduce((total, column) => total + columnMinimum(column), 0) * EDITOR_UNIT_PX - EDITOR_CARD_GAP);
}
export function fitsEditorLayout(layout: readonly (readonly EditorCardId[])[], width = EDITOR_REFERENCE_WIDTH): boolean {
  return layout.reduce((total, column) => total + columnMinimum(column), 0) <= editorCapacity(width) + 1e-6;
}
export function normalizeEditorLayout(raw: unknown, legacy = false): EditorLayout {
  if (!Array.isArray(raw)) throw new Error('Invalid editor layout.');
  const columns = legacy ? raw.map(id => [id]) : raw;
  if (columns.some(column => !Array.isArray(column) || column.length < 1 || column.length > MAX_STACK ||
    column.some(id => typeof id !== 'string' || !Object.hasOwn(EDITOR_CARDS, id)) ||
    (column.length > 1 && column.some(id => EDITOR_CARDS[id as EditorCardId].rank === 'large'))))
    throw new Error('Invalid editor column.');
  const ids = columns.flat();
  if (new Set(ids).size !== ids.length) throw new Error('Editor cards must be unique.');
  return columns.map(column => [...column]) as EditorLayout;
}
function placeEditorCard(layout: readonly (readonly EditorCardId[])[], id: EditorCardId, width: number): EditorLayout {
  const copy = layout.map(column => [...column]);
  if (copy.some(column => column.includes(id))) return copy;
  const added = [...copy, [id]];
  if (fitsEditorLayout(added, width)) return added;
  if (EDITOR_CARDS[id].rank !== 'large') {
    // Shallow columns fill first, so a third card goes only where no single card remains.
    for (let depth = 1; depth < MAX_STACK; depth++) {
      for (let index = copy.length - 1; index >= 0; index--) {
        const column = copy[index]!;
        if (column.length !== depth || EDITOR_CARDS[column[0]!].rank === 'large') continue;
        const stacked = copy.map((entry, at) => at === index ? [...entry, id] : [...entry]);
        if (fitsEditorLayout(stacked, width)) return stacked;
      }
    }
  }
  const replaced = [...copy.slice(0, -1), [id]];
  return fitsEditorLayout(replaced, width) ? replaced : [[id]];
}
/** Adds a card; a Large card that would overflow the visible width is shown alone. */
export function addEditorCard(layout: readonly (readonly EditorCardId[])[], id: EditorCardId, width = EDITOR_REFERENCE_WIDTH): EditorLayout {
  const added = placeEditorCard(layout, id, width);
  return EDITOR_CARDS[id].rank === 'large' && minimumEditorWidth(added) > width + 1e-6 ? [[id]] : added;
}
export function editorCardWidths(layout: readonly (readonly EditorCardId[])[], width = EDITOR_REFERENCE_WIDTH): number[] {
  return rankedEditorWidths(layout.map(column => column.reduce<EditorRank>((rank, id) =>
    minimum(id) > rankMinimum[rank] ? EDITOR_CARDS[id].rank : rank, 'small')), width);
}
export function rankedEditorWidths(ranks: readonly EditorRank[], width = EDITOR_REFERENCE_WIDTH): number[] {
  const allocated = ranks.map(rank => rankMinimum[rank]);
  let remaining = Math.max(0, editorWidthCapacity(ranks, width) - allocated.reduce((a, b) => a + b, 0));
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
