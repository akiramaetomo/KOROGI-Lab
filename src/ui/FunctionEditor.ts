import { DEFAULT_EDITOR_LAYOUT, EDITOR_CARDS, type EditorCardId, type EditorLayout } from '../model/editorLayout';
import { CardEditor } from './CardEditor';

/** Moves existing controls, never clones inputs or rebuilds the audio graph. */
export class FunctionEditor extends CardEditor<EditorCardId> {
  constructor(deck: HTMLElement, changed: (layout: EditorLayout) => void, hiddenSequence: () => void) {
    const selectors: Partial<Record<EditorCardId, string>> = {
      osc1: '#osc1-type', osc2: '#osc2-type', mod: '#mod-mode', penv: '#penv-start',
      filter1: '#filter1-type', filter2: '#filter2-type'
    };
    const cards = new Map<EditorCardId, HTMLElement>();
    for (const id of Object.keys(EDITOR_CARDS) as EditorCardId[]) {
      const info = EDITOR_CARDS[id];
      let card: HTMLElement;
      if (selectors[id]) {
        card = document.createElement('section'); card.className = 'function-panel'; card.dataset.panel = info.panel;
        card.append(deck.querySelector(selectors[id]!)!.closest('fieldset')!);
        if (id === 'osc1' || id === 'osc2') {
          card.append(deck.querySelector<HTMLElement>(`.source-phase-row[data-osc="${id}"]`)!);
        }
        if (id === 'mod') card.append(deck.querySelector('#mod-path-label')!);
      } else card = deck.querySelector<HTMLElement>(`[data-panel="${info.panel}"]`)!;
      cards.set(id, card);
    }
    for (const panel of ['sources', 'modulation', 'filters']) deck.querySelector(`[data-panel="${panel}"]`)?.remove();
    const targets: Record<string, EditorCardId> = {
      'flow-osc1': 'osc1', 'flow-osc2': 'osc2', 'flow-penv': 'penv', 'flow-mod': 'mod',
      'flow-filter1': 'filter1', 'flow-filter2': 'filter2', 'flow-aenv': 'aenv', 'flow-fenv': 'fenv', 'flow-burst': 'burst',
      'flow-fx1': 'fx1', 'flow-detune': 'detune', 'trigger-menu': 'sequence'
    };
    for (const [nodeId, id] of Object.entries(targets)) document.getElementById(nodeId)!.dataset.editorTarget = id;
    super(deck, EDITOR_CARDS, cards, DEFAULT_EDITOR_LAYOUT, 'editorTarget', changed,
      hidden => { if (hidden.includes('sequence')) hiddenSequence(); });
  }
}
