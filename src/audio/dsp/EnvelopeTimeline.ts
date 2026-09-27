import { LIMITS } from '../constants';
import type { ADSREnvelopeSettings, EnvelopeCurve } from '../types';
import { clamp, holdAudioParam } from './params';

export const ENVELOPE_FLOOR_GAIN = 1e-4;
interface Segment { kind: 'idle' | 'attack' | 'decay' | 'release'; start: number; end: number; from: number; to: number; curve?: EnvelopeCurve; }
type EnvelopeEvent<T> = { kind: 'on'; time: number; settings: T; ownedOffTime?: number }
  | { kind: 'off' | 'silence' | 'floor'; time: number };
type GateOn<T> = Extract<EnvelopeEvent<T>, { kind: 'on' }>;

/** Logical envelope timing is independent of AudioParam.value and bypass. */
export abstract class EnvelopeTimeline<T extends ADSREnvelopeSettings = ADSREnvelopeSettings> {
  protected settings: T;
  protected events: EnvelopeEvent<T>[] = [];
  protected segments: Segment[] = [{ kind: 'idle', start: 0, end: 0, from: ENVELOPE_FLOOR_GAIN, to: ENVELOPE_FLOOR_GAIN }];
  // This tail excludes unstarted events: a cancelled future ON must not have
  // permanently truncated the current note's Attack/Decay/One-shot Release.
  protected checkpoint: { time: number; segments: Segment[]; active?: GateOn<T>; lastOn?: GateOn<T> } = {
    time: 0, segments: this.segments.map(segment => ({ ...segment }))
  };
  protected enabled = true;

  constructor(protected readonly context: AudioContext, initial: T) {
    this.settings = this.sanitize(initial);
  }

  setSettings(next: T): void { this.settings = this.sanitize(next); }

  /** Phase restart is safe only after an enabled envelope has reached its floor. */
  isSilentAt(time: number): boolean {
    time = Math.max(time, this.context.currentTime);
    const segment = this.segmentAt(time);
    const logicallyFinished = segment.kind === 'idle' || (segment.kind === 'release' && time >= segment.end);
    return this.enabled && logicallyFinished && this.valueAt(time) <= ENVELOPE_FLOOR_GAIN;
  }

