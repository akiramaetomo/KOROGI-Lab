import type { AudioEngine } from '../audio/core/AudioEngine';
import type { PitchRecording, SequenceSettings, UserPatternId } from '../audio/types';
import { pitchValueAt, quantizePitchValue } from '../model/sequencePitch';
import { selectedTriggerGates, USER_PATTERN_IDS } from '../model/triggerRecording';

type SongEvent = { offset: number; id: string; user: UserPatternId; kind: 'off' | 'reset' | 'on' | 'pitch';
  value?: number; settings?: SequenceSettings; transition?: number; startValue?: number; offOffset?: number };
type SongTemplate = SongEvent & { end: number; period?: number };
export type SongPosition = { user: number; elapsedSec: number; userElapsedSec: number; userDurationSec: number; bar?: number; beat?: number };
export type SongSection = { user: number; offset: number; duration: number; originalDuration: number; barDuration: number; hasRecording: boolean };

const EPSILON = 1e-9;
const EVENT_ORDER: Record<SongEvent['kind'], number> = { off: 0, reset: 1, pitch: 2, on: 3 };

/** One AudioContext clock for all timbres. The ordinary independent-loop transport is separate. */
export class SongTransport {
  private timer = 0;
  private request = 0;
  private startedAt = 0;
  private scheduledUntil = 0;
  private cycleSec = 0;
  private sections: SongSection[] = [];
  private templates: SongTemplate[] = [];
  private activeEngine: AudioEngine | null = null;
  constructor(private readonly engine: () => AudioEngine | null, private readonly ensureRunning: () => Promise<void>,
    private readonly changed: () => void, private readonly stopOrdinary: () => void) {}

