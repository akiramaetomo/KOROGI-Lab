import { CardEditor, type CardDefinition } from './CardEditor';

export const COMMON_CARDS = {
  near: { label: 'NEAR', rank: 'medium' }, far: { label: 'FAR', rank: 'medium' },
  'near-gain': { label: 'NEAR GAIN', rank: 'small' }, 'far-gain': { label: 'FAR GAIN', rank: 'small' },
  balance: { label: 'OUTPUT BALANCE', rank: 'small' }, master: { label: 'MASTER', rank: 'small' }
} satisfies Record<string, CardDefinition>;
export type CommonCardId = keyof typeof COMMON_CARDS;

/** Create Far's independent controls before numeric controls and event handlers are mounted. */
export function prepareCommonSpaceCards(deck: HTMLElement): Map<CommonCardId, HTMLElement> {
  const cards = new Map<CommonCardId, HTMLElement>();
  for (const id of Object.keys(COMMON_CARDS) as CommonCardId[]) {
    const card = document.createElement('section'); card.className = 'function-panel';
    card.dataset.panel = id === 'balance' || id === 'master' ? 'space-output' : 'space-effects';
    cards.set(id, card); deck.append(card);
  }
  for (const slot of [2, 3]) {
    const near = deck.querySelector<HTMLElement>(`[data-effect-slot="fx${slot}"]`)!;
    const far = near.cloneNode(true) as HTMLElement; far.dataset.effectSlot = `far-fx${slot}`;
    far.querySelectorAll<HTMLElement>('[id]').forEach(node => { node.id = `far-${node.id}`; });
    cards.get('near')!.append(near); cards.get('far')!.append(far);
  }
  for (const id of ['near-gain', 'far-gain', 'balance', 'master'] as const) {
    const field = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = COMMON_CARDS[id].label; field.append(legend);
    const inputId = id === 'balance' ? 'crossfade' : id === 'master' ? 'master-gain' : id;
    field.append(deck.querySelector(`#${inputId}`)!.closest('label')!);
    if (id === 'master') field.append(deck.querySelector('#master-mute')!);
    cards.get(id)!.append(field);
  }
  deck.querySelector('[data-panel="space-effects"]')!.remove();
  deck.querySelector('[data-panel="space-output"]')!.remove();
  const targets: Record<string, CommonCardId> = {
    'flow-near-fx2': 'near', 'flow-near-fx3': 'near', 'flow-far-fx2': 'far', 'flow-far-fx3': 'far',
    'flow-near-gain': 'near-gain', 'flow-far-gain': 'far-gain', 'flow-balance': 'balance', 'flow-master': 'master'
  };
  for (const [node, id] of Object.entries(targets)) document.getElementById(node)!.dataset.commonTarget = id;
  return cards;
}

export class CommonSpaceEditor extends CardEditor<CommonCardId> {
  constructor(deck: HTMLElement, cards: Map<CommonCardId, HTMLElement>, changed: () => void) {
    super(deck, COMMON_CARDS, cards, [], 'commonTarget', changed, () => {});
    this.hide();
  }
}
