import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import { clamp, smoothAudioParam } from './params';

/**
 * Shared normalized PEnv shape: 0 -> 1 -> 0.
 * Each periodic oscillator scales this signal by the PEnv peak in cents and
 * adds it to Oscillator.detune. A linear ramp in cents is exponential in Hz,
 * i.e. interpolation in logarithmic frequency space.
 */
export class PitchEnvelopeControl {
  readonly output: GainNode;
  private readonly shape: ConstantSourceNode;

  private amount = 0;
  private transitionTimeSec = 0.05;

  constructor(private readonly context: AudioContext) {
    this.output = context.createGain();
    this.shape = context.createConstantSource();
    this.shape.offset.value = 0;
    this.shape.connect(this.output);
    this.shape.start();
  }

  setSettings(amount: number, transitionTimeSec: number): void {
    // Time-structure parameters are stored now and applied at the next Gate ON.
    this.amount = clamp(amount, LIMITS.pitchAmount.min, LIMITS.pitchAmount.max);
    this.transitionTimeSec = clamp(
      transitionTimeSec,
      LIMITS.pitchTransitionSec.min,
      LIMITS.pitchTransitionSec.max
    );
  }

  getAmount(): number {
    return this.amount;
  }

  gateOn(time: number, snapshot = { amount: this.amount, transitionTimeSec: this.transitionTimeSec }): { amount: number; transitionTimeSec: number } {
    const tp = clamp(snapshot.transitionTimeSec, LIMITS.pitchTransitionSec.min, LIMITS.pitchTransitionSec.max);
    const offset = this.shape.offset;

    // Spec 6.5: reset existing PEnv deviation to zero at retrigger time.
    offset.cancelScheduledValues(time);
    offset.setValueAtTime(0, time);
    offset.linearRampToValueAtTime(1, time + tp);
    offset.linearRampToValueAtTime(0, time + 2 * tp);

    return { amount: clamp(snapshot.amount, LIMITS.pitchAmount.min, LIMITS.pitchAmount.max), transitionTimeSec: tp };
  }

  reset(now = this.context.currentTime): void {
    smoothAudioParam(this.shape.offset, 0, now, 0.001);
  }

  setEnabled(enabled: boolean): void {
    smoothAudioParam(this.output.gain, enabled ? 1 : 0, this.context.currentTime, PARAM_SMOOTH_SEC);
  }

  dispose(): void {
    this.shape.stop();
    this.shape.disconnect();
    this.output.disconnect();
  }
}
