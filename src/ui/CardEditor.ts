import { rankedEditorWidths, editorCapacity, EDITOR_REFERENCE_WIDTH, EDITOR_UNIT_PX, EDITOR_CARD_GAP, MAX_STACK, type EditorRank } from '../model/editorLayout';

export interface CardDefinition { label: string; rank: EditorRank }
type Layout<T> = T[][];
const units = { small: 2, medium: 3, large: 4 } as const;
const clone = <T>(layout: readonly (readonly T[])[]): Layout<T> => layout.map(column => [...column]);

/** Shared card interactions. Original controls and their listeners survive moves. */
export class CardEditor<T extends string> {
  readonly root = document.createElement('section');
  private readonly row = document.createElement('div');
  private readonly parked = document.createElement('div');
  private readonly empty = document.createElement('p');
  private layout: Layout<T>;
  private drag: { id: T; pointer: number; x: number; y: number; moved: boolean; target: T | null;
    placement: 'before' | 'after' | 'above' | 'below' } | null = null;

  constructor(deck: HTMLElement, private readonly definitions: Record<T, CardDefinition>,
    private readonly cards: Map<T, HTMLElement>, initial: readonly (readonly T[])[],
    private readonly targetAttribute: 'editorTarget' | 'commonTarget',
    private readonly changed: (layout: Layout<T>) => void,
    private readonly hiddenCards: (cards: readonly T[]) => void) {
    this.layout = clone(initial);
    const common = targetAttribute === 'commonTarget';
    this.root.className = common ? 'common-editor' : 'function-editor';
    this.root.setAttribute('aria-label', common ? 'COMMON SPACE editors' : 'Timbre editors');
    this.row.className = 'function-editor-row';
    this.parked.hidden = true;
    this.empty.className = 'editor-empty'; this.empty.textContent = 'Select a block in the signal diagram to edit.';
    this.root.append(this.row, this.parked, this.empty);
    for (const [id, card] of cards) {
      const info = definitions[id];
      card.classList.add(common ? 'space-card' : 'editor-card');
      card.dataset[common ? 'commonCard' : 'editorCard'] = id; card.dataset.rank = info.rank;
      const oldHeading = card.querySelector<HTMLElement>(':scope > .panel-heading');
      const header = document.createElement('div'); header.className = 'panel-heading editor-card-heading';
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'editor-card-handle';
      handle.textContent = info.label;
      handle.setAttribute('aria-label', `${info.label}: drag to place; arrows reorder, Shift+Left/Right stack, Shift+Up/Down separate`);
      const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-card-close';
      close.textContent = '×'; close.setAttribute('aria-label', `Close ${info.label} editor`);
      close.addEventListener('click', () => {
        this.update(this.without(id));
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
      this.bindHandle(handle, id); this.parked.append(card);
    }
    deck.prepend(this.root); this.render();
    new ResizeObserver(() => { if (!this.root.hidden) this.render(); }).observe(this.root);
  }

  get ids(): readonly T[] { return this.layout.flat(); }
  get columns(): readonly (readonly T[])[] { return clone(this.layout); }
  get viewingLabel(): string { return this.layout.map(column => column.map(id => this.definitions[id].label).join(' / ')).join(' · ') || 'Select a block'; }
  private minimumWidth(layout: readonly (readonly T[])[]): number {
    return Math.max(0, layout.reduce((total, column) => total + Math.max(...column.map(id => units[this.definitions[id].rank])), 0) * EDITOR_UNIT_PX - EDITOR_CARD_GAP);
  }
  private without(id: T): Layout<T> { return this.layout.map(column => column.filter(item => item !== id)).filter(column => column.length); }
  private add(id: T): Layout<T> {
    if (this.ids.includes(id)) return clone(this.layout);
    const placed = this.place(id);
    return this.definitions[id].rank === 'large' && this.minimumWidth(placed) > this.visibleWidth() + 1e-6 ? [[id]] : placed;
  }
  private place(id: T): Layout<T> {
    const fits = (layout: Layout<T>) => this.minimumWidth(layout) <= editorCapacity(this.visibleWidth()) * EDITOR_UNIT_PX - EDITOR_CARD_GAP + 1e-6;
    const added = [...clone(this.layout), [id]]; if (fits(added)) return added;
    if (this.definitions[id].rank !== 'large') {
      // Shallow columns fill first, matching placeEditorCard in the layout model.
      for (let depth = 1; depth < MAX_STACK; depth++) {
        for (let index = this.layout.length - 1; index >= 0; index--) {
          const column = this.layout[index]!;
          if (column.length !== depth || this.definitions[column[0]!].rank === 'large') continue;
          const stacked = this.layout.map((entry, at) => at === index ? [...entry, id] : [...entry]);
          if (fits(stacked)) return stacked;
        }
      }
    }
    const replaced = [...clone(this.layout.slice(0, -1)), [id]];
    return fits(replaced) ? replaced : [[id]];
  }
  restore(layout: readonly (readonly T[])[]): void {
    this.cancelDrag(); this.hiddenCards(this.ids.filter(id => !layout.flat().includes(id)));
    this.layout = clone(layout); this.render();
  }
  show(id?: T, focus = false): void {
    this.root.hidden = false;
    if (id) { this.update(this.add(id)); this.reveal(id, focus); }
    else this.render();
  }
  activate(id: T, focus = false): void {
    if (!this.root.hidden && this.ids.includes(id)) this.update(this.without(id));
    else this.show(id, focus);
  }
  hide(): void { this.cancelDrag(); if (!this.root.hidden) this.hiddenCards(this.ids); this.root.hidden = true; this.refreshNodes(); }
  refreshNodes(): void {
    document.querySelectorAll<HTMLButtonElement>(`[${this.targetAttribute === 'editorTarget' ? 'data-editor-target' : 'data-common-target'}]`).forEach(node => {
      node.classList.toggle('active', !this.root.hidden && this.ids.includes(node.dataset[this.targetAttribute] as T));
    });
  }
  private update(layout: Layout<T>): void {
    this.hiddenCards(this.ids.filter(id => !layout.flat().includes(id)));
    this.layout = layout; this.changed(clone(layout)); this.render();
  }
  private render(): void {
    const available = this.visibleWidth();
    const ranks = this.layout.map(column => column.reduce<EditorRank>((rank, id) =>
      units[this.definitions[id].rank] > units[rank] ? this.definitions[id].rank : rank, 'small'));
    const widths = rankedEditorWidths(ranks, available);
    this.row.style.width = `${Math.max(available, this.minimumWidth(this.layout))}px`;
    const visible = new Set(this.ids);
    for (const [id, card] of this.cards) {
      card.hidden = !visible.has(id); card.classList.toggle('active', visible.has(id));
      if (!visible.has(id)) this.parked.append(card);
    }
    const columns = this.layout.map((column, index) => {
      const wrapper = document.createElement('div'); wrapper.className = 'editor-card-column';
      wrapper.style.width = `${widths[index]! * EDITOR_UNIT_PX - EDITOR_CARD_GAP}px`;
      for (const id of column) wrapper.append(this.cards.get(id)!);
      return wrapper;
    });
    this.row.replaceChildren(...columns);
    this.empty.hidden = this.ids.length > 0; this.refreshNodes();
  }
  /** Visible card-row width; narrow screens shrink columns to their minimum before scrolling. */
  private visibleWidth(): number { return this.root.clientWidth > 0 ? Math.max(0, this.root.clientWidth - 16) : EDITOR_REFERENCE_WIDTH; }
  private reveal(id: T, focus: boolean): void {
    const card = this.cards.get(id)!;
    const rootRect = this.root.getBoundingClientRect(), rect = card.getBoundingClientRect();
    if (rect.width > this.root.clientWidth || rect.left < rootRect.left) this.root.scrollLeft += rect.left - rootRect.left - 8;
    else if (rect.right > rootRect.right) this.root.scrollLeft += rect.right - rootRect.right;
    const heading = card.querySelector<HTMLElement>('.editor-card-heading')!.getBoundingClientRect();
    if (heading.top < rootRect.top) this.root.scrollTop += heading.top - rootRect.top - 8;
    else if (heading.bottom > rootRect.bottom) this.root.scrollTop += heading.bottom - rootRect.bottom + 8;
    if (focus) card.querySelector<HTMLButtonElement>('.editor-card-handle')!.focus({ preventScroll: true });
  }
  private location(id: T): [number, number] {
    const column = this.layout.findIndex(items => items.includes(id));
    return [column, column < 0 ? -1 : this.layout[column]!.indexOf(id)];
  }
  private canStack(id: T, target: T): boolean {
    const [column] = this.location(target);
    return this.definitions[id].rank !== 'large' && this.definitions[target].rank !== 'large' && this.layout[column]!.length < MAX_STACK;
  }
  private move(id: T, target: T, placement: 'before' | 'after' | 'above' | 'below'): void {
    if (id === target) return;
    const [sourceColumn] = this.location(id), [targetColumn] = this.location(target);
    if (sourceColumn < 0 || targetColumn < 0) return;
    const stack = placement === 'above' || placement === 'below';
    // Reordering within a column never changes its depth, so only other columns check the limit.
    if (stack && sourceColumn !== targetColumn && !this.canStack(id, target)) return;
    const result = this.without(id);
    const destination = result.findIndex(column => column.includes(target));
    const column = result[destination]!;
    if (stack) column.splice(column.indexOf(target) + (placement === 'below' ? 1 : 0), 0, id);
    else result.splice(destination + (placement === 'after' ? 1 : 0), 0, [id]);
    this.update(result); this.reveal(id, true);
  }
  private cancelDrag(): void {
    const drag = this.drag; this.drag = null;
    if (drag) {
      const handle = this.cards.get(drag.id)?.querySelector<HTMLElement>('.editor-card-handle');
      if (handle?.hasPointerCapture(drag.pointer)) handle.releasePointerCapture(drag.pointer);
    }
    this.row.querySelectorAll<HTMLElement>('.drop-target, .dragging').forEach(node => {
      node.classList.remove('drop-target', 'dragging'); delete node.dataset.dropPlacement;
    });
  }
  private bindHandle(handle: HTMLButtonElement, id: T): void {
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const [column, row] = this.location(id);
      if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        // Stacking left joins the bottom of that column; stacking right joins the top.
        const left = event.key === 'ArrowLeft', adjacent = this.layout[column + (left ? -1 : 1)];
        const target = adjacent?.[left ? adjacent.length - 1 : 0];
        if (target && this.canStack(id, target)) this.move(id, target, left ? 'below' : 'above');
      } else if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const other = this.layout[column]!.find(item => item !== id);
        if (other) this.move(id, other, event.key === 'ArrowUp' ? 'before' : 'after');
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const neighbor = this.layout[column + (event.key === 'ArrowLeft' ? -1 : 1)]?.[0];
        if (neighbor) this.move(id, neighbor, event.key === 'ArrowLeft' ? 'before' : 'after');
      } else {
        const next = row + (event.key === 'ArrowUp' ? -1 : 1), neighbor = this.layout[column]![next];
        if (!neighbor) return;
        const result = clone(this.layout); result[column]![next] = id; result[column]![row] = neighbor;
        this.update(result); this.reveal(id, true);
      }
    });
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); this.cancelDrag();
      this.drag = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, target: null, placement: 'after' };
      handle.setPointerCapture(event.pointerId); handle.focus({ preventScroll: true });
    });
    handle.addEventListener('pointermove', event => {
      const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5 && !drag.moved) return;
      drag.moved = true; this.cards.get(id)!.classList.add('dragging');
      const viewport = this.root.getBoundingClientRect();
      if (event.clientX < viewport.left + 24) this.root.scrollLeft -= 20;
      if (event.clientX > viewport.right - 24) this.root.scrollLeft += 20;
      if (event.clientY < viewport.top + 24) this.root.scrollTop -= 20;
      if (event.clientY > viewport.bottom - 24) this.root.scrollTop += 20;
      let nearest = Infinity;
      for (const candidate of this.ids) {
        if (candidate === id) continue;
        const rect = this.cards.get(candidate)!.getBoundingClientRect();
        const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right);
        const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
        const distance = Math.hypot(dx, dy);
        if (distance >= nearest) continue;
        nearest = distance; drag.target = candidate;
        const horizontal = (event.clientX - rect.left) / rect.width;
        const [sourceColumn] = this.location(id), [targetColumn] = this.location(candidate);
        const heading = this.cards.get(candidate)!.querySelector<HTMLElement>('.editor-card-heading')!.getBoundingClientRect();
        drag.placement = horizontal < .2 ? 'before' : horizontal > .8 ? 'after'
          : (this.canStack(id, candidate) || sourceColumn === targetColumn) ? (event.clientY < heading.top + heading.height / 2 ? 'above' : 'below')
            : event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      }
      for (const [candidate, card] of this.cards) {
        card.classList.toggle('drop-target', candidate === drag.target);
        if (candidate === drag.target) card.dataset.dropPlacement = drag.placement;
        else delete card.dataset.dropPlacement;
      }
    });
    handle.addEventListener('pointerup', event => {
      const drag = this.drag; if (!drag || drag.pointer !== event.pointerId) return;
      this.cancelDrag(); if (drag.moved && drag.target) this.move(id, drag.target, drag.placement);
    });
    handle.addEventListener('pointercancel', () => this.cancelDrag());
    handle.addEventListener('lostpointercapture', () => this.cancelDrag());
  }
}
