import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import type { AmplitudeEnvelopeSettings, EnvelopeCurve } from '../types';
import { clamp, holdAudioParam } from './params';

export const ENVELOPE_FLOOR_GAIN = 1e-4;
interface Segment { kind: 'idle' | 'attack' | 'decay' | 'release'; start: number; end: number; from: number; to: number; curve?: EnvelopeCurve; }

/** Logical envelope timing is independent of AudioParam.value and bypass. */
export class AmplitudeEnvelope {
  readonly node: GainNode;
  private settings: AmplitudeEnvelopeSettings;
  private gates: { time: number; settings: AmplitudeEnvelopeSettings }[] = [];
  private segments: Segment[] = [{ kind: 'idle', start: 0, end: 0, from: ENVELOPE_FLOOR_GAIN, to: ENVELOPE_FLOOR_GAIN }];
  private enabled = true;

  constructor(private readonly context: AudioContext, initial: AmplitudeEnvelopeSettings) {
    this.node = context.createGain();
    this.node.gain.value = ENVELOPE_FLOOR_GAIN;
    this.settings = this.sanitize(initial);
  }

  setSettings(next: AmplitudeEnvelopeSettings): void { this.settings = this.sanitize(next); }

  /** Phase restart is safe only after an enabled envelope has reached its floor. */
  isSilentAt(time: number): boolean {
    time = Math.max(time, this.context.currentTime);
    const segment = this.segmentAt(time);
    const logicallyFinished = segment.kind === 'idle' || (segment.kind === 'release' && time >= segment.end);
    return this.enabled && logicallyFinished && this.valueAt(time) <= ENVELOPE_FLOOR_GAIN;
  }

  gateOn(time: number, snapshot: AmplitudeEnvelopeSettings = this.settings): void {
    time = Math.max(time, this.context.currentTime);
    const settings = this.sanitize(snapshot);
    const start = Math.max(this.valueAt(time), ENVELOPE_FLOOR_GAIN);
    this.truncate(time);
    this.segments.push(
      { kind: 'attack', start: time, end: time + settings.attackSec, from: start, to: 1, curve: settings.attackCurve },
      { kind: 'decay', start: time + settings.attackSec, end: time + settings.attackSec + settings.decaySec, from: 1, to: Math.max(settings.sustain, ENVELOPE_FLOOR_GAIN), curve: settings.decayCurve }
    );
    if (settings.mode === 'one-shot') this.segments.push({ kind: 'release',
      start: time + settings.attackSec + settings.decaySec,
      end: time + settings.attackSec + settings.decaySec + settings.releaseSec,
      from: Math.max(settings.sustain, ENVELOPE_FLOOR_GAIN), to: ENVELOPE_FLOOR_GAIN, curve: settings.releaseCurve });
    this.gates = this.gates.filter((gate) => gate.time < time);
    this.gates.push({ time, settings });
    if (this.enabled) this.scheduleFrom(time);
  }

  gateOff(time: number): void {
    time = Math.max(time, this.context.currentTime);
    const settings = this.settingsAt(time);
    if (settings.mode === 'one-shot') return;
    const start = Math.max(this.valueAt(time), ENVELOPE_FLOOR_GAIN);
    this.truncate(time);
    if (start <= ENVELOPE_FLOOR_GAIN) {
      this.segments.push({ kind: 'idle', start: time, end: time, from: ENVELOPE_FLOOR_GAIN, to: ENVELOPE_FLOOR_GAIN });
      if (this.enabled) this.scheduleFrom(time);
      return;
    }
    this.segments.push({ kind: 'release', start: time, end: time + settings.releaseSec, from: start, to: ENVELOPE_FLOOR_GAIN, curve: settings.releaseCurve });
    if (this.enabled) this.scheduleFrom(time);
  }

  /** Drop future Gate automation while preserving the envelope phase at now. */
  preserveCurrent(time = this.context.currentTime): void {
    time = Math.max(time, this.context.currentTime);
    const current = { ...this.segmentAt(time) };
    const value = Math.max(this.valueAt(time), ENVELOPE_FLOOR_GAIN);
    const nextAttack = this.segments.find(segment => segment.start > time && segment.kind === 'attack')?.start ?? Infinity;
    const future = this.settingsAt(time).mode === 'one-shot'
      ? this.segments.filter(segment => segment.start > time && segment.start < nextAttack) : [];
    this.truncate(time);
    if (current.end > time) this.segments.push({ ...current, start: time, from: value });
    this.segments.push(...future);
    if (this.enabled) this.scheduleFrom(time);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    const now = this.context.currentTime;
    const current = this.segmentAt(now);
    if (enabled && (current.kind === 'idle' || (current.kind === 'release' &&
      !(this.settingsAt(now).mode === 'one-shot' && current.end > now)))) this.muteReleasedGate(now);
    const resume = now + PARAM_SMOOTH_SEC;
    holdAudioParam(this.node.gain, now);
    this.node.gain.setValueAtTime(this.node.gain.value, now);
    this.node.gain.linearRampToValueAtTime(enabled ? this.valueAt(resume) : 1, resume);
    if (enabled) this.scheduleFrom(resume);
  }

