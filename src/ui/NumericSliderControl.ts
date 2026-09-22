const SLIDER_MAX = 10000;
import { parameterForInput, type ParameterRange } from '../config/parameterRanges';
import { bindSliderReset } from './sliderTapReset';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Two input gestures edit one existing numeric value; no extra patch state. */
export class NumericSliderControl {
  private readonly coarse: HTMLInputElement;
  private readonly fine: HTMLInputElement | null;
  private readonly min: number;
  private readonly max: number;
  private readonly logarithmic: boolean;
  private readonly fineMode: ParameterRange['fine'];
  private readonly fineRatio: number;
  private readonly fineHalfSpan: number;
  private readonly precision: number;
  private readonly finePrecision: number;
  private readonly axis: 'horizontal' | 'vertical';
  private readonly unit: string;
  private readonly caption: string;
  private readonly scales = new Map<'coarse' | 'fine', HTMLElement>();
  private guide: HTMLElement | null = null;
  private fineAnchor: number;
  private lastValue: number;
  private sliderSource: 'coarse' | 'fine' | null = null;

  constructor(private readonly numberInput: HTMLInputElement) {
    this.min = Number(numberInput.dataset.numericMin);
    this.max = Number(numberInput.dataset.numericMax);
    const specification = parameterForInput(numberInput.id);
    if (!specification) throw new Error(`parameterRanges.ts: missing ${numberInput.id}`);
    this.logarithmic = specification.scale === 'log';
    this.fineMode = specification.fine;
    this.fineRatio = this.fineMode.startsWith('ratio-') ? Number(this.fineMode.split('-')[1]) / 100 : 0;
    const step = Number(numberInput.dataset.numericStep);
    const hasFine = this.fineMode !== 'none';
    this.fineHalfSpan = (this.max - this.min) * .01;
    this.precision = Math.max(0, Math.ceil(-Math.log10(step)));
    this.finePrecision = numberInput.dataset.numericInteger === 'true' ? 0 : Math.min(6, this.precision + 2);
    this.axis = specification.axis;
    this.fineAnchor = Number(numberInput.value);
    this.lastValue = this.fineAnchor;

    const label = numberInput.parentElement!;
    const switches = [...label.querySelectorAll<HTMLButtonElement>('.flow-toggle')];
    const caption = [...label.childNodes].filter((node) => node !== numberInput && !switches.includes(node as HTMLButtonElement))
      .map((node) => node.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
    this.caption = caption;
    this.unit = specification.unit;
    const wrapper = document.createElement('div');
    wrapper.className = `numeric-control ${label.className}`.trim();
    wrapper.hidden = label.hidden;
    wrapper.dataset.numericControl = numberInput.id;
    wrapper.dataset.axis = this.axis;
    const heading = document.createElement('div');
    heading.className = 'numeric-heading';
    const title = document.createElement('label');
    title.htmlFor = numberInput.id;
    title.className = 'numeric-caption';
    title.textContent = caption;
    heading.append(title, ...switches);
    const axes = document.createElement('div');
    axes.className = 'numeric-slider-axes';
    this.coarse = this.makeAxis(axes, 'coarse', hasFine ? 'Coarse' : '');
    this.fine = hasFine ? this.makeAxis(axes, 'fine', 'Fine') : null;
    if (!this.logarithmic) {
      const coarseStep = Number(numberInput.dataset.numericCoarseStep ?? step);
      this.coarse.step = String(coarseStep / (this.max - this.min) * SLIDER_MAX);
      if (this.fine && this.fineMode === 'span-1-percent') {
        this.fine.step = String(Math.max(1, 10 ** -this.finePrecision / (2 * this.fineHalfSpan) * SLIDER_MAX));
      }
    }
    label.replaceWith(wrapper);
    wrapper.append(heading, numberInput, axes);

    this.coarse.addEventListener('input', () => {
      const position = Number(this.coarse.value) / SLIDER_MAX;
      const value = this.logarithmic
        ? this.min * (this.max / this.min) ** position
        : this.min + (this.max - this.min) * position;
      this.commit(value, 'coarse');
    });
    this.fine?.addEventListener('input', () => {
      const offset = 2 * Number(this.fine!.value) / SLIDER_MAX - 1;
      this.commit(this.fineValue(offset), 'fine');
    });
    bindSliderReset(this.coarse, () => this.commit(Number(this.numberInput.defaultValue), 'coarse'));
    if (this.fine) bindSliderReset(this.fine, () => this.commit(this.fineAnchor, 'fine'));
    numberInput.addEventListener('change', () => this.sync(this.sliderSource !== 'fine'));
    numberInput.addEventListener('wheel', (event) => {
      const delta = event.deltaY || event.deltaX;
      if (numberInput.disabled || event.ctrlKey || delta === 0) return;
      event.preventDefault();
      // Reuse caret-digit editing, including the current numeric bounds.
      numberInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: delta < 0 ? 'ArrowUp' : 'ArrowDown', shiftKey: event.shiftKey, bubbles: true, cancelable: true
      }));
    }, { passive: false });
    for (const range of [this.coarse, this.fine]) {
      if (!range) continue;
      range.addEventListener('keydown', (event) => {
        if (range !== this.fine || numberInput.dataset.numericInteger !== 'true' || range.disabled) return;
        if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return;
        event.preventDefault();
        const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : -1;
        this.commit(Number(this.numberInput.value) + direction * (event.shiftKey ? 10 : 1), 'fine');
      });
      range.addEventListener('wheel', (event) => {
        const delta = event.deltaY || event.deltaX;
        if (range.disabled || event.ctrlKey || delta === 0) return;
        event.preventDefault();
        if (range === this.fine && numberInput.dataset.numericInteger === 'true') {
          this.commit(Number(this.numberInput.value) + (delta < 0 ? 1 : -1) * (event.shiftKey ? 10 : 1), 'fine');
          return;
        }
        if (range === this.coarse && !this.logarithmic) {
          const coarseStep = Number(numberInput.dataset.numericCoarseStep ?? numberInput.dataset.numericStep);
          this.commit(Number(this.numberInput.value) + (delta < 0 ? 1 : -1) * coarseStep * (event.shiftKey ? 10 : 1), 'coarse');
          return;
        }
        const steps = (this.logarithmic ? 100 : 1) * (event.shiftKey ? 10 : 1);
        if (delta < 0) range.stepUp(steps);
        else range.stepDown(steps);
        range.dispatchEvent(new Event('input', { bubbles: true }));
      }, { passive: false });
    }
    new MutationObserver(() => this.syncDisabled()).observe(numberInput, { attributes: true, attributeFilter: ['disabled'] });
    this.sync(true);
  }

  /** Called after programmatic updates such as patch import or Mix selection. */
  sync(recenter = Number(this.numberInput.value) !== this.lastValue): void {
    const value = clamp(Number(this.numberInput.value), this.min, this.max);
    if (!Number.isFinite(value)) return;
    const position = this.positionFor(value);
    this.coarse.value = String(clamp(position * SLIDER_MAX, 0, SLIDER_MAX));
    this.coarse.setAttribute('aria-valuetext', this.numberInput.value);
    this.updateScale('coarse');
    if (this.fine) {
      if (recenter) this.fineAnchor = value;
      const finePosition = (value: number): number => ((this.fineMode === 'cent-100'
        ? 1200 * Math.log2(value / this.fineAnchor) / 100
        : this.fineRatio ? (value / this.fineAnchor - 1) / this.fineRatio
          : (value - this.fineAnchor) / this.fineHalfSpan) + 1) * SLIDER_MAX / 2;
      // The neutral offset remains at the physical center, including near a bound.
      this.fine.value = String(clamp(finePosition(value), 0, SLIDER_MAX));
      this.fine.setAttribute('aria-valuetext', this.numberInput.value);
      this.fine.title = `Fine adjustment around ${this.formatValue(this.fineAnchor)}; center is zero offset`;
      this.updateScale('fine');
    }
    this.lastValue = value;
    this.syncDisabled();
  }

  /** Show a display-only reference on the coarse slider without changing its value or bounds. */
  setGuide(value: number | null, label = ''): void {
    if (value === null || !Number.isFinite(value)) {
      this.guide?.remove();
      this.guide = null;
      return;
    }
    if (!this.guide) {
      this.guide = document.createElement('span');
      this.guide.className = 'numeric-slider-guide';
      this.coarse.parentElement?.append(this.guide);
    }
    this.guide.style.setProperty('--guide-position', `${clamp(this.positionFor(value), 0, 1) * 100}%`);
    this.guide.dataset.overflow = value < this.min ? 'low' : value > this.max ? 'high' : 'none';
    this.guide.title = label;
    this.guide.setAttribute('aria-label', label);
  }

  private syncDisabled(): void {
    this.coarse.disabled = this.numberInput.disabled;
    if (this.fine) this.fine.disabled = this.numberInput.disabled;
  }

  private positionFor(value: number): number {
    return this.logarithmic
      ? Math.log(value / this.min) / Math.log(this.max / this.min)
      : (value - this.min) / (this.max - this.min);
  }

  private formatValue(value: number): string {
    const rounded = Number(value.toFixed(Math.min(3, Math.max(this.precision, 0))));
    if (this.unit === 'ms' && Math.abs(rounded) >= 1000) return `${Number((rounded / 1000).toFixed(2))} s`;
    if (this.unit === 'Hz' && Math.abs(rounded) >= 1000) return `${Number((rounded / 1000).toFixed(2))} kHz`;
    if (this.unit === 'cent' && Math.abs(rounded) >= 1000) return `${Number((rounded / 1000).toFixed(2))}k cent`;
    return `${rounded}${this.unit === '%' || !this.unit ? this.unit : ` ${this.unit}`}`;
  }

  private fineValue(offset: number): number {
    if (this.fineMode === 'cent-100') return this.fineAnchor * 2 ** (100 * offset / 1200);
    if (this.fineRatio) return this.fineAnchor * (1 + this.fineRatio * offset);
    return this.fineAnchor + offset * this.fineHalfSpan;
  }

  private updateScale(kind: 'coarse' | 'fine'): void {
    const scale = this.scales.get(kind)!;
    const ticks = scale.querySelectorAll<HTMLElement>('span');
    if (kind === 'coarse') {
      ticks[0]!.textContent = this.formatValue(this.min);
      ticks[1]!.textContent = this.unit === '%' && this.min === 0 && this.max === 100 ? '50%' : '';
      ticks[2]!.textContent = this.formatValue(this.max);
      return;
    }
    const offsetValue = (direction: -1 | 1): number => clamp(this.fineValue(direction), this.min, this.max);
    const delta = (value: number): string => {
      const frequencyCent = this.fineMode === 'cent-100';
      const relative = this.fineRatio > 0;
      const difference = frequencyCent
        ? 1200 * Math.log2(value / this.fineAnchor)
        : relative ? (value / this.fineAnchor - 1) * 100 : value - this.fineAnchor;
      const unit = frequencyCent ? ' cent' : relative ? '%' : this.unit === '%' ? '%' : this.unit ? ` ${this.unit}` : '';
      return `${difference > 0 ? '+' : ''}${Number(difference.toFixed(1))}${unit}`;
    };
    ticks[0]!.textContent = delta(offsetValue(-1));
    ticks[1]!.textContent = `0${this.fineMode === 'cent-100' ? ' cent' : this.fineRatio || this.unit === '%' ? '%' : this.unit ? ` ${this.unit}` : ''}`;
    ticks[2]!.textContent = delta(offsetValue(1));
  }

  private makeAxis(axes: HTMLElement, kind: 'coarse' | 'fine', name: string): HTMLInputElement {
    const label = document.createElement('label');
    label.className = 'numeric-slider-axis';
    label.dataset.axis = this.axis;
    const range = document.createElement('input');
    range.type = 'range';
    range.id = `${this.numberInput.id}-${kind}`;
    range.min = '0'; range.max = String(SLIDER_MAX); range.step = '1';
    range.dataset.audioControl = '';
    range.dataset.numericSlider = kind;
    range.setAttribute('aria-label', `${this.caption} ${name.toLowerCase()} adjustment`);
    range.setAttribute('aria-orientation', this.axis);
    const text = document.createElement('span');
    text.className = 'numeric-slider-name';
    text.textContent = name;
    const scale = document.createElement('small');
    scale.className = 'slider-scale';
    scale.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    this.scales.set(kind, scale);
    label.append(text, range, scale);
    axes.append(label);
    return range;
  }

  private commit(value: number, source: 'coarse' | 'fine'): void {
    const basePrecision = source === 'fine' ? this.finePrecision : this.precision;
    // Keep relative resolution at the low end of a logarithmic range;
    // rounding 0.1001 Hz to 0.1 would make keyboard movement stick at minimum.
    const precision = this.logarithmic ? Math.min(8, Math.max(basePrecision,
      (source === 'fine' ? 5 : 3) - Math.floor(Math.log10(Math.abs(value))))) : basePrecision;
    this.numberInput.value = String(Number(clamp(value, this.min, this.max).toFixed(precision)));
    this.sliderSource = source;
    try {
      // Reuse sanitization and all existing parameter/application listeners.
      this.numberInput.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      this.sliderSource = null;
    }
  }
}
