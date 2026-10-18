import type { AudioEngine } from '../audio/core/AudioEngine';
import { songCell } from '../model/songArrangement';
import { USER_PATTERN_IDS } from '../model/triggerRecording';

/** The SEQUENCE Gate (0 for Auto) and Pitch Pattern number of a timbre, and whether Play or Play All is playing it. */
export type SongRowPlayback = { gate: number; pitch: number; playing: boolean };

/**
 * SONG's timbre × Frame grid: which recorded Pattern each timbre plays in Song. A Frame becomes a Song section
 * while any timbre plays a Gate there; a timbre whose cell is off rests through that section.
 * A tap opens the cell's timbre and Patterns in SEQUENCE and frames the cell; a tap on the framed cell turns it on or off.
 * A tap on a timbre name selects only the timbre. Bars inside the cells show what Play and Play All play: the top bar
 * marks the SEQUENCE Gate Pattern and the bottom bar the Pitch Pattern, as the rows in SEQUENCE; red while it plays.
 */
export class SongArrangement {
  private readonly heads: HTMLElement[] = [];
  private readonly rows = new Map<string, { row: HTMLElement; label: HTMLButtonElement; cells: HTMLButtonElement[] }>();
  private focus: { id: string; frame: number } | null = null;
  private selectedId: string | null = null;

  constructor(private readonly root: HTMLElement, private readonly engine: () => AudioEngine | null,
    private readonly tapped: (id: string, frame: number, focused: boolean) => void,
    private readonly nameTapped: (id: string) => void) {}

