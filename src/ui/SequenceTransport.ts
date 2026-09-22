import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { PlaybackSource, TriggerRecording, UserPatternId } from '../audio/types';
import { selectedTriggerGates } from '../model/triggerRecording';

type Event = { time: number; kind: 'on' | 'off' };
type UserRun = { synth: ChannelSynth; recording: TriggerRecording; events: Event[]; startedAt: number; period: number; cycle: number; index: number; timer: number; pending: { recording: TriggerRecording; boundary: number } | null };
type Run = { source: PlaybackSource; synth: ChannelSynth; user?: UserRun };

/** Per-slot transport. Recording capture remains owned by TriggerRecorder. */
export class SequenceTransport {
  private readonly runs = new Map<string, Run>();
  private readonly requests = new Map<string, number>();
  private allRequest = 0;
  private blockedId: string | null = null;
  constructor(private readonly engine: () => AudioEngine | null, private readonly ensureRunning: () => Promise<void>,
    private readonly changed: () => void, private readonly report: (message: string) => void,
    private readonly forgetManual: (id: string) => void) {}

  setRecordingTarget(id: string | null): void { this.blockedId = id; if (id) this.stop(id); this.changed(); }
  isRecordingTarget(id: string): boolean { return this.blockedId === id; }
  isPlaying(id: string): boolean {
    const run = this.runs.get(id);
    if (run?.source.kind === 'auto' && !run.synth.isAutoTriggerRunning()) { this.runs.delete(id); this.changed(); return false; }
    return !!run || (this.requests.get(id) ?? 0) < 0;
  }
  anyPlaying(): boolean { return !!this.engine()?.getChannelIds().some(id => this.isPlaying(id)); }
  source(id: string): PlaybackSource { return this.engine()?.getChannel(id) ? this.engine()!.getPlaybackSource(id) : { kind: 'auto' }; }
  setSource(id: string, source: PlaybackSource): void {
    const engine = this.engine(); if (!engine?.getChannel(id) || this.blockedId === id) return;
    const playing = this.isPlaying(id);
    this.stop(id); engine.setPlaybackSource(id, source);
    if (playing) void this.play(id);
    this.changed();
  }
  async toggle(id: string): Promise<void> { if (this.isPlaying(id)) this.stop(id); else await this.play(id); }
  async toggleAll(): Promise<void> { if (this.anyPlaying()) this.stopAll(); else await this.playAll(); }
  async play(id: string): Promise<void> {
    const engine = this.engine(); const synth = engine?.getChannel(id);
    if (!engine || !synth || id === this.blockedId) return;
    const source = this.source(id);
    if (source.kind === 'user' && !this.hasPattern(id, source.patternId)) { this.report(`Timbre ${id}: record ${this.patternLabel(source.patternId)} before Play.`); return; }
    this.stop(id);
    const request = (this.requests.get(id) ?? 0) + 1;
    this.requests.set(id, -request); this.changed();
    try { await this.ensureRunning(); } catch { if (this.requests.get(id) === -request) this.requests.set(id, request); this.changed(); return; }
    if (this.requests.get(id) !== -request || this.engine() !== engine || engine.getChannel(id) !== synth || id === this.blockedId) return;
    this.requests.set(id, request);
    this.start(id, engine.context.currentTime + .08);
  }
  async playAll(): Promise<void> {
    this.stopAll(); const engine = this.engine(); if (!engine) return;
    const candidates = new Map(engine.getChannelIds().map(id => [id, engine.getChannel(id)]));
    const tokens = new Map(engine.getChannelIds().map(id => [id, this.requests.get(id)]));
    const request = ++this.allRequest;
    try { await this.ensureRunning(); } catch { return; }
    if (request !== this.allRequest || this.engine() !== engine) return;
    const startAt = engine.context.currentTime + .08;
    for (const id of engine.getChannelIds()) if (id !== this.blockedId && tokens.get(id) === this.requests.get(id) &&
      candidates.get(id) && engine.getChannel(id) === candidates.get(id) &&
      (this.source(id).kind === 'auto' || this.hasSelectedPattern(id))) this.start(id, startAt);
    this.changed();
  }
  stop(id: string): void {
    const request = this.requests.get(id) ?? 0;
    this.requests.set(id, Math.abs(request) + 1);
    const run = this.runs.get(id); this.runs.delete(id);
    if (run?.user) { window.clearInterval(run.user.timer); if (this.engine()?.getChannel(id) === run.synth) this.engine()!.cancelScheduledGates(id); }
    else if (run?.source.kind === 'auto' && this.engine()?.getChannel(id) === run.synth) this.engine()!.stopAuto(id);
    this.changed();
  }
  stopAll(): void { ++this.allRequest; for (const id of this.engine()?.getChannelIds() ?? []) this.stop(id); }
  beforeReplace(id: string): void { this.stop(id); }
  recordingChanged(id: string, patternId: UserPatternId): void {
    const user = this.runs.get(id)?.user; const engine = this.engine();
    const source = this.runs.get(id)?.source;
    if (!user || !engine || source?.kind !== 'user' || source.patternId !== patternId) return;
    const recording = engine.getRecording(id, patternId);
    if (!recording) { this.stop(id); return; }
    const now = engine.context.currentTime;
    const boundary = user.startedAt > now ? user.startedAt : user.startedAt + (Math.floor((now - user.startedAt) / user.period) + 1) * user.period;
    engine.cancelScheduledGatesFrom(id, boundary);
    user.pending = { recording, boundary };
    this.tick(id, user);
  }
  position(id: string): { elapsed: number; period: number; start: number; duration: number } | null {
    const user = this.runs.get(id)?.user; const engine = this.engine();
    return user && engine ? { elapsed: Math.max(0, (engine.context.currentTime - user.startedAt) % user.period), period: user.period, start: user.recording.selectionStartSec, duration: user.recording.durationSec } : null;
  }
  private hasSelectedPattern(id: string): boolean { const source = this.source(id); return source.kind === 'user' && this.hasPattern(id, source.patternId); }
  private hasPattern(id: string, patternId: UserPatternId): boolean { const recording = this.engine()?.getRecording(id, patternId); return !!recording && selectedTriggerGates(recording).length > 0; }
  private start(id: string, startAt: number): void {
    const engine = this.engine(), synth = engine?.getChannel(id); if (!engine || !synth) return;
    const source = this.source(id); this.forgetManual(id);
    if (source.kind === 'auto') { engine.startAuto(id, startAt); this.runs.set(id, { source, synth }); }
    else {
      const recording = engine.getRecording(id, source.patternId); if (!recording || !selectedTriggerGates(recording).length) return;
      const user: UserRun = { synth, recording, events: this.events(recording), startedAt: startAt,
        period: recording.selectionEndSec - recording.selectionStartSec, cycle: 0, index: 0, timer: 0, pending: null };
      user.timer = window.setInterval(() => this.tick(id, user), 15);
      this.runs.set(id, { source, synth, user }); this.tick(id, user);
    }
    this.changed();
  }
  private patternLabel(id: UserPatternId): string { return id === 'user-1' ? 'User 1' : 'User 2'; }
  private events(recording: TriggerRecording): Event[] { return selectedTriggerGates(recording).flatMap(gate => [
    { time: gate.onSec, kind: 'on' as const }, { time: gate.offSec, kind: 'off' as const }
  ]).sort((a, b) => a.time - b.time || (a.kind === 'off' ? -1 : 1)); }
  private tick(id: string, user: UserRun): void {
    const engine = this.engine();
    if (this.runs.get(id)?.user !== user || !engine || engine.getChannel(id) !== user.synth || engine.context.state !== 'running') { this.stop(id); return; }
    const horizon = engine.context.currentTime + .05;
    while (true) {
      const event = user.events[user.index]!;
      const time = user.startedAt + user.cycle * user.period + event.time;
      if (user.pending && time >= user.pending.boundary) {
        user.startedAt = user.pending.boundary; user.recording = user.pending.recording;
        user.period = user.recording.selectionEndSec - user.recording.selectionStartSec;
        user.events = this.events(user.recording); user.cycle = 0; user.index = 0; user.pending = null;
        if (!user.events.length) { this.stop(id); return; }
        continue;
      }
      if (time > horizon) break;
      if (event.kind === 'on') engine.gateOn(id, time); else engine.gateOff(id, time);
      if (++user.index === user.events.length) { user.index = 0; ++user.cycle; }
    }
  }
}
