import type { AudioEngine } from '../audio/core/AudioEngine';
import type { PitchRecording, SequenceSettings, UserPatternId } from '../audio/types';
import { pitchValueAt, quantizePitchValue } from '../model/sequencePitch';
import { selectedTriggerGates, USER_PATTERN_IDS } from '../model/triggerRecording';
import { effectivePatternBars } from '../model/songFrame';
import { stretchLoopSeconds } from '../model/stretch';
import { songCell, type SongCell } from '../model/songArrangement';

/** `frame` is the section's Frame; `gateUser` and `pitchUser` are the Patterns its cell plays for the timbre. */
type SongEvent = { offset: number; id: string; frame: number; gateUser: UserPatternId; pitchUser: UserPatternId; kind: 'off' | 'reset' | 'on' | 'pitch';
  value?: number; settings?: SequenceSettings; transition?: number; startValue?: number; offOffset?: number };
type SongTemplate = SongEvent & { end: number; period?: number };
/** `user` is the Frame number (1–8), which for now is also the Pattern number every timbre plays there. */
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
  /** Lane selections and their real-time scale that the current templates were built from, for the Timeline cursor. */
  private lanes = new Map<string, { start: number; period: number; duration: number; scale: number }>();
  /** The cells (`id:frame`) the current templates were built from; an edit replaces them only at the next section head. */
  private cells = new Map<string, SongCell>();
  /** Recording edits wait for the next section head, like Play All's loop boundary. */
  private pending: { at: number; user: number; cycles: number } | null = null;
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
    this.activeEngine = null; this.templates = []; this.sections = []; this.lanes.clear(); this.cells.clear(); this.pending = null; this.cycleSec = 0; this.changed();
  }
  /**
   * Apply BPM, Song Speed or Pitch settings now at the current section phase. A sounding Gate keeps sounding
   * when the new events still hold it, and the Pitch moves to its new value at once.
   */
  updateTiming(): void {
    const engine = this.activeEngine;
    if (!engine || !this.cycleSec) { this.changed(); return; }
    const now = engine.context.currentTime;
    this.pending = null;
    if (now < this.startedAt) {
      for (const id of engine.getChannelIds()) if (engine.getChannel(id)) {
        engine.cancelSongFuture(id, now); engine.holdSequencePitch(id, now);
      }
      this.sections = this.makeSections(engine);
      if (!this.sections.length) { this.stop(); return; }
      this.buildTemplates(engine);
      this.scheduledUntil = this.startedAt - EPSILON;
      this.tick(); this.changed(); return;
    }
    const elapsed = Math.max(0, now - this.startedAt);
    const cycles = Math.floor(elapsed / this.cycleSec);
    const local = elapsed % this.cycleSec;
    const current = this.sectionAt(local);
    const phase = Math.max(0, Math.min(1, (local - current.offset) / current.duration));
    const before = this.templates;
    for (const id of engine.getChannelIds()) if (engine.getChannel(id)) {
      engine.cancelSongFuture(id, now);
      engine.holdSequencePitch(id, now);
    }
    this.sections = this.makeSections(engine);
    if (!this.sections.length) { this.stop(); return; }
    this.buildTemplates(engine);
    const next = this.sections.find(section => section.user === current.user) ?? this.sections[0]!;
    this.startedAt = now - (cycles * this.cycleSec + next.offset + phase * next.duration);
    this.scheduledUntil = now;
    const localOffset = next.offset + phase * next.duration;
    for (const id of engine.getChannelIds()) if (engine.getChannel(id)) {
      const was = gateHeld(before, id, current.user, local), held = gateHeld(this.templates, id, next.user, localOffset);
      const gateUser = this.cells.get(`${id}:${next.user}`)?.gate;
      if (was && !held) engine.gateOff(id, now);
      else if (!was && held && gateUser && !engine.getGateMuted(id, gateUser)) engine.gateOn(id, now);
      this.syncPitch(engine, id, next.user, localOffset, now);
    }
    this.tick(); this.changed();
  }
  /**
   * A Gate or Pitch recording, its selection or a Pattern's bars changed. Like Play All at its loop boundary,
   * the current section finishes as it was and the Song continues from the next section head with the new events.
   */
  contentChanged(): void {
    const engine = this.activeEngine;
    if (!engine || !this.cycleSec) return;
    const now = engine.context.currentTime;
    if (now < this.startedAt) { this.updateTiming(); return; }
    if (this.pending) return;
    const elapsed = now - this.startedAt, cycles = Math.floor(elapsed / this.cycleSec);
    const current = this.sectionAt(elapsed % this.cycleSec);
    this.pending = { at: this.startedAt + cycles * this.cycleSec + current.offset + current.duration, user: current.user, cycles };
  }
  private applyPending(engine: AudioEngine): boolean {
    const pending = this.pending!; this.pending = null;
    this.sections = this.makeSections(engine);
    if (!this.sections.length) { this.stop(); return false; }
    this.buildTemplates(engine);
    const next = this.sections.find(section => section.user > pending.user);
    const cycles = next ? pending.cycles : pending.cycles + 1;
    this.startedAt = pending.at - (cycles * this.cycleSec + (next ?? this.sections[0]!).offset);
    this.scheduledUntil = pending.at - EPSILON;
    this.changed(); return true;
  }
  private sectionAt(local: number): SongSection {
    return this.sections.find(section => local < section.offset + section.duration) ?? this.sections.at(-1)!;
  }
  /** Set the Pitch to the value the current templates hold at a section position, gliding through an unfinished transition. */
  private syncPitch(engine: AudioEngine, id: string, frame: number, local: number, now: number): void {
    let found: { template: SongTemplate; start: number } | null = null;
    for (const template of this.templates) {
      if (template.kind !== 'pitch' || template.id !== id || template.frame !== frame || template.offset > local) continue;
      const lap = template.period ? Math.floor((local - template.offset) / template.period) : 0;
      const start = template.offset + lap * (template.period ?? 0);
      if (start < template.end && (!found || start >= found.start)) found = { template, start };
    }
    if (!found) return;
    const { template, start } = found;
    let value = template.value!, transition = template.transition ? start + template.transition - local : 0;
    if (transition > 0 && start + template.transition! > template.end) {
      if (template.startValue !== undefined) value = template.startValue + (value - template.startValue) * (template.end - start) / template.transition!;
      transition = template.end - local;
    }
    engine.setSequencePitch(id, value, template.settings!.pitchScaleCent, template.settings!.filterAmountCent, now, Math.max(0, transition));
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
    const section = this.sectionAt(local);
    const cell = this.cells.get(`${id}:${section.user}`);
    if (!cell) return;
    if (lane === 'pitch') { engine.setSequencePitchMuted(id, engine.getPitchMuted(id, cell.pitch)); return; }
    if (engine.getGateMuted(id, cell.gate)) { engine.cancelScheduledGatesFrom(id, now); engine.gateOff(id, now); return; }
    if (gateHeld(this.templates, id, section.user, local)) engine.gateOn(id, now);
  }
  /**
   * Timeline cursor for one timbre lane while Song plays: available only while the current section's cell plays
   * that lane's Pattern. Same shape as SequenceTransport.position (recording-time seconds).
   */
  lanePosition(id: string, lane: 'gate' | 'pitch', user: UserPatternId):
    { elapsed: number; period: number; start: number; duration: number } | null {
    const engine = this.activeEngine;
    if (!engine?.getChannel(id) || !this.cycleSec) return null;
    const now = engine.context.currentTime;
    const local = Math.max(0, now - this.startedAt) % this.cycleSec;
    const section = this.sectionAt(local);
    const cell = this.cells.get(`${id}:${section.user}`);
    if (!cell?.on || (lane === 'gate' ? cell.gate : cell.pitch) !== user) return null;
    // The selection the section plays, which an edit replaces only at the next section head.
    const recording = this.lanes.get(`${id}:${lane}:${user}`);
    if (!recording) return null;
    const { period, scale } = recording;
    // Each lane loops inside the section and the section end cuts it: Seconds at Play/Rec Speed, Bars at the Pattern bars.
    const elapsed = (Math.max(0, local - section.offset) / scale) % period;
    return { elapsed, period, start: recording.start, duration: recording.duration };
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
    const { bpm, speed, frameBars, timingMode } = engine.getSongSettings();
    const sections: SongSection[] = [];
    let offset = 0;
    for (let index = 0; index < USER_PATTERN_IDS.length; index += 1) {
      let originalDuration = 0;
      for (const id of engine.getChannelIds()) {
        if (!engine.getChannel(id)) continue;
        const cell = songCell(engine, id, index + 1);
        if (!cell.on) continue;
        const gate = engine.getGateRecording(id, cell.gate);
        // Seconds plays each timbre at its Play/Rec Speed; the longest of them sets the section.
        if (gate) originalDuration = Math.max(originalDuration, (gate.selectionEndSec - gate.selectionStartSec) / engine.getSequenceSelection(id).playSpeed);
      }
      if (originalDuration === 0) continue;
      // Bars sections all last the SongFrame (ADR 0011); Song Speed scales only Seconds timing.
      const barDuration = frameBars * 240 / bpm;
      const duration = timingMode === 'original' ? originalDuration / speed : barDuration;
      sections.push({ user: index + 1, offset, duration, originalDuration, barDuration, hasRecording: true });
      offset += duration;
    }
    return sections;
  }
  /** Real seconds per recorded second under Seconds timing: the timbre's Play/Rec Speed times Song Speed. */
  private secondsScale(engine: AudioEngine, id: string): number {
    return 1 / (engine.getSequenceSelection(id).playSpeed * engine.getSongSettings().speed);
  }
  /**
   * Real seconds per recorded second of a lane: Seconds plays at Play/Rec Speed; Bars fits the selection to the
   * timbre's bars of that Pattern, at most the Frame (ADR 0011), so the lane loops unstretched by the section.
   */
  private laneScale(engine: AudioEngine, id: string, user: UserPatternId, period: number): number {
    const song = engine.getSongSettings();
    if (song.timingMode !== 'bars') return this.secondsScale(engine, id);
    return stretchLoopSeconds(effectivePatternBars(engine.getPatternBars(id, user), song.frameBars), song) / period;
  }
  private buildTemplates(engine: AudioEngine): void {
    const templates: SongTemplate[] = [];
    this.lanes.clear(); this.cells.clear();
    for (const section of this.sections) {
      const { offset, duration } = section;
      const end = offset + duration;
      for (const id of engine.getChannelIds()) {
        const synth = engine.getChannel(id);
        if (!synth) continue;
        const cell = songCell(engine, id, section.user);
        const key = { id, frame: section.user, gateUser: cell.gate, pitchUser: cell.pitch };
        this.cells.set(`${id}:${section.user}`, cell);
        templates.push({ ...key, offset, end, kind: 'off' }, { ...key, offset, end, kind: 'reset' });
        // A timbre whose cell is off rests through the section.
        if (!cell.on) continue;
        // Muted lanes are scheduled too; Mute is read when each event is dispatched, so it can change live.
        const gate = engine.getGateRecording(id, cell.gate);
        if (gate) {
          const gatePeriod = gate.selectionEndSec - gate.selectionStartSec;
          const scale = this.laneScale(engine, id, cell.gate, gatePeriod);
          this.lanes.set(`${id}:gate:${cell.gate}`, { start: gate.selectionStartSec, period: gatePeriod, duration: gate.durationSec, scale });
          // The Gate loops inside the section; the section end closes the last lap.
          const period = gatePeriod * scale;
          for (const item of selectedTriggerGates(gate)) {
            templates.push({ ...key, offset: offset + item.onSec * scale, end, period, kind: 'on', offOffset: offset + item.offSec * scale });
            templates.push({ ...key, offset: offset + item.offSec * scale, end, period, kind: 'off' });
          }
        }
        const pitch = engine.getPitchRecording(id, cell.pitch);
        if (pitch) {
          const period = pitch.selectionEndSec - pitch.selectionStartSec;
          const scale = this.laneScale(engine, id, cell.pitch, period);
          this.lanes.set(`${id}:pitch:${cell.pitch}`, { start: pitch.selectionStartSec, period, duration: pitch.durationSec, scale });
          this.addPitchTemplates(templates, key, pitch, engine.getSequenceSettings(id, cell.pitch), offset, end, scale, period * scale);
        }
      }
    }
    this.templates = templates;
    const last = this.sections.at(-1)!;
    this.cycleSec = last.offset + last.duration;
  }
  private addPitchTemplates(templates: SongTemplate[], key: Pick<SongEvent, 'id' | 'frame' | 'gateUser' | 'pitchUser'>, recording: PitchRecording,
    settings: SequenceSettings, offset: number, end: number, scale: number, period?: number): void {
    const start = recording.selectionStartSec;
    const points = [{ timeSec: start, valueNormalized: pitchValueAt(recording.points, start) },
      ...recording.points.filter(point => point.timeSec > start && point.timeSec < recording.selectionEndSec),
      { timeSec: recording.selectionEndSec, valueNormalized: pitchValueAt(recording.points, recording.selectionEndSec) }];
    if (settings.pitchMode.kind === 'smooth') {
      templates.push({ offset, ...key, end, period, kind: 'pitch', value: points[0]!.valueNormalized, settings, transition: 0 });
      for (let i = 0; i < points.length - 1; i += 1) templates.push({ offset: offset + (points[i]!.timeSec - start) * scale,
        ...key, end, period, kind: 'pitch', startValue: points[i]!.valueNormalized, value: points[i + 1]!.valueNormalized, settings,
        transition: (points[i + 1]!.timeSec - points[i]!.timeSec) * scale });
    } else {
      let previous: number | undefined;
      for (const point of points.slice(0, -1)) {
        const value = quantizePitchValue(point.valueNormalized, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent);
        if (value === previous) continue;
        templates.push({ offset: offset + (point.timeSec - start) * scale, ...key, end, period, kind: 'pitch', value, settings,
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
    if (this.pending && this.pending.at <= horizon) {
      // The section before the edit ends with its own events; the next section head starts the new ones.
      this.schedule(engine, this.pending.at - 1e-6);
      if (!this.applyPending(engine)) return;
    }
    this.schedule(engine, horizon);
  }
  private schedule(engine: AudioEngine, horizon: number): void {
    if (horizon <= this.scheduledUntil) return;
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
        engine.setSequencePitchMuted(event.id, engine.getPitchMuted(event.id, event.pitchUser), time);
      } else if (event.kind === 'on') { if (!engine.getGateMuted(event.id, event.gateUser)) engine.gateOn(event.id, time); }
      else engine.setSequencePitch(event.id, event.value!, event.settings!.pitchScaleCent, event.settings!.filterAmountCent, time, event.transition!);
    }
    this.scheduledUntil = horizon;
  }
}

/** Whether a timbre's recorded Gate is held at a Song position (section ends close every Gate). */
function gateHeld(templates: readonly SongTemplate[], id: string, frame: number, local: number): boolean {
  return templates.some(template => {
    if (template.kind !== 'on' || template.id !== id || template.frame !== frame || template.offset > local || local >= template.end) return false;
    // A looping Gate is held when the position falls inside the same lap of that Gate.
    const lap = template.period ? Math.floor((local - template.offset) / template.period) * template.period : 0;
    return local - lap < template.offOffset!;
  });
}
