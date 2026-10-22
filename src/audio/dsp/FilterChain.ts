import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import type { FilterOrder, FilterSettings, FilterType } from '../types';
import { firstOrderCoefficients, type FirstOrderType } from './firstOrderFilter';
import { clamp, smoothAudioParam } from './params';

/** An IIRFilterNode cannot change its coefficients; cutoff edits of the 1st order rebuild it at most this often. */
const FIRST_ORDER_REBUILD_MS = 30;

interface FirstOrderStage { filter: IIRFilterNode; fade: GainNode; frequencyHz: number; gainDb: number }

/**
 * Lab keeps a linear Q for every type. Web Audio reads lowpass/highpass Q as the resonance in dB
 * (linear Q = 10^(Q/20)) and bandpass/peaking Q as linear; Shelves ignore it.
 */
export function biquadQ(type: FilterType, q: number): number {
  return type === 'lowpass' || type === 'highpass' ? 20 * Math.log10(q) : q;
}

const FIRST_ORDER_TYPES: readonly FilterType[] = ['lowpass', 'highpass', 'lowshelf', 'highshelf'];

export class FilterChain {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly filterA: BiquadFilterNode;
  private readonly filterB: BiquadFilterNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  /** 1st order (LPF/HPF/Shelf): fixed coefficients, crossfaded on rebuild; it ignores detune modulation. */
  private firstOrder: FirstOrderStage | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly retiring = new Set<{ stage: FirstOrderStage; timer: ReturnType<typeof setTimeout> }>();
  private enabled = true;
  private settings: FilterSettings;

  constructor(private readonly context: AudioContext, initial: FilterSettings) {
    this.input = context.createGain();
    this.output = context.createGain();
    this.filterA = context.createBiquadFilter();
    this.filterB = context.createBiquadFilter();
    this.dryGain = context.createGain();
    this.wetGain = context.createGain();
    this.dryGain.connect(this.output);
    this.wetGain.connect(this.output);
    this.settings = { ...initial, gainDb: initial.gainDb ?? 0 };

    this.applyParams(context.currentTime, false);
    this.rewire();
    this.applyBypass(false);
  }

  setType(type: FilterType): void {
    this.settings.type = type;
    this.applyFilterType();
    this.rewire();
    this.applyBypass(false);
  }

  setOrder(order: FilterOrder): void {
    this.settings.order = order;
    this.applyGain(this.context.currentTime, false);
    this.rewire();
  }

  /** Shelf/Peak gain in dB; a 4th-order stage gives each Biquad half, so the total stays the set gain. */
  setGain(db: number, now = this.context.currentTime): void {
    this.settings.gainDb = clamp(db, LIMITS.filterGainDb.min, LIMITS.filterGainDb.max);
    this.applyGain(now, true);
    if (this.firstOrder && this.firstOrder.gainDb !== this.settings.gainDb) this.scheduleFirstOrderRebuild();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.applyBypass(true);
  }

  setFrequency(hz: number, now = this.context.currentTime): void {
    this.settings.frequencyHz = this.limitFrequency(hz);
    smoothAudioParam(this.filterA.frequency, this.settings.frequencyHz, now, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.filterB.frequency, this.settings.frequencyHz, now, PARAM_SMOOTH_SEC);
    if (this.firstOrder && this.firstOrder.frequencyHz !== this.settings.frequencyHz) this.scheduleFirstOrderRebuild();
  }

  setQ(q: number, now = this.context.currentTime): void {
    this.settings.q = clamp(q, LIMITS.filterQ.min, LIMITS.filterQ.max);
    const value = biquadQ(this.settings.type, this.settings.q);
    smoothAudioParam(this.filterA.Q, value, now, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.filterB.Q, value, now, PARAM_SMOOTH_SEC);
  }

  connectDetune(signal: AudioNode): void {
    signal.connect(this.filterA.detune);
    signal.connect(this.filterB.detune);
  }

  dispose(): void {
    clearTimeout(this.rebuildTimer);
    for (const item of this.retiring) { clearTimeout(item.timer); this.disconnectStage(item.stage); }
    this.retiring.clear();
    if (this.firstOrder) this.disconnectStage(this.firstOrder);
    this.input.disconnect();
    this.filterA.disconnect();
    this.filterB.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.output.disconnect();
  }

  private rewire(): void {
    this.input.disconnect();
    this.filterA.disconnect();
    this.filterB.disconnect();
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = undefined;
    if (this.firstOrder) { this.disconnectStage(this.firstOrder); this.firstOrder = null; }
    this.input.connect(this.dryGain);
    // Off passes through dry only; no filter runs.
    if (this.settings.type === 'off') return;

    if (this.isFirstOrder()) {
      this.firstOrder = this.createFirstOrder(1);
      return;
    }

    if (this.settings.order !== 4) {
      this.input.connect(this.filterA);
      this.filterA.connect(this.wetGain);
      return;
    }

    this.input.connect(this.filterA);
    this.filterA.connect(this.filterB);
    this.filterB.connect(this.wetGain);
  }