  gateOn(time: number, snapshot: T = this.settings, ownedOffTime?: number): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    const settings = this.sanitize(snapshot);
    this.events = this.events.filter(event => event.time < time);
    this.events.push({ kind: 'on', time, settings,
      ownedOffTime: settings.mode === 'gate' && ownedOffTime !== undefined ? Math.max(time, ownedOffTime) : undefined });
    this.rebuild();
    if (this.enabled) this.scheduleFrom(time);
  }

  gateOff(time: number): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    const gate = this.activeGateAt(time);
    if (!gate || gate.settings.mode === 'one-shot') return;
    this.events = this.events.filter(event => event.time < time || (event.time === time && event.kind === 'on'));
    this.events.push({ kind: 'off', time });
    this.rebuild();
    if (this.enabled) this.scheduleFrom(time);
  }

  /** Drop future Gate automation while preserving the envelope phase at now. */
  preserveCurrent(time = this.context.currentTime): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    this.events = this.events.filter(event => event.time < time || event.time <= this.context.currentTime);
    this.rebuild();
    if (this.enabled) this.scheduleFrom(time);
  }

  silence(time = this.context.currentTime): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    this.events = [{ kind: 'silence', time }];
    this.rebuild();
    this.scheduleFrom(time);
  }

  protected segmentAt(time: number): Segment {
    let segment = this.segments[0]!;
    for (const item of this.segments) {
      if (item.start > time) break;
      segment = item;
    }
    return segment;
  }

  protected settingsAt(time: number): T {
    let settings = this.checkpoint.lastOn?.settings ?? this.settings;
    for (const event of this.events) {
      if (event.time > time) break;
      if (event.kind === 'on') settings = event.settings;
    }
    return settings;
  }

  private activeGateAt(time: number): GateOn<T> | undefined {
    let active = this.checkpoint.active;
    for (const event of this.events) {
      if (event.time > time) break;
      if (event.kind === 'on') active = event;
      else active = undefined;
    }
    return active?.ownedOffTime !== undefined && active.ownedOffTime <= time ? undefined : active;
  }

  protected valueAt(time: number): number {
    if (time < this.checkpoint.time) throw new RangeError('Envelope history before the checkpoint is not retained');
    const segment = this.segmentAt(time);
    if (time >= segment.end) return segment.to;
    const progress = (time - segment.start) / (segment.end - segment.start);
    return segment.curve === 'linear' ? segment.from + (segment.to - segment.from) * progress
      : segment.from * (segment.to / segment.from) ** progress;
  }

  protected muteReleasedGate(time: number): void {
    // Re-enabling with Gate OFF must return to silence, while retaining notes
    // already submitted inside the Auto scheduler's lookahead window.
    this.events = [...this.events.filter(event => event.time < time), { kind: 'floor', time },
      ...this.events.filter(event => event.time > time)];
    this.rebuild();
  }

  private trimSegments(time: number): void {
    const value = this.valueAt(time);
    this.segments = this.segments.filter((item, index) => index === 0 || item.start < time);
    const last = this.segments.at(-1);
    if (last && last.end > time) { last.end = time; last.to = value; }
  }

  protected compact(): void {
    const now = this.context.currentTime;
    if (now <= this.checkpoint.time) return;
    // Strictly before now: events at now retain their existing replacement order.
    const split = this.events.findIndex(event => event.time >= now);
    const count = split < 0 ? this.events.length : split;
    const past = this.events.slice(0, count);
    this.segments = this.checkpoint.segments.map(segment => ({ ...segment }));
    let active = this.replay(past, this.checkpoint.active);
    if (active?.ownedOffTime !== undefined && active.ownedOffTime <= now) active = undefined;
    let lastOn = this.checkpoint.lastOn;
    for (const event of past) if (event.kind === 'on') lastOn = event;
    const current = this.segmentAt(now);
    this.checkpoint = { time: now, active, lastOn,
      segments: this.segments.slice(this.segments.indexOf(current)).map(segment => ({ ...segment })) };
    this.events = this.events.slice(count);
    this.rebuild();
  }

  protected rebuild(): void {
    this.segments = this.checkpoint.segments.map(segment => ({ ...segment }));
    this.replay(this.events, this.checkpoint.active);
  }

  private replay(events: EnvelopeEvent<T>[], active?: GateOn<T>): GateOn<T> | undefined {
    for (const event of events) {
      if (event.kind === 'on') {
        const start = Math.max(this.valueAt(event.time), ENVELOPE_FLOOR_GAIN);
        this.trimSegments(event.time);
        const settings = event.settings;
        const decayEnd = event.time + settings.attackSec + settings.decaySec;
        const sustain = this.sustainLevel(settings);
        this.segments.push(
          { kind: 'attack', start: event.time, end: event.time + settings.attackSec, from: start, to: 1, curve: settings.attackCurve },
          { kind: 'decay', start: event.time + settings.attackSec, end: decayEnd, from: 1, to: sustain, curve: settings.decayCurve }
        );
        if (settings.mode === 'one-shot') this.segments.push({ kind: 'release', start: decayEnd,
          end: decayEnd + this.releaseDuration(sustain, settings), from: sustain, to: ENVELOPE_FLOOR_GAIN, curve: settings.releaseCurve });
        else if (event.ownedOffTime !== undefined) {
          const start = Math.max(this.valueAt(event.ownedOffTime), ENVELOPE_FLOOR_GAIN);
          this.trimSegments(event.ownedOffTime);
          this.segments.push({ kind: 'release', start: event.ownedOffTime,
            end: event.ownedOffTime + this.releaseDuration(start, settings), from: start,
            to: ENVELOPE_FLOOR_GAIN, curve: settings.releaseCurve });
        }
        active = settings.mode === 'gate' ? event : undefined;
      } else if (event.kind === 'off' && active && (active.ownedOffTime === undefined || event.time < active.ownedOffTime)) {
        const start = Math.max(this.valueAt(event.time), ENVELOPE_FLOOR_GAIN);
        this.trimSegments(event.time);
        this.segments.push(start <= ENVELOPE_FLOOR_GAIN
          ? { kind: 'idle', start: event.time, end: event.time, from: ENVELOPE_FLOOR_GAIN, to: ENVELOPE_FLOOR_GAIN }
          : { kind: 'release', start: event.time, end: event.time + this.releaseDuration(start, active.settings),
            from: start, to: ENVELOPE_FLOOR_GAIN, curve: active.settings.releaseCurve });
        active = undefined;
      } else if (event.kind === 'silence' || event.kind === 'floor') {
        this.trimSegments(event.time);
        const value = event.kind === 'floor' ? ENVELOPE_FLOOR_GAIN : this.silenceLevel();
        this.segments.push({ kind: 'idle', start: event.time, end: event.time, from: value, to: value });
        active = undefined;
      }
    }
    return active;
  }

  /** BURST's owned pitch OFF uses exactly the same sanitized timing as the AEnv. */
  oneShotEndTime(time: number, snapshot: T = this.settings): number {
    const settings = this.sanitize(snapshot);
    return Math.max(time, this.context.currentTime) + settings.attackSec + settings.decaySec
      + this.releaseDuration(this.sustainLevel(settings), settings);
  }

  protected sustainLevel(settings: T): number { return Math.max(settings.sustain, ENVELOPE_FLOOR_GAIN); }
  protected silenceLevel(): number { return 0; }

  protected abstract scheduleFrom(time: number): void;

  protected scheduleParam(param: AudioParam, time: number): void {
    holdAudioParam(param, time);
    param.setValueAtTime(this.valueAt(time), time);
    for (const segment of this.segments) {
      if (segment.start === segment.end && segment.end >= time) param.setValueAtTime(segment.to, segment.end);
      else if (segment.end > time) {
        if (segment.start > time) param.setValueAtTime(segment.from, segment.start);
        if (segment.curve === 'linear') param.linearRampToValueAtTime(segment.to, segment.end);
        else param.exponentialRampToValueAtTime(segment.to, segment.end);
      }
    }
  }

  protected sanitize(value: T): T {
    return {
      attackSec: clamp(value.attackSec, LIMITS.envelopeSec.min, LIMITS.envelopeSec.max),
      decaySec: clamp(value.decaySec, LIMITS.envelopeSec.min, LIMITS.envelopeSec.max),
      sustain: clamp(value.sustain, LIMITS.sustain.min, LIMITS.sustain.max),
      releaseSec: clamp(value.releaseSec, LIMITS.envelopeSec.min, LIMITS.envelopeSec.max),
      mode: value.mode === 'one-shot' ? 'one-shot' : 'gate',
      attackCurve: value.attackCurve === 'linear' ? 'linear' : 'exponential',
      decayCurve: value.decayCurve === 'linear' ? 'linear' : 'exponential',
      releaseCurve: value.releaseCurve === 'linear' ? 'linear' : 'exponential',
      releaseTiming: value.releaseCurve === 'linear' && value.releaseTiming === 'rate' ? 'rate' : 'time'
    } as T;
  }

  protected releaseDuration(from: number, settings: T): number {
    if (settings.releaseTiming !== 'rate' || settings.releaseCurve !== 'linear') return settings.releaseSec;
    return settings.releaseSec * Math.max(0, from - ENVELOPE_FLOOR_GAIN) / (1 - ENVELOPE_FLOOR_GAIN);
  }
}
