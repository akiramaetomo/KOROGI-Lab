import { LIMITS } from '../audio/constants';
import { amplitudeSum, formatPartialTable, normalizeAmplitudes, parsePartialTable, roundHz, spreadPartials } from '../audio/dsp/multiOscillator';
import type { MultiOscillatorSettings, OscillatorSettings, OscPartial, OscVoiceMode } from '../audio/types';

/** What the editor needs from the selected timbre; absent when no timbre is selected. */
export interface MultiOscTarget {
  settings(): OscillatorSettings;
  apply(voiceMode: OscVoiceMode, multi: MultiOscillatorSettings): Promise<void>;
  sampleRate(): number;
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

/**
 * Single/Multi and the Multi definition of one OSC card. The Table shows each oscillator as Hz (Base x ratio);
 * entering or pasting Hz stores the ratio to the current Base, so Base, PEnv and pitch moves keep the ratios.
 */
export class MultiOscEditor {
  private readonly prefix: string;
  private readonly editor: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly sum: HTMLElement;
  private readonly status: HTMLElement;
  private readonly paste: HTMLTextAreaElement;
  private message = '';
  private warning = false;

  constructor(
    oscillator: 1 | 2,
    private readonly target: () => MultiOscTarget | null,
    private readonly setValue: (selector: string, value: number | string) => void,
    private readonly numberValue: (selector: string) => number
  ) {
    const prefix = `osc${oscillator}`;
    this.prefix = prefix;
    this.editor = element(`#${prefix}-multi`);
    this.rows = element(`#${prefix}-multi-rows`);
    this.sum = element(`#${prefix}-multi-sum`);
    this.status = element(`#${prefix}-multi-status`);
    this.paste = element(`#${prefix}-multi-paste`);

    element<HTMLSelectElement>(`#${prefix}-voice-mode`).addEventListener('change', event => {
      const mode = (event.currentTarget as HTMLSelectElement).value as OscVoiceMode;
      void this.commit(current => ({ voiceMode: mode, multi: current.multi }));
    });
    element<HTMLSelectElement>(`#${prefix}-multi-definition`).addEventListener('change', event => {
      const definition = (event.currentTarget as HTMLSelectElement).value as MultiOscillatorSettings['definition'];
      void this.commit(current => ({ voiceMode: current.voiceMode, multi: { ...current.multi, definition } }));
    });
    for (const id of ['count', 'spread']) {
      element<HTMLInputElement>(`#${prefix}-multi-${id}`).addEventListener('change', () => {
        const spread = { count: this.numberValue(`#${prefix}-multi-count`), spreadCent: this.numberValue(`#${prefix}-multi-spread`) };
        void this.commit(current => ({ voiceMode: current.voiceMode, multi: { ...current.multi, spread } }));
      });
    }
    element<HTMLButtonElement>(`#${prefix}-multi-to-table`).addEventListener('click', () => {
      void this.commit(current => ({ voiceMode: current.voiceMode, multi: { ...current.multi, definition: 'table',
        partials: spreadPartials(current.multi.spread.count, current.multi.spread.spreadCent) } }),
      'Spread copied to the Table.');
    });
    element<HTMLButtonElement>(`#${prefix}-multi-add`).addEventListener('click', () => {
      void this.editTable(partials => {
        if (partials.length >= LIMITS.multiCount.max) return null;
        // A new row starts at Base with an equal share of the new count.
        return [...partials, { ratio: 1, amplitude: 1 / (partials.length + 1) }];
      }, `The Table holds at most ${LIMITS.multiCount.max} oscillators.`);
    });
    element<HTMLButtonElement>(`#${prefix}-multi-normalize`).addEventListener('click', () => {
      void this.editTable(partials => normalizeAmplitudes(partials), '', 'Amplitudes scaled to ΣA = 1.');
    });
    element<HTMLButtonElement>(`#${prefix}-multi-apply-paste`).addEventListener('click', () => {
      const target = this.target(); if (!target) return;
      let partials: OscPartial[];
      try {
        partials = parsePartialTable(this.paste.value, target.settings().baseFrequencyHz);
      } catch (error) {
        this.show(error instanceof Error ? error.message : String(error), true);
        return;
      }
      void this.commit(current => ({ voiceMode: 'multi', multi: { ...current.multi, definition: 'table', partials } }),
        `${partials.length} rows applied.`);
    });
    element<HTMLButtonElement>(`#${prefix}-multi-copy`).addEventListener('click', () => {
      const target = this.target(); if (!target) return;
      const settings = target.settings();
      const text = formatPartialTable(settings.multi.partials, settings.baseFrequencyHz);
      this.paste.value = text;
      const copied = navigator.clipboard?.writeText(text);
      if (!copied) { this.paste.select(); this.show('Table placed in the paste box; copy it from there.'); return; }
      copied.then(() => this.show('Table copied (Hz, Amplitude).'), () => {
        this.paste.select(); this.show('Clipboard unavailable; the Table is selected in the paste box.');
      });
    });
  }

