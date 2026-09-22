import { equalPower, type AudioEngine } from '../audio/core/AudioEngine';
import type { MixerPanel } from './MixerPanel';
import { LAB_SLOT_IDS } from '../model/documents';

type Port = 'left' | 'right' | 'top' | 'bottom';
interface Connection { from: string; to: string; start: Port; end: Port; control?: boolean; weight?: number; lane?: number; activeSend?: boolean; route?: 'right-down' | 'filter-cutoff' }

/** HTML owns interaction; SVG only renders the current topology in content coordinates. */
export class SignalMap {
  private readonly paths: SVGGElement;
  private readonly svg: SVGSVGElement;
  private readonly observer: ResizeObserver;
  private queued = false;
  private connections: Connection[] = [];
  private page: 0 | 1 = 0;

  constructor(private readonly root: HTMLElement, private readonly engine: () => AudioEngine | null, private readonly mixer: MixerPanel) {
    this.svg = root.querySelector('svg')!;
    this.paths = this.svg.querySelector('.wire-paths')!;
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(root);
    root.querySelectorAll<HTMLElement>('.source-group, .common-space, .bus-group, .output-chain').forEach(element => this.observer.observe(element));
    window.addEventListener('resize', () => this.schedule());
    document.fonts.ready.then(() => this.schedule());
    root.querySelectorAll<HTMLButtonElement>('[data-input-page]').forEach(button => button.addEventListener('click', () => {
      this.page = button.dataset.inputPage === '1' ? 1 : 0;
      this.refresh();
    }));
    this.refresh();
  }

  showSlot(id: string): void {
    this.page = Number(id) > 4 ? 1 : 0;
    this.refresh();
  }

