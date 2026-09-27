import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import type { PitchEnvelopeSettings } from '../types';
import { clamp, holdAudioParam, smoothAudioParam } from './params';

type SegmentKind = 'idle' | 'attack' | 'decay' | 'sustain' | 'release';
interface Segment { kind: SegmentKind; start: number; end: number; from: number; to: number; }
type Event = { kind: 'on'; time: number; settings: PitchEnvelopeSettings; ownedOffTime?: number } | { kind: 'off'; time: number };
type GateOn = Extract<Event, { kind: 'on' }>;

/** Pitch deviations are linear in frequency ratio, not cents. */
export class PitchEnvelopeControl {
  readonly output: GainNode;
  private readonly shape: ConstantSourceNode;
  private readonly scaleNode: GainNode;
  private settings: PitchEnvelopeSettings;
  private events: Event[] = [];
  private segments: Segment[] = [{ kind: 'idle', start: 0, end: 0, from: 0, to: 0 }];
  private checkpoint: { time: number; segments: Segment[]; active?: GateOn; lastOn?: GateOn } = {
    time: 0, segments: this.segments.map(segment => ({ ...segment }))
  };
  private enabled = true;

  constructor(private readonly context: AudioContext, initial: PitchEnvelopeSettings) {
    this.output = context.createGain();
    this.scaleNode = context.createGain();
    this.shape = context.createConstantSource();
    this.shape.offset.value = 0;
    this.scaleNode.gain.value = 1;
    this.shape.connect(this.scaleNode).connect(this.output);
    this.shape.start();
    this.settings = this.sanitize(initial);
  }

  setSettings(next: PitchEnvelopeSettings): void { this.settings = this.sanitize(next); }

