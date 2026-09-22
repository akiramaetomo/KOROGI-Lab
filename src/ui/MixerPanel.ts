import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { GateScheduleEvent } from '../audio/types';
import { defaultTimbre, LAB_SLOT_IDS, parseTimbre } from '../model/documents';
import { ManualGateController } from './ManualGateController';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { bindSliderReset } from './sliderTapReset';
import type { SequenceTransport } from './SequenceTransport';

interface GateDisplay { synth?: ChannelSynth; unsubscribe?: () => void; queue: GateScheduleEvent[]; on: boolean }

/** Lab-only slot view; the runtime and documents have no DOM dependency. */
export class MixerPanel {
  readonly manual: ManualGateController;
  selectedId = '1';
  private enabled = false;
  private loading = false;
  private protectedId: string | null = null;
  private expandedId: string | null = '1';
  private readonly displays = new Map<string, GateDisplay>();
  constructor(private readonly root: HTMLElement, private readonly engine: () => AudioEngine | null,
    ensureRunning: (forceAttempt?: boolean) => Promise<void>,
    private readonly selectionChanged: () => void, private readonly report: (message: string) => void,
    private readonly saveTimbre: (id: string) => void, private readonly beforeReplace: (id: string) => void = () => {},
    private readonly transport: () => SequenceTransport) {
    this.manual = new ManualGateController(engine, ensureRunning, id => this.transport().stop(id));
    for (const id of LAB_SLOT_IDS) {
      const card = document.createElement('section'); card.className = 'mixer-slot'; card.dataset.slot = id;
      card.innerHTML = `<div class="slot-summary">
          <div class="slot-heading"><button id="select-${id}" class="slot-select" aria-pressed="false" aria-controls="slot-details-${id}" aria-expanded="false">${id}. <span class="slot-name">Empty</span><span class="slot-muted" hidden> Muted</span></button>
            <button id="play-${id}" class="slot-play" aria-label="Play timbre ${id}" aria-pressed="false"><span class="slot-play-icon" aria-hidden="true"></span></button>
            <button id="gate-${id}" class="slot-gate" aria-label="Hold Trigger for timbre ${id}" aria-pressed="false">TRG</button></div>
          <label class="mix-range">Level <output id="level-readout-${id}">0 dB</output><input id="level-${id}" type="range" aria-label="Slot ${id} level dB"></label>
        </div>
        <div id="slot-details-${id}" class="slot-details" hidden>
          <div class="slot-name-row"><input id="name-${id}" type="text" aria-label="Timbre ${id} name" disabled><button id="mute-${id}" class="slot-mute" aria-pressed="false">Mute</button></div>
          <div class="slot-files"><button id="load-${id}">Load</button><button id="save-${id}">Save</button><button id="standard-${id}">Init</button><button id="clear-${id}">Clear</button><input id="timbre-file-${id}" type="file" accept="application/json,.json" hidden></div>
          <label class="mix-range">Near ↔ Far <output id="balance-readout-${id}">50%</output><input id="balance-${id}" type="range" aria-label="Slot ${id} Near Far balance"></label>
          <div class="slot-pan"><label class="mix-range">Pan <output id="pan-readout-${id}">C</output><input id="pan-${id}" type="range" aria-label="Slot ${id} pan, left to right"></label><div class="slot-pan-scale" aria-hidden="true"><span>L</span><span>C</span><span>R</span></div></div>
        </div>`;
      root.append(card);
      const get = <T extends HTMLElement>(name: string) => card.querySelector<T>(`#${name}-${id}`)!;
      for (const [name, range] of [['level', P.level], ['balance', P.balance], ['pan', P.pan]] as const) {
        const input = get<HTMLInputElement>(name);
        input.min = String(range.min); input.max = String(range.max);
        input.step = String(range.step); input.defaultValue = String(range.defaultValue);
        input.value = input.defaultValue;
      }
      get<HTMLButtonElement>('select').addEventListener('click', () => {
        if (this.protectedId) return;
        this.expandedId = this.expandedId === id ? null : id;
        const selectionChanged = this.selectedId !== id;
        this.selectedId = id;
        this.refresh();
        if (selectionChanged) this.selectionChanged();
      });
      get<HTMLInputElement>('name').addEventListener('change', event => {
        const engine = this.engine();
        if (!engine?.getChannel(id)) return;
        engine.setTimbreName(id, (event.target as HTMLInputElement).value);
        this.refresh();
        if (this.selectedId === id) this.selectionChanged();
      });
      this.manual.bind(get<HTMLButtonElement>('gate'), () => id);
      get<HTMLButtonElement>('play').addEventListener('click', () => { void this.transport().toggle(id); });
      get<HTMLButtonElement>('mute').addEventListener('click', () => { const engine = this.engine(); if (engine) engine.setChannelMix(id, { muted: !engine.getChannelMix(id).muted }); this.refresh(); });
      get<HTMLInputElement>('level').addEventListener('input', event => { this.engine()?.setChannelMix(id, { gainDb: Number((event.target as HTMLInputElement).value) }); this.refresh(); });
      get<HTMLInputElement>('balance').addEventListener('input', event => { this.engine()?.setChannelMix(id, { balance: Number((event.target as HTMLInputElement).value) }); this.refresh(); });
      get<HTMLInputElement>('pan').addEventListener('input', event => { this.engine()?.setChannelMix(id, { pan: Number((event.target as HTMLInputElement).value) }); this.refresh(); });
      for (const name of ['level', 'balance', 'pan']) {
        const slider = get<HTMLInputElement>(name);
        bindSliderReset(slider, () => {
          slider.value = slider.defaultValue;
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      get<HTMLButtonElement>('standard').addEventListener('click', () => { this.beforeReplace(id); this.manual.forgetSource(id); this.engine()?.replaceChannel(id, defaultTimbre()); this.refresh(); this.selectionChanged(); });
      get<HTMLButtonElement>('clear').addEventListener('click', () => { this.beforeReplace(id); this.manual.forgetSource(id); this.engine()?.clearChannel(id); this.refresh(); this.selectionChanged(); });
      const fileInput = get<HTMLInputElement>('timbre-file');
      get<HTMLButtonElement>('load').addEventListener('click', () => fileInput.click());
      get<HTMLButtonElement>('save').addEventListener('click', () => this.saveTimbre(id));
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0]; if (!file || this.loading) return;
        this.loading = true; this.refresh();
        try {
          const timbre = parseTimbre(await file.text());
          this.beforeReplace(id);
          this.manual.forgetSource(id); this.engine()?.replaceChannel(id, timbre); this.refresh(); this.selectionChanged();
          this.report(`Loaded timbre ${id}: ${timbre.name}`);
        } catch (error) { this.report(`Timbre import failed: ${error instanceof Error ? error.message : String(error)}`); }
        finally { this.loading = false; fileInput.value = ''; this.refresh(); }
      });
      this.displays.set(id, { queue: [], on: false });
    }
    this.refresh();
  }
  setEnabled(enabled: boolean, release = true): void { this.enabled = enabled; this.manual.setEnabled(enabled, release); this.refresh(); }
  protectSource(id: string | null): void { this.protectedId = id; this.manual.blockSource(id); this.refresh(); }
  refresh(): void {
    const engine = this.engine();
    for (const [id, display] of this.displays) {
      const card = this.root.querySelector<HTMLElement>(`[data-slot="${id}"]`)!;
      const synth = engine?.getChannel(id);
      if (display.synth !== synth) {
        display.unsubscribe?.(); display.synth = synth; display.queue = []; display.on = false;
        display.unsubscribe = synth?.addGateScheduleListener(event => {
          if (event.kind === 'reset') { display.queue = []; display.on = false; }
          else if (event.kind === 'cancel') display.queue = display.queue.filter(queued => queued.time < event.time);
          else { display.queue.push(event); display.queue.sort((a, b) => a.time - b.time); }
        });
      }
      card.classList.toggle('selected', this.selectedId === id);
      const select = card.querySelector<HTMLButtonElement>('.slot-select')!;
      select.setAttribute('aria-pressed', String(this.selectedId === id));
      select.setAttribute('aria-expanded', String(this.expandedId === id));
      card.querySelector<HTMLElement>(`#slot-details-${id}`)!.hidden = this.expandedId !== id;
      card.querySelector('.slot-name')!.textContent = synth ? engine!.createTimbre(id).name : 'Empty';
      const nameInput = card.querySelector<HTMLInputElement>(`#name-${id}`)!;
      if (document.activeElement !== nameInput) nameInput.value = synth ? engine!.createTimbre(id).name : '';
      card.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(control => {
        const needsSound = /^(gate|play|mute|clear|save|level|balance|pan|name)-/.test(control.id);
        control.disabled = !this.enabled || this.loading || (needsSound && !synth);
        if (this.protectedId && (/^select-/.test(control.id) || (id === this.protectedId && /^(gate|play|load|standard|clear)-/.test(control.id)))) control.disabled = true;
      });
      const play = card.querySelector<HTMLButtonElement>(`#play-${id}`)!;
      const playing = this.transport().isPlaying(id);
      play.setAttribute('aria-pressed', String(playing));
      play.setAttribute('aria-label', `${playing ? 'Stop' : 'Play'} timbre ${id}`);
      if (engine) {
        const mix = engine.getChannelMix(id);
        (card.querySelector(`#level-${id}`) as HTMLInputElement).value = String(mix.gainDb);
        (card.querySelector(`#balance-${id}`) as HTMLInputElement).value = String(mix.balance);
        (card.querySelector(`#pan-${id}`) as HTMLInputElement).value = String(mix.pan);
        card.querySelector(`#level-readout-${id}`)!.textContent = `${mix.gainDb.toFixed(1)} dB`;
        card.querySelector(`#balance-readout-${id}`)!.textContent = `${Math.round(mix.balance * 100)}% Far`;
        card.querySelector(`#pan-readout-${id}`)!.textContent = mix.pan === 0 ? 'C' : `${mix.pan < 0 ? 'L' : 'R'} ${Math.round(Math.abs(mix.pan) * 100)}%`;
        card.querySelector(`#mute-${id}`)!.setAttribute('aria-pressed', String(mix.muted));
        card.querySelector<HTMLElement>('.slot-muted')!.hidden = !mix.muted;
      }
    }
  }
  animate(now: number): boolean {
    for (const [id, display] of this.displays) {
      while (display.queue.length && display.queue[0]!.time <= now) display.on = display.queue.shift()!.kind === 'on';
      const gate = this.root.querySelector<HTMLButtonElement>(`#gate-${id}`)!;
      gate.classList.toggle('on', display.on);
      gate.setAttribute('aria-pressed', String(display.on));
      const play = this.root.querySelector<HTMLButtonElement>(`#play-${id}`)!;
      const playing = this.transport().isPlaying(id);
      play.setAttribute('aria-pressed', String(playing));
      play.setAttribute('aria-label', `${playing ? 'Stop' : 'Play'} timbre ${id}`);
    }
    return this.displays.get(this.selectedId)?.on ?? false;
  }
}