  /** Band-pass and Peak have no 1st-order form here; they fall back to the 2nd order. */
  private isFirstOrder(): boolean {
    return this.settings.order === 1 && FIRST_ORDER_TYPES.includes(this.settings.type);
  }

  private createFirstOrder(gain: number): FirstOrderStage {
    const type = this.settings.type as FirstOrderType;
    const { feedforward, feedback } = firstOrderCoefficients(type, this.settings.frequencyHz, this.context.sampleRate, this.settings.gainDb);
    const filter = this.context.createIIRFilter(feedforward, feedback);
    const fade = this.context.createGain();
    fade.gain.value = gain;
    this.input.connect(filter);
    filter.connect(fade);
    fade.connect(this.wetGain);
    return { filter, fade, frequencyHz: this.settings.frequencyHz, gainDb: this.settings.gainDb };
  }

  private scheduleFirstOrderRebuild(): void {
    if (this.rebuildTimer !== undefined) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      if (!this.firstOrder || (this.firstOrder.frequencyHz === this.settings.frequencyHz && this.firstOrder.gainDb === this.settings.gainDb)) return;
      const now = this.context.currentTime;
      const old = this.firstOrder;
      const next = this.createFirstOrder(0);
      smoothAudioParam(next.fade.gain, 1, now, PARAM_SMOOTH_SEC);
      smoothAudioParam(old.fade.gain, 0, now, PARAM_SMOOTH_SEC);
      this.firstOrder = next;
      const item = { stage: old, timer: setTimeout(() => { this.disconnectStage(old); this.retiring.delete(item); }, PARAM_SMOOTH_SEC * 1000 + 50) };
      this.retiring.add(item);
    }, FIRST_ORDER_REBUILD_MS);
  }

  private disconnectStage(stage: FirstOrderStage): void {
    try { this.input.disconnect(stage.filter); } catch { /* already disconnected by rewire */ }
    stage.filter.disconnect();
    stage.fade.disconnect();
  }

  private applyBypass(smooth: boolean): void {
    const wet = this.enabled && this.settings.type !== 'off' ? 1 : 0;
    if (smooth) {
      smoothAudioParam(this.dryGain.gain, 1 - wet, this.context.currentTime, PARAM_SMOOTH_SEC);
      smoothAudioParam(this.wetGain.gain, wet, this.context.currentTime, PARAM_SMOOTH_SEC);
    } else {
      this.dryGain.gain.cancelScheduledValues(this.context.currentTime);
      this.wetGain.gain.cancelScheduledValues(this.context.currentTime);
      this.dryGain.gain.setValueAtTime(1 - wet, this.context.currentTime);
      this.wetGain.gain.setValueAtTime(wet, this.context.currentTime);
    }
  }

  private applyParams(now: number, smooth: boolean): void {
    this.settings.frequencyHz = this.limitFrequency(this.settings.frequencyHz);
    this.settings.q = clamp(this.settings.q, LIMITS.filterQ.min, LIMITS.filterQ.max);
    this.settings.gainDb = clamp(this.settings.gainDb, LIMITS.filterGainDb.min, LIMITS.filterGainDb.max);
    this.applyFilterType();
    this.applyGain(now, smooth);

    for (const filter of [this.filterA, this.filterB]) {
      if (smooth) {
        smoothAudioParam(filter.frequency, this.settings.frequencyHz, now, PARAM_SMOOTH_SEC);
        smoothAudioParam(filter.Q, biquadQ(this.settings.type, this.settings.q), now, PARAM_SMOOTH_SEC);
      } else {
        filter.frequency.value = this.settings.frequencyHz;
        filter.Q.value = biquadQ(this.settings.type, this.settings.q);
      }
    }
  }

  private applyGain(now: number, smooth: boolean): void {
    const perBiquad = this.settings.order === 4 ? this.settings.gainDb / 2 : this.settings.gainDb;
    for (const filter of [this.filterA, this.filterB]) {
      if (smooth) smoothAudioParam(filter.gain, perBiquad, now, PARAM_SMOOTH_SEC);
      else { filter.gain.cancelScheduledValues(now); filter.gain.setValueAtTime(perBiquad, now); }
    }
  }

  /** Type changes run inside the structural fade, so the Q interpretation switches without smoothing. */
  private applyFilterType(): void {
    if (this.settings.type === 'off') return;
    this.filterA.type = this.settings.type;
    this.filterB.type = this.settings.type;
    const q = biquadQ(this.settings.type, this.settings.q);
    for (const filter of [this.filterA, this.filterB]) {
      filter.Q.cancelScheduledValues(this.context.currentTime);
      filter.Q.setValueAtTime(q, this.context.currentTime);
    }
  }

  private limitFrequency(hz: number): number {
    const nyquistSafe = this.context.sampleRate * 0.5 * 0.999;
    return clamp(hz, LIMITS.filterHz.min, Math.min(LIMITS.filterHz.max, nyquistSafe));
  }
}
