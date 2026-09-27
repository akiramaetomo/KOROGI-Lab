import type { ADSREnvelopeSettings, EnvelopeCurve, ReleaseTiming } from '../audio/types';

/** Shared structure and behavior; each instance owns distinct DOM controls. */
export class ADSREditor {
  private id(phase: string): string { return this.prefix === 'aenv' ? phase : `${this.prefix}-${phase}`; }
  constructor(private readonly root: HTMLElement, private readonly prefix: 'aenv' | 'fenv') {
    const name = prefix === 'aenv' ? 'AEnv' : 'FEnv';
    root.innerHTML = `<legend>${name} / ADSR</legend>
      ${prefix === 'fenv' ? '<label>Amount <span class="unit">cent</span><input id="fenv-amount" data-audio-control type="number" value="0" disabled></label>' : ''}
      <div class="inline-grid four">${['attack', 'decay', 'sustain', 'release'].map(phase =>
        `<label>${phase[0]!.toUpperCase() + phase.slice(1)} <span class="unit">${phase === 'sustain' ? '0..1' : 'ms'}</span>
          <input id="${this.id(phase)}" data-audio-control type="number" value="${phase === 'sustain' ? '.8' : phase === 'attack' ? '5' : phase === 'decay' ? '20' : '30'}" disabled></label>`).join('')}</div>
      <div class="adsr-mode-row ${prefix}-mode-row">
        <div class="adsr-curve-control ${prefix}-curve-control"><label class="choice-field"><span>A/D/R curve</span>
          <select id="${prefix}-curve" data-audio-control hidden disabled><option value="exponential">Exponential</option><option value="linear">Linear</option></select></label>
          <output id="${prefix}-curve-status" aria-live="polite" hidden>Mixed A/D/R curves</output></div>
        <div class="adsr-mode-control ${prefix}-mode-control"><label class="choice-field"><span>Envelope mode</span>
          <select id="${prefix}-mode" data-audio-control hidden disabled><option value="gate">Gate</option><option value="one-shot">One-shot</option></select></label></div>
        <div class="adsr-release-control ${prefix}-release-control"><label class="choice-field"><span>${name} Release</span>
          <select id="${prefix}-release-timing" data-audio-control hidden disabled><option value="time">Time</option><option value="rate">Rate</option></select></label></div>
      </div><small>${prefix === 'aenv' ? 'Rate uses the gain 1 to floor interval as the Release reference.' : 'Amount shifts Filter1 cutoff / BPF center. Rate uses normalized 1 to 0 as the Release reference.'} Rate requires a Linear Release curve.</small>`;
  }

  read(existing: ADSREnvelopeSettings, curve?: EnvelopeCurve, mode?: 'gate' | 'one-shot', timing?: ReleaseTiming): ADSREnvelopeSettings {
    const number = (phase: string) => Number(this.root.querySelector<HTMLInputElement>(`#${this.id(phase)}`)!.value);
    return { attackSec: number('attack') / 1000, decaySec: number('decay') / 1000,
      sustain: number('sustain'), releaseSec: number('release') / 1000,
      attackCurve: curve ?? existing.attackCurve, decayCurve: curve ?? existing.decayCurve,
      releaseCurve: timing === 'rate' ? 'linear' : curve ?? existing.releaseCurve,
      releaseTiming: curve === 'exponential' ? 'time' : timing ?? existing.releaseTiming ?? 'time',
      mode: mode ?? existing.mode };
  }

  sync(settings: ADSREnvelopeSettings, set: (selector: string, value: string | number) => void): void {
    set(`#${this.id('attack')}`, settings.attackSec * 1000); set(`#${this.id('decay')}`, settings.decaySec * 1000);
    set(`#${this.id('sustain')}`, settings.sustain); set(`#${this.id('release')}`, settings.releaseSec * 1000);
    const a = settings.attackCurve ?? 'exponential', d = settings.decayCurve ?? 'exponential', r = settings.releaseCurve ?? 'exponential';
    const mixed = a !== d || a !== r;
    set(`#${this.prefix}-curve`, mixed ? '' : a);
    this.root.querySelector<HTMLElement>(`#${this.prefix}-curve-status`)!.hidden = !mixed;
    set(`#${this.prefix}-mode`, settings.mode ?? 'gate'); set(`#${this.prefix}-release-timing`, settings.releaseTiming ?? 'time');
  }

  wire(changed: (curve?: EnvelopeCurve, mode?: 'gate' | 'one-shot', timing?: ReleaseTiming) => void): void {
    this.root.querySelectorAll<HTMLInputElement>('input').forEach(input => input.addEventListener('change', () => changed()));
    this.root.querySelector<HTMLSelectElement>(`#${this.prefix}-curve`)!.addEventListener('change', event => changed((event.currentTarget as HTMLSelectElement).value as EnvelopeCurve));
    this.root.querySelector<HTMLSelectElement>(`#${this.prefix}-mode`)!.addEventListener('change', event => changed(undefined, (event.currentTarget as HTMLSelectElement).value as 'gate' | 'one-shot'));
    this.root.querySelector<HTMLSelectElement>(`#${this.prefix}-release-timing`)!.addEventListener('change', event => changed(undefined, undefined, (event.currentTarget as HTMLSelectElement).value as ReleaseTiming));
  }
}