  /** ownedOffTime belongs to this ON only (BURST); it is not a global Gate edge. */
  gateOn(time: number, snapshot: PitchEnvelopeSettings = this.settings, ownedOffTime?: number): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    const settings = this.sanitize(snapshot);
    this.events = this.events.filter(event => event.time < time);
    this.events.push({ kind: 'on', time, settings,
      ownedOffTime: settings.mode === 'gate' && ownedOffTime !== undefined ? Math.max(time, ownedOffTime) : undefined });
    this.rebuild();
    this.scheduleFrom(time);
  }

  gateOff(time: number): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    const gate = this.activeGateAt(time);
    if (!gate || gate.settings.mode === 'one-shot') return;
    this.events = this.events.filter(event => event.time < time || (event.time === time && event.kind === 'on'));
    this.events.push({ kind: 'off', time });
    this.rebuild();
    this.scheduleFrom(time);
  }

  /** Cancel unstarted Gates while retaining the current note and its One-shot tail. */
  preserveCurrent(time = this.context.currentTime): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    this.events = this.events.filter(event => event.time < time || event.time <= this.context.currentTime);
    this.rebuild();
    this.scheduleFrom(time);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.compact();
    this.enabled = enabled;
    smoothAudioParam(this.output.gain, enabled ? 1 : 0, this.context.currentTime, PARAM_SMOOTH_SEC);
  }

  dispose(): void {
    this.shape.stop();
    this.shape.disconnect();
    this.scaleNode.disconnect();
    this.output.disconnect();
  }

  /** Unscaled deviation at/after the retained checkpoint; capture past observations when they occur. */
  valueAt(time: number): number {
    if (time < this.checkpoint.time) throw new RangeError('Envelope history before the checkpoint is not retained');
    const segment = this.segmentAt(time);
    if (time >= segment.end) return segment.to;
    const progress = (time - segment.start) / (segment.end - segment.start);
    return segment.from + (segment.to - segment.from) * progress;
  }

  scaledValueAt(time: number): number {
    if (!this.enabled) return 0;
    return this.valueAt(time) * (this.gateAt(time)?.settings.scale ?? 1);
  }

  private addRelease(time: number, from: number, settings: PitchEnvelopeSettings): void {
    const difference = Math.abs(settings.release - from);
    const baseline = Math.abs(settings.release - settings.sustain);
    const duration = settings.releaseSec === 0 || difference === 0 ? 0
      : settings.releaseTiming === 'rate' && baseline + 16 * Number.EPSILON >= .001
        ? settings.releaseSec * difference / baseline : settings.releaseSec;
    const end = time + duration;
    this.segments.push({ kind: 'release', start: time, end, from, to: settings.release });
    this.segments.push({ kind: 'idle', start: end, end, from: settings.release, to: settings.release });
  }

  private segmentAt(time: number): Segment {
    let segment = this.segments[0]!;
    for (const item of this.segments) {
      if (item.start > time) break;
      segment = item;
    }
    return segment;
  }

  private gateAt(time: number): GateOn | undefined {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]!;
      if (event.kind === 'on' && event.time <= time) return event;
    }
    return this.checkpoint.lastOn;
  }

  private activeGateAt(time: number): GateOn | undefined {
    let active = this.checkpoint.active;
    for (const event of this.events) {
      if (event.time > time) break;
      if (event.kind === 'on') active = event;
      else active = undefined;
    }
    return active?.ownedOffTime !== undefined && active.ownedOffTime <= time ? undefined : active;
  }

  private trimSegments(time: number): void {
    const value = this.valueAt(time);
    this.segments = this.segments.filter((item, index) => index === 0 || item.start < time);
    const last = this.segments.at(-1);
    if (last && last.end > time) { last.end = time; last.to = value; }
  }

  private compact(): void {
    const now = this.context.currentTime;
    if (now <= this.checkpoint.time) return;
    const split = this.events.findIndex(event => event.time >= now);
    const count = split < 0 ? this.events.length : split;
    const past = this.events.slice(0, count);
    // Replay only started events, never the future-truncated rendered segments.
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

  private rebuild(): void {
    this.segments = this.checkpoint.segments.map(segment => ({ ...segment }));
    this.replay(this.events, this.checkpoint.active);
  }

  private replay(events: Event[], active?: GateOn): GateOn | undefined {
    for (const event of events) {
      if (event.kind === 'on') {
        this.trimSegments(event.time);
        const settings = event.settings;
        const attackEnd = event.time + settings.attackSec;
        const decayEnd = attackEnd + settings.decaySec;
        this.segments.push(
          { kind: 'attack', start: event.time, end: attackEnd, from: settings.start, to: settings.attack },
          { kind: 'decay', start: attackEnd, end: decayEnd, from: settings.attack, to: settings.sustain },
          { kind: 'sustain', start: decayEnd, end: decayEnd, from: settings.sustain, to: settings.sustain }
        );
        if (settings.mode === 'one-shot') this.addRelease(decayEnd, settings.sustain, settings);
        else if (event.ownedOffTime !== undefined) {
          const from = this.valueAt(event.ownedOffTime);
          this.trimSegments(event.ownedOffTime);
          this.addRelease(event.ownedOffTime, from, settings);
        }
        active = settings.mode === 'gate' ? event : undefined;
      } else if (active && (active.ownedOffTime === undefined || event.time < active.ownedOffTime)) {
        const from = this.valueAt(event.time);
        this.trimSegments(event.time);
        this.addRelease(event.time, from, active.settings);
        active = undefined;
      }
    }
    return active;
  }

  private scheduleFrom(time: number): void {
    const offset = this.shape.offset;
    holdAudioParam(offset, time);
    offset.setValueAtTime(this.valueAt(time), time);
    const scale = this.scaleNode.gain;
    holdAudioParam(scale, time);
    scale.setValueAtTime(this.gateAt(time)?.settings.scale ?? 1, time);
    for (const event of this.events) if (event.kind === 'on' && event.time > time) scale.setValueAtTime(event.settings.scale, event.time);
    for (const segment of this.segments) {
      if (segment.start === segment.end && segment.end >= time) offset.setValueAtTime(segment.to, segment.end);
      else if (segment.end > time) {
        if (segment.start > time) offset.setValueAtTime(segment.from, segment.start);
        offset.linearRampToValueAtTime(segment.to, segment.end);
      }
    }
  }

  private sanitize(value: PitchEnvelopeSettings): PitchEnvelopeSettings {
    const level = (n: number) => clamp(n, LIMITS.pitchLevel.min, LIMITS.pitchLevel.max);
    const seconds = (n: number) => clamp(n, LIMITS.pitchTimeSec.min, LIMITS.pitchTimeSec.max);
    return { start: level(value.start), attack: level(value.attack), sustain: level(value.sustain), release: level(value.release),
      attackSec: seconds(value.attackSec), decaySec: seconds(value.decaySec), releaseSec: seconds(value.releaseSec),
      scale: clamp(value.scale, LIMITS.pitchScale.min, LIMITS.pitchScale.max), releaseTiming: value.releaseTiming === 'rate' ? 'rate' : 'time',
      mode: value.mode === 'one-shot' ? 'one-shot' : 'gate' };
  }
}
