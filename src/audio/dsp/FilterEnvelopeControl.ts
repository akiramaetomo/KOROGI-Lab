import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import type { FilterEnvelopeSettings } from '../types';
import { EnvelopeTimeline, ENVELOPE_FLOOR_GAIN as FLOOR } from './EnvelopeTimeline';
import { clamp, holdAudioParam, smoothAudioParam } from './params';

/** Positive internal envelope -> exact zero-based shape -> signed cents. */
export class FilterEnvelopeControl extends EnvelopeTimeline<FilterEnvelopeSettings> {
  readonly output: GainNode;
  private readonly shape: ConstantSourceNode;
  private readonly bias: ConstantSourceNode;
  private readonly normalize: GainNode;
  private readonly amount: GainNode;

  constructor(context: AudioContext, initial: FilterEnvelopeSettings) {
    super(context, initial);
    this.shape = context.createConstantSource();
    this.shape.offset.value = FLOOR;
    this.normalize = context.createGain();
    this.normalize.gain.value = 1 / (1 - FLOOR);
    this.bias = context.createConstantSource();
    this.bias.offset.value = -FLOOR / (1 - FLOOR);
    this.amount = context.createGain();
    this.amount.gain.value = this.settings.amountCent;
    this.output = context.createGain();
    this.shape.connect(this.normalize).connect(this.amount);
    this.bias.connect(this.amount);
    this.amount.connect(this.output);
    this.shape.start(); this.bias.start();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.compact();
    this.enabled = enabled;
    this.scheduleFrom(this.context.currentTime);
    smoothAudioParam(this.output.gain, enabled ? 1 : 0, this.context.currentTime, PARAM_SMOOTH_SEC);
  }

  normalizedValueAt(time: number): number { return (this.valueAt(time) - FLOOR) / (1 - FLOOR); }
  centValueAt(time: number): number {
    const value = this.enabled ? this.normalizedValueAt(time) * this.settingsAt(time).amountCent : 0;
    return value === 0 ? 0 : value;
  }

  protected sustainLevel(settings: FilterEnvelopeSettings): number { return FLOOR + (1 - FLOOR) * settings.sustain; }
  protected silenceLevel(): number { return FLOOR; }

  protected sanitize(value: FilterEnvelopeSettings): FilterEnvelopeSettings {
    return { ...super.sanitize(value),
      attackSec: clamp(value.attackSec, LIMITS.filterEnvelopeAttack.min, LIMITS.filterEnvelopeAttack.max),
      decaySec: clamp(value.decaySec, LIMITS.filterEnvelopeDecay.min, LIMITS.filterEnvelopeDecay.max),
      releaseSec: clamp(value.releaseSec, LIMITS.filterEnvelopeRelease.min, LIMITS.filterEnvelopeRelease.max),
      sustain: clamp(value.sustain, LIMITS.filterEnvelopeSustain.min, LIMITS.filterEnvelopeSustain.max),
      amountCent: clamp(value.amountCent, LIMITS.filterEnvelopeAmount.min, LIMITS.filterEnvelopeAmount.max) };
  }

  protected scheduleFrom(time: number): void {
    this.scheduleParam(this.shape.offset, time);
    holdAudioParam(this.amount.gain, time);
    this.amount.gain.setValueAtTime(this.settingsAt(time).amountCent, time);
    for (const event of this.events) if (event.kind === 'on' && event.time > time)
      this.amount.gain.setValueAtTime(event.settings.amountCent, event.time);
  }

  dispose(): void {
    this.shape.stop(); this.bias.stop();
    this.shape.disconnect(); this.bias.disconnect(); this.normalize.disconnect();
    this.amount.disconnect(); this.output.disconnect();
  }
}
