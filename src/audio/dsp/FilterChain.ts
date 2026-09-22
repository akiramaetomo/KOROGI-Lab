import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import type { FilterOrder, FilterSettings, FilterType } from '../types';
import { clamp, smoothAudioParam } from './params';

export class FilterChain {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly filterA: BiquadFilterNode;
  private readonly filterB: BiquadFilterNode;
  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
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
    this.settings = { ...initial };

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
    this.rewire();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.applyBypass(true);
  }

  setFrequency(hz: number, now = this.context.currentTime): void {
    this.settings.frequencyHz = this.limitFrequency(hz);
    smoothAudioParam(this.filterA.frequency, this.settings.frequencyHz, now, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.filterB.frequency, this.settings.frequencyHz, now, PARAM_SMOOTH_SEC);
  }

  setQ(q: number, now = this.context.currentTime): void {
    this.settings.q = clamp(q, LIMITS.filterQ.min, LIMITS.filterQ.max);
    smoothAudioParam(this.filterA.Q, this.settings.q, now, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.filterB.Q, this.settings.q, now, PARAM_SMOOTH_SEC);
  }

  connectDetune(signal: AudioNode): void {
    signal.connect(this.filterA.detune);
    signal.connect(this.filterB.detune);
  }

  dispose(): void {
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
    this.input.connect(this.dryGain);

    if (this.settings.order === 2) {
      this.input.connect(this.filterA);
      this.filterA.connect(this.wetGain);
      return;
    }

    this.input.connect(this.filterA);
    this.filterA.connect(this.filterB);
    this.filterB.connect(this.wetGain);
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
    this.applyFilterType();

    for (const filter of [this.filterA, this.filterB]) {
      if (smooth) {
        smoothAudioParam(filter.frequency, this.settings.frequencyHz, now, PARAM_SMOOTH_SEC);
        smoothAudioParam(filter.Q, this.settings.q, now, PARAM_SMOOTH_SEC);
      } else {
        filter.frequency.value = this.settings.frequencyHz;
        filter.Q.value = this.settings.q;
      }
    }
  }

  private applyFilterType(): void {
    if (this.settings.type === 'off') return;
    this.filterA.type = this.settings.type;
    this.filterB.type = this.settings.type;
  }

  private limitFrequency(hz: number): number {
    const nyquistSafe = this.context.sampleRate * 0.5 * 0.999;
    return clamp(hz, LIMITS.filterHz.min, Math.min(LIMITS.filterHz.max, nyquistSafe));
  }
}
