import { rankedEditorWidths, editorCapacity, EDITOR_REFERENCE_WIDTH, EDITOR_UNIT_PX, EDITOR_CARD_GAP, type EditorRank } from '../model/editorLayout';

export interface CardDefinition { label: string; rank: EditorRank }

/** Shared card interactions; existing input nodes stay connected throughout reordering. */
export class CardEditor<T extends string> {
  readonly root = document.createElement('section');
  private readonly row = document.createElement('div');
  private readonly empty = document.createElement('p');
  private layout: T[];
  private drag: { id: T; pointer: number; start: number; target: T; moved: boolean } | null = null;
  constructor(deck: HTMLElement, private readonly definitions: Record<T, CardDefinition>,
    private readonly cards: Map<T, HTMLElement>, initial: readonly T[],
    private readonly targetAttribute: 'editorTarget' | 'commonTarget',
    private readonly phase: HTMLElement | null, private readonly changed: (cards: T[]) => void,
    private readonly hiddenCards: (cards: readonly T[]) => void) {
    this.layout = [...initial];
    const common = targetAttribute === 'commonTarget';
    this.root.className = common ? 'common-editor' : 'function-editor';
    this.root.setAttribute('aria-label', common ? 'COMMON SPACE editors' : 'Timbre editors');
    this.row.className = 'function-editor-row';
    this.empty.className = 'editor-empty'; this.empty.textContent = 'Select a block in the signal diagram to edit.';
    if (phase) this.root.append(phase);
    this.root.append(this.row, this.empty);
    for (const [id, card] of cards) {
      const info = definitions[id];
      card.classList.add(common ? 'space-card' : 'editor-card');
      card.dataset[common ? 'commonCard' : 'editorCard'] = id; card.dataset.rank = info.rank;
      const oldHeading = card.querySelector<HTMLElement>(':scope > .panel-heading');
      const header = document.createElement('div'); header.className = 'panel-heading editor-card-heading';
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'editor-card-handle';
      handle.textContent = info.label; handle.setAttribute('aria-label', `${info.label}: drag or use ArrowLeft / ArrowRight to reorder`);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-card-close';
      close.textContent = '×'; close.setAttribute('aria-label', `Close ${info.label} editor`);
      close.addEventListener('click', () => {
        this.update(this.layout.filter(item => item !== id));
        document.querySelector<HTMLButtonElement>(`[${common ? 'data-common-target' : 'data-editor-target'}="${id}"]`)?.focus({ preventScroll: true });
      });
      if (id !== 'near' && id !== 'far') {
        const toggle = card.querySelector<HTMLButtonElement>('[data-block-toggle], #burst-enabled');
        if (toggle) header.append(toggle);
        card.querySelectorAll('legend').forEach(legend => {
          const field = legend.parentElement!;
          field.setAttribute('aria-label', legend.textContent?.trim() || info.label);
          legend.remove();
        });
      }
      header.append(handle);
      const lamp = oldHeading?.querySelector('#gate-lamp-panel'); if (lamp) header.append(lamp);
      header.append(close); oldHeading?.remove(); card.prepend(header);
      this.bindHandle(handle, id); this.row.append(card);
    }
    deck.prepend(this.root); this.render();
    new ResizeObserver(() => { if (!this.root.hidden) this.render(); }).observe(this.root);
  }
  get ids(): readonly T[] { return this.layout; }
  get viewingLabel(): string { return this.layout.map(id => this.definitions[id].label).join(' / ') || 'Select a block'; }
  private minimumWidth(cards: readonly T[]): number {
    return Math.max(0, cards.reduce((total, id) => total + ({ small: 2, medium: 3, large: 4 })[this.definitions[id].rank], 0) * EDITOR_UNIT_PX - EDITOR_CARD_GAP);
  }
  private add(id: T): T[] {
    if (this.layout.includes(id)) return [...this.layout];
    const fits = (cards: T[]) => this.minimumWidth(cards) <= editorCapacity(this.availableWidth()) * EDITOR_UNIT_PX - EDITOR_CARD_GAP + 1e-6;
    const added = [...this.layout, id]; if (fits(added)) return added;
    const replaced = [...this.layout.slice(0, -1), id]; return fits(replaced) ? replaced : [id];
  }
  restore(cards: readonly T[]): void {
    this.cancelDrag();
    this.hiddenCards(this.layout.filter(id => !cards.includes(id)));
    this.layout = [...cards]; this.render();
  }
  show(id?: T, focus = false): void {
    this.root.hidden = false;
    if (id) { this.update(this.add(id)); this.reveal(id, focus); }
    else this.render();
  }
  /** Diagram activation toggles only within the currently visible editing area. */
  activate(id: T, focus = false): void {
    if (!this.root.hidden && this.layout.includes(id)) {
      this.update(this.layout.filter(item => item !== id));
    } else this.show(id, focus);
  }
  hide(): void { this.cancelDrag(); if (!this.root.hidden) this.hiddenCards(this.layout); this.root.hidden = true; this.refreshNodes(); }
  refreshNodes(): void {
    document.querySelectorAll<HTMLButtonElement>(`[${this.targetAttribute === 'editorTarget' ? 'data-editor-target' : 'data-common-target'}]`).forEach(node => {
      node.classList.toggle('active', !this.root.hidden && this.layout.includes(node.dataset[this.targetAttribute] as T));
    });
  }
  private update(cards: T[]): void {
    this.hiddenCards(this.layout.filter(id => !cards.includes(id)));
    this.layout = cards; this.changed([...cards]); this.render();
  }
  private render(): void {
    const available = this.availableWidth();
    const widths = rankedEditorWidths(this.layout.map(id => this.definitions[id].rank), available);
    this.row.style.width = `${Math.max(available, this.minimumWidth(this.layout))}px`;
    if (this.phase) this.phase.style.width = `${available}px`;
    for (const [id, card] of this.cards) {
      const index = this.layout.indexOf(id); card.hidden = index < 0; card.classList.toggle('active', index >= 0);
      if (index >= 0) card.style.setProperty('--card-width', `${widths[index]! * EDITOR_UNIT_PX - EDITOR_CARD_GAP}px`);
    }
    // DOM order follows visual order, so Tab and assistive technology do too.
    this.layout.forEach((id, index) => {
      const card = this.cards.get(id)!;
      if (this.row.children[index] !== card) this.row.insertBefore(card, this.row.children[index] ?? null);
    });
    if (this.phase) this.phase.hidden = !this.layout.some(id => id === 'osc1' || id === 'osc2');
    this.empty.hidden = this.layout.length > 0;
    this.refreshNodes();
  }
  private availableWidth(): number {
    return Math.max(EDITOR_REFERENCE_WIDTH, this.root.clientWidth - 16);
  }
  private reveal(id: T, focus: boolean): void {
    const card = this.cards.get(id)!;
    const rootRect = this.root.getBoundingClientRect(), rect = card.getBoundingClientRect();
    if (rect.width > this.root.clientWidth || rect.left < rootRect.left) this.root.scrollLeft += rect.left - rootRect.left - 8;
    else if (rect.right > rootRect.right) this.root.scrollLeft += rect.right - rootRect.right;
    if (focus) card.querySelector<HTMLButtonElement>('.editor-card-handle')!.focus({ preventScroll: true });
  }
  private move(id: T, target: T): void {
    const from = this.layout.indexOf(id), to = this.layout.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    const cards = [...this.layout]; cards.splice(from, 1); cards.splice(to, 0, id); this.update(cards);
    this.reveal(id, true);
  }
  private cancelDrag(): void {
    const drag = this.drag; this.drag = null;
    if (drag) {
      const handle = this.cards.get(drag.id)?.querySelector<HTMLElement>('.editor-card-handle');
      if (handle?.hasPointerCapture(drag.pointer)) handle.releasePointerCapture(drag.pointer);
    }
    this.row.querySelectorAll('.drop-target, .dragging').forEach(node => node.classList.remove('drop-target', 'dragging'));
  }
  private bindHandle(handle: HTMLButtonElement, id: T): void {
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); const index = this.layout.indexOf(id) + (event.key === 'ArrowLeft' ? -1 : 1);
      const target = this.layout[index]; if (target) this.move(id, target);
    });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); this.cancelDrag();
      this.drag = { id, pointer: event.pointerId, start: event.clientX, target: id, moved: false };
      handle.setPointerCapture(event.pointerId); handle.focus({ preventScroll: true });
    });
    handle.addEventListener('pointermove', event => {
      const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
      if (Math.abs(event.clientX - drag.start) < 5 && !drag.moved) return;
      drag.moved = true; this.cards.get(id)!.classList.add('dragging');
      const viewport = this.root.getBoundingClientRect();
      if (event.clientX < viewport.left + 24) this.root.scrollLeft -= 20;
      if (event.clientX > viewport.right - 24) this.root.scrollLeft += 20;
      let nearest = Infinity;
      for (const candidate of this.layout) {
        const card = this.cards.get(candidate)!, rect = card.getBoundingClientRect();
        const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
        if (distance < nearest) { nearest = distance; drag.target = candidate; }
      }
      for (const [candidate, card] of this.cards) card.classList.toggle('drop-target', candidate === drag.target && candidate !== id);
    });
    handle.addEventListener('pointerup', event => {
      const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
      this.cancelDrag(); if (drag.moved) this.move(id, drag.target);
    });
    handle.addEventListener('pointercancel', () => this.cancelDrag());
    handle.addEventListener('lostpointercapture', () => this.cancelDrag());
  }
}
