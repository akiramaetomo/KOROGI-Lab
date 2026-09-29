import { PARAMETER_RANGES as P } from '../../config/parameterRanges';
import { clamp } from './params';

interface PitchSegment {
  startTime: number;
  startValue: number;
  endTime: number;
  endValue: number;
}

/** Independent cent-domain automation for oscillator or filter detune. */
export class SequencePitchControl {
  readonly output: ConstantSourceNode;
  private readonly segments: PitchSegment[] = [];
  private disposed = false;

  constructor(private readonly context: AudioContext, private readonly maxCent: number = P['sequence-pitch-scale'].max) {
    this.output = context.createConstantSource();
    this.output.offset.value = 0;
    this.output.start();
  }

  setTarget(cents: number, time = this.context.currentTime, transitionSec = 0): void {
    this.assertUsable();
    if (!Number.isFinite(cents) || !Number.isFinite(time) || !Number.isFinite(transitionSec)) {
      throw new Error('Invalid sequence pitch automation.');
    }
    const startTime = Math.max(time, this.context.currentTime);
    this.pruneBefore(this.context.currentTime);
    const startValue = this.valueAt(startTime);
    const target = clamp(cents, -this.maxCent, this.maxCent);
    const duration = clamp(transitionSec, 0, 5); // Preserve imported legacy glides above the new 1000 ms UI limit.
    this.truncateAt(startTime, startValue);
    this.output.offset.cancelScheduledValues(startTime);
    this.output.offset.setValueAtTime(startValue, startTime);
    if (duration > 0) this.output.offset.linearRampToValueAtTime(target, startTime + duration);
    else this.output.offset.setValueAtTime(target, startTime);
    this.segments.push({ startTime, startValue, endTime: startTime + duration, endValue: target });
  }

  holdAt(time = this.context.currentTime): number {
    this.assertUsable();
    const boundary = Math.max(time, this.context.currentTime);
    this.pruneBefore(this.context.currentTime);
    const value = this.valueAt(boundary);
    this.truncateAt(boundary, value);
    this.output.offset.cancelScheduledValues(boundary);
    this.output.offset.setValueAtTime(value, boundary);
    return value;
  }

  reset(time = this.context.currentTime, transitionSec = 0): void {
    this.setTarget(0, time, transitionSec);
  }

  valueAt(time: number): number {
    let value = 0;
    for (const segment of this.segments) {
      if (time < segment.startTime) break;
      if (segment.endTime > segment.startTime && time < segment.endTime) {
        const ratio = (time - segment.startTime) / (segment.endTime - segment.startTime);
        return segment.startValue + (segment.endValue - segment.startValue) * ratio;
      }
      value = segment.endValue;
    }
    return value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.output.disconnect();
    try { this.output.stop(); } catch { /* already stopped */ }
    this.segments.length = 0;
    this.disposed = true;
  }

  private truncateAt(time: number, value: number): void {
    while (this.segments.length && this.segments.at(-1)!.startTime >= time) this.segments.pop();
    const last = this.segments.at(-1);
    if (last && last.endTime > time) {
      last.endTime = time;
      last.endValue = value;
    }
  }

  /** Retain the active/latest segment plus future automation, not every completed loop. */
  private pruneBefore(time: number): void {
    let latestStarted = 0;
    while (latestStarted + 1 < this.segments.length && this.segments[latestStarted + 1]!.startTime <= time) latestStarted += 1;
    if (latestStarted > 0) this.segments.splice(0, latestStarted);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('SequencePitchControl has been disposed.');
  }
}