  isPlaying(): boolean { return !!this.activeEngine; }
  async toggle(): Promise<boolean> { if (this.activeEngine) { this.stop(); return true; } return this.play(); }
  async play(): Promise<boolean> {
    this.stop();
    const engine = this.engine(); if (!engine) return false;
    const request = ++this.request;
    try { await this.ensureRunning(); } catch { return false; }
    if (request !== this.request || engine !== this.engine()) return false;
    this.sections = this.makeSections(engine);
    if (!this.sections.length) return false;
    this.stopOrdinary();
    this.activeEngine = engine;
    this.startedAt = engine.context.currentTime + .08;
    this.scheduledUntil = this.startedAt - EPSILON;
    this.buildTemplates(engine);
    this.timer = window.setInterval(() => this.tick(), 15);
    this.tick(); this.changed(); return true;
  }
  stop(): void {
    ++this.request;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    if (this.activeEngine) for (const id of this.activeEngine.getChannelIds()) if (this.activeEngine.getChannel(id)) {
      this.activeEngine.cancelScheduledGates(id); this.activeEngine.resetSequencePitch(id);
      this.activeEngine.setSequencePitchMuted(id, false, this.activeEngine.context.currentTime + .05);
    }
    this.activeEngine = null; this.templates = []; this.sections = []; this.cycleSec = 0; this.changed();
  }
  /** Apply BPM or Song Speed at the current section phase, leaving the current Gate sounding. */
  updateTiming(): void {
    const engine = this.activeEngine;
    if (!engine || !this.cycleSec) { this.changed(); return; }
    const now = engine.context.currentTime;
    if (now < this.startedAt) {
      for (const id of engine.getChannelIds()) if (engine.getChannel(id)) {
        engine.cancelSongFuture(id, now); engine.holdSequencePitch(id, now);
      }
      this.sections = this.makeSections(engine); this.buildTemplates(engine);
      this.scheduledUntil = this.startedAt - EPSILON;
      this.tick(); this.changed(); return;
    }
    const elapsed = Math.max(0, now - this.startedAt);
    const cycles = Math.floor(elapsed / this.cycleSec);
    const local = elapsed % this.cycleSec;
    const current = this.sections.find(section => local < section.offset + section.duration) ?? this.sections.at(-1)!;
    const phase = Math.max(0, Math.min(1, (local - current.offset) / current.duration));
    for (const id of engine.getChannelIds()) if (engine.getChannel(id)) {
      engine.cancelSongFuture(id, now);
      engine.holdSequencePitch(id, now);
    }
    this.sections = this.makeSections(engine);
    this.buildTemplates(engine);
    const next = this.sections.find(section => section.user === current.user) ?? this.sections[0]!;
    this.startedAt = now - (cycles * this.cycleSec + next.offset + phase * next.duration);
    this.scheduledUntil = now;
    const localOffset = next.offset + phase * next.duration;
    for (const template of this.templates) {
      if (template.kind !== 'pitch' || !template.transition ||
        template.offset < next.offset || template.offset >= next.offset + next.duration) continue;
      const lap = template.period ? Math.max(0, Math.floor((localOffset - template.offset) / template.period)) : 0;
      const segmentStart = template.offset + lap * (template.period ?? 0);
      if (segmentStart > localOffset || segmentStart + template.transition <= localOffset) continue;
      const remaining = Math.min(segmentStart + template.transition, next.offset + next.duration) - localOffset;
      if (remaining <= 0) continue;
      engine.setSequencePitch(template.id, template.value!, template.settings!.pitchScaleCent,
        template.settings!.filterAmountCent, now, remaining);
    }
    this.tick(); this.changed();
  }
  /**
   * Lane Mute during Song: the Song clock keeps running and only the output of the current section's
   * Pattern is silenced or restored at once. Later sections read their own Pattern's Mute when scheduled.
   */
  laneMutedChanged(id: string, lane: 'gate' | 'pitch'): void {
    const engine = this.activeEngine;
    if (!engine?.getChannel(id) || !this.cycleSec) return;
    const now = engine.context.currentTime;
    if (now < this.startedAt) return;
    const local = (now - this.startedAt) % this.cycleSec;
    const section = this.sections.find(item => local < item.offset + item.duration) ?? this.sections.at(-1)!;
    const user = USER_PATTERN_IDS[section.user - 1]!;
    if (lane === 'pitch') { engine.setSequencePitchMuted(id, engine.getPitchMuted(id, user)); return; }
    if (engine.getGateMuted(id, user)) { engine.cancelScheduledGatesFrom(id, now); engine.gateOff(id, now); return; }
    if (this.templates.some(template => template.kind === 'on' && template.id === id && template.user === user &&
      template.offset <= local && local < template.offOffset!)) engine.gateOn(id, now);
  }
  /**
   * Timeline cursor for one timbre lane while Song plays: available only while the current section is
   * that lane's Pattern. Same shape as SequenceTransport.position (recording-time seconds).
   */
  lanePosition(id: string, lane: 'gate' | 'pitch', user: UserPatternId):
    { elapsed: number; period: number; start: number; duration: number } | null {
    const engine = this.activeEngine;
    if (!engine?.getChannel(id) || !this.cycleSec) return null;
    const now = engine.context.currentTime;
    const local = Math.max(0, now - this.startedAt) % this.cycleSec;
    const section = this.sections.find(item => local < item.offset + item.duration) ?? this.sections.at(-1)!;
    if (USER_PATTERN_IDS[section.user - 1] !== user) return null;
    const recording = lane === 'gate' ? engine.getGateRecording(id, user) : engine.getPitchRecording(id, user);
    if (!recording) return null;
    const period = recording.selectionEndSec - recording.selectionStartSec;
    const { timingMode, speed } = engine.getSongSettings();
    const scale = timingMode === 'bars' ? section.duration / period : 1 / speed;
    const sectionElapsed = Math.max(0, local - section.offset) / scale;
    // Seconds timing loops Pitch inside a longer section; Gate plays once and then holds its end.
    const elapsed = lane === 'pitch' && timingMode !== 'bars' ? sectionElapsed % period : Math.min(period, sectionElapsed);
    return { elapsed, period, start: recording.selectionStartSec, duration: recording.durationSec };
  }
  preview(): SongSection[] { const engine = this.engine(); return engine ? this.makeSections(engine) : []; }
  position(): SongPosition | null {
    const engine = this.activeEngine;
    if (!engine || !this.cycleSec) return null;
    const elapsedSec = Math.max(0, engine.context.currentTime - this.startedAt);
    const local = elapsedSec % this.cycleSec;
    const { bpm, timingMode } = engine.getSongSettings();
    for (const section of this.sections) {
      if (local < section.offset + section.duration || section === this.sections.at(-1)) {
        const userElapsedSec = Math.max(0, local - section.offset);
        const beatSec = 60 / bpm;
        return { user: section.user, elapsedSec, userElapsedSec, userDurationSec: section.duration,
          ...(timingMode === 'bars' ? { bar: Math.floor(userElapsedSec / (4 * beatSec)) + 1,
            beat: Math.floor((userElapsedSec % (4 * beatSec)) / beatSec) + 1 } : {}) };
      }
    }
    return null;
  }
  private makeSections(engine: AudioEngine): SongSection[] {
    const { bpm, speed, bars, timingMode } = engine.getSongSettings();
    const sections: SongSection[] = [];
    let offset = 0;
    for (let index = 0; index < USER_PATTERN_IDS.length; index += 1) {
      const user = USER_PATTERN_IDS[index]!;
      let originalDuration = 0;
      for (const id of engine.getChannelIds()) {
        if (!engine.getChannel(id)) continue;
        const gate = engine.getGateRecording(id, user);
        if (gate) originalDuration = Math.max(originalDuration, gate.selectionEndSec - gate.selectionStartSec);
      }
      if (originalDuration === 0) continue;
      const barDuration = bars[index]! * 240 / bpm;
      // Bars timing is set by BPM alone; Song Speed scales only Seconds timing.
      const duration = timingMode === 'original' ? originalDuration / speed : barDuration;
      sections.push({ user: index + 1, offset, duration, originalDuration, barDuration, hasRecording: true });
      offset += duration;
    }
    return sections;
  }
  private buildTemplates(engine: AudioEngine): void {
    const { timingMode, speed } = engine.getSongSettings();
    const templates: SongTemplate[] = [];
    for (const section of this.sections) {
      const { offset, duration } = section;
      const end = offset + duration;
      const user = USER_PATTERN_IDS[section.user - 1]!;
      for (const id of engine.getChannelIds()) {
        const synth = engine.getChannel(id);
        if (!synth) continue;
        templates.push({ offset, end, id, user, kind: 'off' }, { offset, end, id, user, kind: 'reset' });
        // Muted lanes are scheduled too; Mute is read when each event is dispatched, so it can change live.
        const gate = engine.getGateRecording(id, user);
        if (gate) {
          const scale = timingMode === 'bars' ? duration / (gate.selectionEndSec - gate.selectionStartSec) : 1 / speed;
          for (const item of selectedTriggerGates(gate)) {
            templates.push({ offset: offset + item.onSec * scale, end, id, user, kind: 'on', offOffset: offset + item.offSec * scale });
            templates.push({ offset: offset + item.offSec * scale, end, id, user, kind: 'off' });
          }
        }
        const pitch = engine.getPitchRecording(id, user);
        if (pitch) {
          const period = pitch.selectionEndSec - pitch.selectionStartSec;
          const scale = timingMode === 'bars' ? duration / period : 1 / speed;
          this.addPitchTemplates(templates, id, user, pitch, engine.getSequenceSettings(id, user), offset, end,
            scale, timingMode === 'bars' ? undefined : period * scale);
        }
      }
    }
    this.templates = templates;
    const last = this.sections.at(-1)!;
    this.cycleSec = last.offset + last.duration;
  }
  private addPitchTemplates(templates: SongTemplate[], id: string, user: UserPatternId, recording: PitchRecording, settings: SequenceSettings,
    offset: number, end: number, scale: number, period?: number): void {
    const start = recording.selectionStartSec;
    const points = [{ timeSec: start, valueNormalized: pitchValueAt(recording.points, start) },
      ...recording.points.filter(point => point.timeSec > start && point.timeSec < recording.selectionEndSec),
      { timeSec: recording.selectionEndSec, valueNormalized: pitchValueAt(recording.points, recording.selectionEndSec) }];
    if (settings.pitchMode.kind === 'smooth') {
      templates.push({ offset, end, period, id, user, kind: 'pitch', value: points[0]!.valueNormalized, settings, transition: 0 });
      for (let i = 0; i < points.length - 1; i += 1) templates.push({ offset: offset + (points[i]!.timeSec - start) * scale,
        end, period, id, user, kind: 'pitch', startValue: points[i]!.valueNormalized, value: points[i + 1]!.valueNormalized, settings,
        transition: (points[i + 1]!.timeSec - points[i]!.timeSec) * scale });
    } else {
      let previous: number | undefined;
      for (const point of points.slice(0, -1)) {
        const value = quantizePitchValue(point.valueNormalized, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent);
        if (value === previous) continue;
        templates.push({ offset: offset + (point.timeSec - start) * scale, end, period, id, user, kind: 'pitch', value, settings,
          transition: settings.pitchMode.portamentoSec * scale });
        previous = value;
      }
    }
  }
  private tick(): void {
    const engine = this.activeEngine;
    if (!engine || engine !== this.engine() || engine.context.state !== 'running') { this.stop(); return; }
    const horizon = engine.context.currentTime + .05;
    if (horizon < this.startedAt) return;
    const events: SongEvent[] = [];
    const firstCycle = Math.max(0, Math.floor((this.scheduledUntil - this.startedAt) / this.cycleSec));
    const lastCycle = Math.floor((horizon - this.startedAt) / this.cycleSec);
    for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
      const cycleStart = this.startedAt + cycle * this.cycleSec;
      for (const template of this.templates) {
        const period = template.period;
        const firstLap = period ? Math.max(0, Math.floor((this.scheduledUntil - cycleStart - template.offset) / period)) : 0;
        for (let lap = firstLap; ; lap += 1) {
          const time = cycleStart + template.offset + (period ? lap * period : 0);
          if (time > horizon || time >= cycleStart + template.end - EPSILON) break;
          if (time > this.scheduledUntil) {
            const remaining = cycleStart + template.end - time;
            let transition = template.transition;
            let value = template.value;
            if (transition && transition > remaining) {
              if (template.startValue !== undefined && value !== undefined) value = template.startValue + (value - template.startValue) * remaining / transition;
              transition = remaining;
            }
            events.push({ ...template, offset: time, value, transition });
          }
          if (!period) break;
        }
      }
    }
    events.sort((a, b) => a.offset - b.offset || EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind]);
    for (const event of events) {
      const time = event.offset;
      if (event.kind === 'off') engine.gateOff(event.id, time);
      else if (event.kind === 'reset') {
        engine.resetSequencePitch(event.id, time, 0);
        engine.setSequencePitchMuted(event.id, engine.getPitchMuted(event.id, event.user), time);
      } else if (event.kind === 'on') { if (!engine.getGateMuted(event.id, event.user)) engine.gateOn(event.id, time); }
      else engine.setSequencePitch(event.id, event.value!, event.settings!.pitchScaleCent, event.settings!.filterAmountCent, time, event.transition!);
    }
    this.scheduledUntil = horizon;
  }
}