  /** Rebuild only when the slot list changes; later syncs update attributes so focus and hover survive. */
  sync(sections: readonly number[]): void {
    const engine = this.engine();
    const ids = engine?.getChannelIds() ?? [];
    if (!this.heads.length || ids.some(id => !this.rows.has(id))) this.build(ids);
    USER_PATTERN_IDS.forEach((_, index) => {
      const head = this.heads[index]!, inSong = sections.includes(index + 1);
      if (head.hasAttribute('data-in-song') !== inSong) head.toggleAttribute('data-in-song', inSong);
      head.title = `Frame ${index + 1}${inSong ? ' is a Chain section' : ' is skipped by Chain'}`;
    });
    for (const [id, { row, label, cells }] of this.rows) {
      const loaded = !!engine?.getChannel(id);
      if (row.hidden === loaded) row.hidden = !loaded;
      if (!loaded) continue;
      const name = `${id}. ${engine!.getTimbreName(id)}`;
      if (label.textContent !== name) { label.textContent = name; label.title = `Select ${name} without changing its Patterns`; }
      cells.forEach((cell, index) => {
        const { gate: gateId, pitch: pitchId, on } = songCell(engine!, id, index + 1);
        const gate = !!engine!.getGateRecording(id, gateId), pitch = !!engine!.getPitchRecording(id, pitchId);
        const recorded = gate || pitch;
        const text = recorded ? `${gate ? 'G' : ''}${pitch ? 'P' : ''}` : '–';
        if (cell.textContent !== text) cell.textContent = text;
        if (cell.hasAttribute('data-empty') === recorded) cell.toggleAttribute('data-empty', !recorded);
        cell.setAttribute('aria-pressed', String(recorded && on));
        cell.dataset.state = !recorded ? 'no recording' : on ? 'plays in Chain' : 'rests in Chain';
        this.label(id, index);
      });
    }
    this.syncFocus();
  }
  /**
   * Mark the selected timbre's row and frame the cell SEQUENCE shows, or nothing. Only the framed cell turns on or
   * off on a tap, so the frame must stay visible while it applies.
   */
  setFocus(selectedId: string, focus: { id: string; frame: number } | null): void {
    if (this.selectedId === selectedId && this.focus?.id === focus?.id && this.focus?.frame === focus?.frame) return;
    this.selectedId = selectedId; this.focus = focus; this.syncFocus();
  }
  /** The Gate and Pitch Pattern each timbre's Play and Play All play (0: Auto Gate), and whether it is playing. */
  setPlayback(rows: ReadonlyMap<string, SongRowPlayback>): void {
    for (const [id, { cells }] of this.rows) {
      const state = rows.get(id);
      cells.forEach((cell, index) => {
        const value = !state ? '' : [index + 1 === state.gate ? 'gate' : '', index + 1 === state.pitch ? 'pitch' : ''].filter(Boolean).join(' ');
        if ((cell.dataset.sequence ?? '') !== value) { if (value) cell.dataset.sequence = value; else delete cell.dataset.sequence; this.label(id, index); }
        const playing = !!value && !!state?.playing;
        if (cell.hasAttribute('data-sequence-playing') !== playing) cell.toggleAttribute('data-sequence-playing', playing);
      });
    }
  }
  /** The Frame Song is playing now, in the same red as the Gate and Pitch buttons. */
  setPlaying(frame: number): void {
    this.heads.forEach((head, index) => {
      const playing = index + 1 === frame;
      if (head.hasAttribute('data-song-playing') !== playing) head.toggleAttribute('data-song-playing', playing);
    });
  }
  private isFocused(id: string, frame: number): boolean { return this.focus?.id === id && this.focus.frame === frame; }
  private syncFocus(): void {
    for (const [id, { row, label, cells }] of this.rows) {
      const selected = this.selectedId === id;
      if (row.hasAttribute('data-selected') !== selected) row.toggleAttribute('data-selected', selected);
      label.setAttribute('aria-pressed', String(selected));
      cells.forEach((cell, index) => {
        const focused = this.isFocused(id, index + 1);
        if (cell.hasAttribute('data-focus') !== focused) cell.toggleAttribute('data-focus', focused);
        this.label(id, index);
      });
    }
  }
  private label(id: string, index: number): void {
    const cell = this.rows.get(id)!.cells[index]!;
    const state = cell.dataset.state ?? 'no recording', focused = this.isFocused(id, index + 1);
    const hint = !focused ? 'tap to edit in SEQUENCE' : state === 'no recording' ? 'selected in SEQUENCE' : 'tap again to turn on or off';
    const sequence = cell.dataset.sequence ? `, Loop uses its ${cell.dataset.sequence.split(' ').map(lane => lane === 'gate' ? 'Gate' : 'Pitch').join(' and ')}` : '';
    cell.setAttribute('aria-label', `Timbre ${id} Frame ${index + 1}: ${state}${sequence}, ${hint}`);
  }
  private build(ids: readonly string[]): void {
    this.root.replaceChildren(); this.heads.length = 0; this.rows.clear();
    const header = document.createElement('div'); header.className = 'song-arrange-row song-arrange-header';
    header.append(Object.assign(document.createElement('span'), { className: 'song-arrange-corner', textContent: 'In Chain' }));
    for (const index of USER_PATTERN_IDS.keys()) {
      const head = Object.assign(document.createElement('span'), { className: 'song-arrange-head', textContent: String(index + 1) });
      this.heads.push(head); header.append(head);
    }
    this.root.append(header);
    for (const id of ids) {
      const row = document.createElement('div'); row.className = 'song-arrange-row'; row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `Timbre ${id} Frames in Chain`);
      const label = Object.assign(document.createElement('button'), { type: 'button', className: 'song-arrange-label', id: `song-arrange-name-${id}` });
      label.addEventListener('click', () => this.nameTapped(id));
      const cells = USER_PATTERN_IDS.map((_, index) => {
        const cell = Object.assign(document.createElement('button'), { type: 'button' });
        cell.id = `song-arrange-${id}-${index + 1}`;
        cell.addEventListener('click', () => this.tapped(id, index + 1, this.isFocused(id, index + 1)));
        return cell;
      });
      row.append(label, ...cells); this.root.append(row);
      this.rows.set(id, { row, label, cells });
    }
  }
}