  refresh(): void {
    const engine = this.engine();
    const current = engine?.getChannel(this.mixer.selectedId);
    const name = current ? engine!.createTimbre(this.mixer.selectedId).name : 'Empty';
    this.root.querySelector('#voice-title')!.textContent = `TIMBRE · ${this.mixer.selectedId} / ${name}`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-input-page]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.inputPage) === this.page));
      const containsSelection = (Number(this.mixer.selectedId) > 4) === (button.dataset.inputPage === '1');
      button.dataset.hasSelected = String(containsSelection);
      button.setAttribute('aria-label', `${button.dataset.inputPage === '1' ? '5 to 8' : '1 to 4'}${containsSelection ? ', selected timbre on this page' : ''}`);
    });
    this.root.querySelector('.channel-inputs')!.setAttribute('aria-label', `Parallel signals from channels ${this.page ? '5 to 8' : '1 to 4'}`);
    for (const id of LAB_SLOT_IDS) {
      const input = this.root.querySelector<HTMLElement>(`#flow-input-${id}`)!;
      input.hidden = (Number(id) > 4) !== (this.page === 1);
      input.classList.toggle('selected', this.mixer.selectedId === id);
      input.setAttribute('aria-label', `Timbre ${id}${this.mixer.selectedId === id ? ', selected' : ''}`);
    }
    const c = (from: string, to: string, start: Port = 'right', end: Port = 'left', control = false): Connection => ({ from, to, start, end, control });
    const direct = engine?.getMasterInputMode() === 'fx1-direct';
    this.root.querySelector<HTMLElement>('#flow-fx1-common')!.hidden = direct;
    this.connections = [
      c('osc1', 'mod'), c('mod', 'filter1'), c('filter1', 'aenv'), c('aenv', 'fx1'),
      c('osc2', 'filter2'),
      current?.getSettings().filter2Route === 'filter1-cutoff'
        ? { ...c('filter2', 'filter1', 'right', 'bottom', true), route: 'filter-cutoff' }
        : c('filter2', 'mod', 'top', 'bottom', true),
      c('penv', 'osc1', 'top', 'bottom', true),
      c('penv', 'osc2', 'bottom', 'top', true),
      { ...c('burst', 'aenv', 'top', 'bottom', true), weight: current?.getSettings().burst.enabled ? 1 : 0 },
      ...(direct
        ? [{ ...c('fx1', 'master', 'right', 'top'), route: 'right-down' as const }]
        : [c('fx1', 'fx1-common'), c('balance', 'master')]),
      c('master', 'limiter')
    ];
    for (const id of LAB_SLOT_IDS.slice(this.page * 4, this.page * 4 + 4)) {
      const synth = engine?.getChannel(id);
      const mix = synth ? engine!.getChannelMix(id) : undefined;
      const gains = equalPower(mix?.balance ?? .5);
      for (const [i, bus] of (['near', 'far'] as const).entries()) {
        const gain = synth ? gains[i]! : 0;
        const weight = mix?.muted ? 0 : gain;
        this.connections.push({ ...c(`input-${id}`, `${bus}-input`), weight, lane: (Number(id) - 1) % 4 + 1, activeSend: !!synth && weight > 0 });
      }
    }
    for (const bus of ['near', 'far']) {
      this.connections.push(c(`${bus}-input`, `${bus}-fx2`), c(`${bus}-fx2`, `${bus}-fx3`), c(`${bus}-fx3`, `${bus}-gain`), c(`${bus}-gain`, 'balance'));
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  private draw(): void {
    const origin = this.root.getBoundingClientRect();
    // Absolute SVG dimensions must not keep old scroll extents alive after shrinking.
    this.svg.setAttribute('width', String(this.root.clientWidth));
    this.svg.setAttribute('height', String(this.root.clientHeight));
    this.svg.setAttribute('viewBox', `0 0 ${this.root.clientWidth} ${this.root.clientHeight}`);
    const point = (id: string, port: Port) => {
      const rect = this.root.querySelector<HTMLElement>(`#flow-${id}`)!.getBoundingClientRect();
      return { x: (port === 'left' ? rect.left : port === 'right' ? rect.right : rect.left + rect.width / 2) - origin.left,
        y: (port === 'top' ? rect.top : port === 'bottom' ? rect.bottom : rect.top + rect.height / 2) - origin.top };
    };
    const branchGap = 7.5;
    const entryStart = (bus: 'near' | 'far'): number => point(`${bus}-input`, 'left').y - 1.5 * branchGap;
    const nearStart = entryStart('near'), farStart = entryStart('far');
    this.paths.replaceChildren();
    for (const wire of this.connections) {
      const a = point(wire.from, wire.start), b = point(wire.to, wire.end);
      let d: string;
      if (wire.route === 'right-down' || wire.route === 'filter-cutoff') {
        d = `M ${a.x} ${a.y} H ${b.x} V ${b.y}`;
      } else if (wire.start === 'right' && wire.end === 'left') {
        // Four arrow tips are centered on Σ; the outer sends run horizontally from their inputs.
        const x = wire.lane === undefined ? (a.x + b.x) / 2 : b.x - 26 - wire.lane * 8;
        if (wire.lane !== undefined) b.y = (wire.to === 'near-input' ? nearStart : farStart) + (wire.lane - 1) * branchGap;
        d = Math.abs(a.y - b.y) < 1 ? `M ${a.x} ${a.y} H ${b.x}` : `M ${a.x} ${a.y} H ${x} V ${b.y} H ${b.x}`;
      } else {
        const sameSide = wire.start === wire.end;
        const y = sameSide ? (wire.start === 'top' ? Math.min(a.y, b.y) - 14 : Math.max(a.y, b.y) + 14) : (a.y + b.y) / 2 + (wire.lane ?? 0) * 5;
        d = `M ${a.x} ${a.y} V ${y} H ${b.x} V ${b.y}`;
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', wire.control ? 'control-wire' : 'audio-wire');
      if (wire.activeSend) path.classList.add('send-active');
      path.setAttribute('marker-end', 'url(#wire-arrow)');
      path.dataset.from = wire.from; path.dataset.to = wire.to;
      path.dataset.start = wire.start; path.dataset.end = wire.end;
      path.style.opacity = String(wire.weight === undefined ? .85 : .15 + .85 * wire.weight);
      this.paths.append(path);
    }
  }
}