  /** Re-render from the selected timbre; call after loads, selection and Base/type changes. */
  refresh(clearMessage = false): void {
    if (clearMessage) { this.message = ''; this.warning = false; }
    const target = this.target();
    if (!target) { this.editor.hidden = true; this.rows.replaceChildren(); return; }
    const settings = target.settings();
    const multi = settings.multi;
    this.setValue(`#${this.prefix}-voice-mode`, settings.voiceMode);
    this.setValue(`#${this.prefix}-multi-definition`, multi.definition);
    this.setValue(`#${this.prefix}-multi-count`, multi.spread.count);
    this.setValue(`#${this.prefix}-multi-spread`, multi.spread.spreadCent);
    this.editor.hidden = settings.voiceMode !== 'multi';
    element<HTMLElement>(`#${this.prefix}-multi-spread-controls`).hidden = multi.definition !== 'spread';
    element<HTMLElement>(`#${this.prefix}-multi-table-controls`).hidden = multi.definition !== 'table';
    this.renderRows(multi.partials, settings.baseFrequencyHz);
    const sounding = multi.definition === 'spread' ? spreadPartials(multi.spread.count, multi.spread.spreadCent) : multi.partials;
    const total = amplitudeSum(multi.partials);
    this.sum.textContent = `ΣA ${total.toFixed(3)}`;
    this.sum.classList.toggle('warning', total > 1 + 1e-9);
    const nyquist = target.sampleRate() / 2;
    const above = sounding.filter(item => item.ratio * settings.baseFrequencyHz >= nyquist).length;
    const notes = [
      settings.sourceType === 'white-noise' ? 'White Noise plays Single; Multi settings are kept.' : '',
      above > 0 ? `${above} oscillator${above > 1 ? 's' : ''} at or above Nyquist (${Math.round(nyquist)} Hz) stay silent.` : '',
      multi.definition === 'table' && total > 1 + 1e-9 ? 'ΣA above 1 can exceed a single waveform\'s peak.' : ''
    ].filter(Boolean);
    const warning = this.warning || notes.length > 0;
    this.status.textContent = [this.message, ...notes].filter(Boolean).join(' ') ||
      `${sounding.length} oscillator${sounding.length > 1 ? 's' : ''} of ${settings.sourceType}.`;
    this.status.classList.toggle('warning', warning);
  }

  private renderRows(partials: readonly OscPartial[], baseHz: number): void {
    // Rows follow the card's other audio controls, which the app enables and disables together.
    const disabled = element<HTMLSelectElement>(`#${this.prefix}-voice-mode`).disabled;
    const name = `${this.prefix.toUpperCase()} Multi`;
    // Tabbing commits a cell and moves on before the re-render; keep the focus on the cell it moved to.
    const focused = this.rows.contains(document.activeElement) ? document.activeElement?.id : undefined;
    this.rows.replaceChildren(...partials.map((partial, index) => {
      const row = document.createElement('div');
      row.className = 'multi-row';
      const number = document.createElement('span'); number.textContent = String(index + 1);
      const hz = this.rowInput(`${this.prefix}-multi-hz-${index + 1}`, roundHz(partial.ratio * baseHz), `${name} ${index + 1} Hz`, disabled);
      const amplitude = this.rowInput(`${this.prefix}-multi-amp-${index + 1}`, Number(partial.amplitude.toFixed(4)), `${name} ${index + 1} Amplitude`, disabled);
      hz.addEventListener('change', () => {
        const value = Number(hz.value);
        if (!(value > 0)) { this.show(`Row ${index + 1}: enter a frequency above 0 Hz.`, true); return; }
        void this.editTable(rows => rows.map((item, at) => at === index
          ? { ratio: Math.min(LIMITS.multiRatio.max, Math.max(LIMITS.multiRatio.min, value / baseHz)), amplitude: item.amplitude } : item));
      });
      amplitude.addEventListener('change', () => {
        const value = Number(amplitude.value);
        if (!Number.isFinite(value)) { this.show(`Row ${index + 1}: enter an amplitude from 0 to 1.`, true); return; }
        void this.editTable(rows => rows.map((item, at) => at === index
          ? { ratio: item.ratio, amplitude: Math.min(LIMITS.multiAmplitude.max, Math.max(LIMITS.multiAmplitude.min, value)) } : item));
      });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×'; remove.dataset.audioControl = '';
      remove.setAttribute('aria-label', `Remove ${name} ${index + 1}`);
      remove.disabled = disabled || partials.length <= LIMITS.multiCount.min;
      remove.addEventListener('click', () => void this.editTable(rows => rows.length > 1 ? rows.filter((_, at) => at !== index) : null));
      row.append(number, hz, amplitude, remove);
      return row;
    }));
    if (focused) document.getElementById(focused)?.focus();
  }

  private rowInput(id: string, value: number, label: string, disabled: boolean): HTMLInputElement {
    const input = document.createElement('input');
    input.id = id; input.type = 'text'; input.inputMode = 'decimal'; input.value = String(value);
    input.dataset.audioControl = ''; input.disabled = disabled; input.setAttribute('aria-label', label);
    return input;
  }

  private async editTable(change: (partials: OscPartial[]) => OscPartial[] | null, refusal = '', done = ''): Promise<void> {
    const target = this.target(); if (!target) return;
    const current = target.settings();
    const partials = change(current.multi.partials.map(item => ({ ...item })));
    if (!partials) { this.show(refusal, true); return; }
    await this.commit(() => ({ voiceMode: current.voiceMode, multi: { ...current.multi, definition: 'table', partials } }), done);
  }

  private async commit(next: (current: OscillatorSettings) => { voiceMode: OscVoiceMode; multi: MultiOscillatorSettings }, done = ''): Promise<void> {
    const target = this.target(); if (!target) return;
    const value = next(target.settings());
    this.message = done; this.warning = false;
    await target.apply(value.voiceMode, value.multi);
    this.refresh();
  }

  private show(message: string, warning = false): void {
    this.message = message; this.warning = warning;
    this.refresh();
  }
}