  silence(time = this.context.currentTime): void {
    time = Math.max(time, this.context.currentTime);
    this.truncate(time);
    this.segments.push({ kind: 'idle', start: time, end: time, from: 0, to: 0 });
    holdAudioParam(this.node.gain, time);
    this.node.gain.setValueAtTime(0, time);
    this.gates = [];
  }

  private segmentAt(time: number): Segment {
    let segment = this.segments[0]!;
    for (const item of this.segments) {
      if (item.start > time) break;
      segment = item;
    }
    return segment;
  }

  private settingsAt(time: number): AmplitudeEnvelopeSettings {
    let settings = this.settings;
    for (const gate of this.gates) {
      if (gate.time > time) break;
      settings = gate.settings;
    }
    return settings;
  }

  private valueAt(time: number): number {
    const segment = this.segmentAt(time);
    if (time >= segment.end) return segment.to;
    const progress = (time - segment.start) / (segment.end - segment.start);
    return segment.curve === 'linear' ? segment.from + (segment.to - segment.from) * progress
      : segment.from * (segment.to / segment.from) ** progress;
  }

  private muteReleasedGate(time: number): void {
    // Re-enabling with Gate OFF must return to silence, while retaining notes
    // already submitted inside the Auto scheduler's lookahead window.
    const future = this.segments.filter((segment) => segment.start > time);
    const gates = this.gates;
    this.truncate(time);
    this.gates = gates;
    this.segments.push({ kind: 'idle', start: time, end: time, from: ENVELOPE_FLOOR_GAIN, to: ENVELOPE_FLOOR_GAIN });
    for (const segment of future) {
      const from = Math.max(this.valueAt(segment.start), ENVELOPE_FLOOR_GAIN);
      this.segments.push({ ...segment, from });
    }
  }

  private truncate(time: number): void {
    const value = this.valueAt(time);
    this.segments = this.segments.filter((item, index) => index === 0 || item.start < time);
    this.gates = this.gates.filter((gate) => gate.time <= time);
    const last = this.segments.at(-1);
    if (last && last.end > time) { last.end = time; last.to = value; }
    while (this.segments.length > 1 && this.segments[1]!.start < this.context.currentTime) this.segments.shift();
    while (this.gates.length > 1 && this.gates[1]!.time < this.context.currentTime) this.gates.shift();
  }

  private scheduleFrom(time: number): void {
    const gain = this.node.gain;
    holdAudioParam(gain, time);
    // Holding constant Sustain does not establish a new ramp origin.
    // Anchor OFF explicitly so Release cannot rewrite the interval since Decay.
    gain.setValueAtTime(this.valueAt(time), time);
    for (const segment of this.segments) {
      if (segment.end > time) {
        if (segment.start > time) gain.setValueAtTime(segment.from, segment.start);
        if (segment.curve === 'linear') gain.linearRampToValueAtTime(segment.to, segment.end);
        else gain.exponentialRampToValueAtTime(segment.to, segment.end);
      }
    }
  }

  private sanitize(value: AmplitudeEnvelopeSettings): AmplitudeEnvelopeSettings {
    return {
      attackSec: clamp(value.attackSec, LIMITS.envelopeSec.min, LIMITS.envelopeSec.max),
      decaySec: clamp(value.decaySec, LIMITS.envelopeSec.min, LIMITS.envelopeSec.max),
      sustain: clamp(value.sustain, LIMITS.sustain.min, LIMITS.sustain.max),
      releaseSec: clamp(value.releaseSec, LIMITS.envelopeSec.min, LIMITS.envelopeSec.max),
      mode: value.mode === 'one-shot' ? 'one-shot' : 'gate',
      attackCurve: value.attackCurve === 'linear' ? 'linear' : 'exponential',
      decayCurve: value.decayCurve === 'linear' ? 'linear' : 'exponential',
      releaseCurve: value.releaseCurve === 'linear' ? 'linear' : 'exponential'
    };
  }
}
