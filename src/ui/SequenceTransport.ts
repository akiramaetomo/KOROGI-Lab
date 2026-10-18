import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { PitchPoint, PitchRecording, SequenceSelection, SequenceSettings, TriggerRecording, UserPatternId } from '../audio/types';
import { pitchValueAt, quantizePitchValue } from '../model/sequencePitch';
import { stretchBasePattern, stretchLoopSeconds, stretchSpeed } from '../model/stretch';
import { selectedTriggerGates } from '../model/triggerRecording';

type Event = { time: number; kind: 'on' | 'off' };
type PitchOperation = { time: number; targetNormalized: number; transitionStoredSec: number };
export type RecordingLane = 'gate' | 'pitch' | 'both';
type PendingGate = { recording: TriggerRecording | null; boundary: number };
type PendingPitch = { recording: PitchRecording | null; settings: SequenceSettings; boundary: number };
type GateRun = { recording: TriggerRecording; events: Event[]; startedAt: number; period: number; speed: number;
  cycle: number; index: number; pending: PendingGate | null };
type PitchRun = { recording: PitchRecording; settings: SequenceSettings; operations: PitchOperation[]; startedAt: number;
  period: number; speed: number; cycle: number; index: number; pending: PendingPitch | null };
/** How the recording target's monitor starts when its old playback ends at `switchAt`. */
type Handover = { autoSpeed: number; monitorGate: boolean; monitorPitch: boolean };
/**
 * `stretch` runs share the bar grid; `switchAt` defers a selection change to that bar head. With `handover`,
 * the run is the recording target's old playback, replaced at `switchAt` by the recording monitor.
 */
type Run = { source: SequenceSelection; synth: ChannelSynth; autoGate: boolean; gate?: GateRun; pitch?: PitchRun;
  pitchPunch?: boolean; timer: number; stretch?: boolean; switchAt?: number; handover?: Handover };
type LanePosition = { elapsed: number; period: number; start: number; duration: number };
/** Recorded seconds per real second of each lane; Stretch recording gives the lanes different speeds. */
export type LaneSpeeds = { gate: number; pitch: number };

const EPSILON = 1e-9;

/** Per-slot transport with independent Gate and Pitch loop clocks. */
export class SequenceTransport {
  private readonly runs = new Map<string, Run>();
  private readonly requests = new Map<string, number>();
  private allRequest = 0;
  private blocked: { id: string; lane: RecordingLane } | null = null;
  /** The recording clock's lane speeds, which the recording target's monitor follows. */
  private monitorSpeeds: LaneSpeeds | null = null;
  private startAligner: ((earliest: number) => number) | null = null;
  /** Bar grid shared by playing Stretch timbres: a bar head and the bar length it was set with. */
  private barAnchor = 0;
  private anchorBarSec = 0;
  constructor(private readonly engine: () => AudioEngine | null, private readonly ensureRunning: () => Promise<void>,
    private readonly changed: () => void, private readonly report: (message: string) => void,
    private readonly forgetManual: (id: string) => void, private readonly beforePlay: () => void = () => {}) {}

  setRecordingTarget(id: string | null, lane: RecordingLane = 'both'): void {
    const previous = this.blocked?.id ?? null;
    if (previous) this.stop(previous);
    this.blocked = id ? { id, lane } : null; this.monitorSpeeds = null;
    // On a playing bar grid the target keeps sounding until its recording starts on the next bar head.
    if (id && id !== previous && !(this.runs.has(id) && this.nextGridBar(0, id) !== null)) this.stop(id);
    this.changed();
  }
  /** Starts the recording target's monitor on the recording clock: `speeds` per lane (Stretch), `autoSpeed` for Auto Gate. */
  playRetained(id: string, speeds: LaneSpeeds, autoSpeed: number, monitorGate = false, monitorPitch = false, startAt?: number): void {
    const engine = this.engine();
    if (!engine?.getChannel(id) || this.blocked?.id !== id || engine.context.state !== 'running') return;
    this.monitorSpeeds = speeds;
    const run = this.runs.get(id), at = startAt ?? engine.context.currentTime + .02;
    if (run && !run.handover && at > engine.context.currentTime + .02) {
      // The old playback runs up to the recording start, where the monitor takes over (as a bar-head switch).
      run.handover = { autoSpeed, monitorGate, monitorPitch }; run.switchAt = at;
      this.ensureTimer(id, run); this.tick(id, run); return;
    }
    this.stopRun(id);
    this.start(id, at, this.blocked.lane, autoSpeed, monitorGate, monitorPitch);
  }
  /** The next bar head of the playing Stretch grid, or null when no Stretch timbre other than `except` (default: the recording target) plays. */
  nextGridBar(earliest: number, except = this.blocked?.id): number | null {
    return [...this.runs].some(([id, run]) => id !== except && run.stretch && !run.handover) ? this.nextBar(earliest) : null;
  }
  /** Starts the recording monitor now if the old playback has not yet handed over (a late timer). */
  completeHandover(id: string): void {
    const run = this.runs.get(id);
    if (run?.handover && run.switchAt !== undefined) this.switchRun(id, run, run.switchAt);
  }
  isRecordingTarget(id: string): boolean { return this.blocked?.id === id; }
  /** While recording, other timbres start on the recording loop's next bar instead of immediately. */
  setStartAligner(aligner: ((earliest: number) => number) | null): void { this.startAligner = aligner; }
  /** Restarts every other playing timbre at `startAt` so its loop begins with the recording loop. */
  restartOthersAt(startAt: number): void {
    const ids = [...this.runs.keys()].filter(id => id !== this.blocked?.id);
    // Stop all first so the first Stretch timbre restarted re-anchors the bar grid at startAt.
    for (const id of ids) this.stopRun(id);
    for (const id of ids) this.start(id, startAt);
    this.changed();
  }
  isPlaying(id: string): boolean {
    const run = this.runs.get(id);
    if (run?.autoGate && !run.synth.isAutoTriggerRunning()) { this.stopRun(id); this.changed(); return false; }
    return !!run || (this.requests.get(id) ?? 0) < 0;
  }
  /** The recording target's monitor is owned by the recorder, so Play All / Stop All ignore it. */
  anyPlaying(): boolean { return !!this.engine()?.getChannelIds().some(id => id !== this.blocked?.id && this.isPlaying(id)); }
  source(id: string): SequenceSelection { return this.engine()?.getChannel(id) ? this.engine()!.getSequenceSelection(id)
    : { gateMode: 'auto', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1, stretch: false }; }
  setSelection(id: string, changes: Partial<SequenceSelection>): void {
    const engine = this.engine(); if (!engine?.getChannel(id) || this.blocked?.id === id) return;
    const playing = this.isPlaying(id), run = this.runs.get(id);
    if (playing && run && (run.stretch || ((changes.stretch ?? this.source(id).stretch) && this.otherStretchRunning(id)))) {
      // On the bar grid the old selection plays to the next bar head; the new one starts there.
      engine.setSequenceSelection(id, changes);
      run.switchAt ??= this.nextBar(engine.context.currentTime + .02);
      this.ensureTimer(id, run); this.changed(); return;
    }
    this.stop(id); engine.setSequenceSelection(id, changes);
    if (playing) void this.play(id);
    this.changed();
  }
  async toggle(id: string): Promise<void> { if (this.isPlaying(id)) this.stop(id); else await this.play(id); }
  async toggleAll(): Promise<void> { if (this.anyPlaying()) this.stopAll(); else await this.playAll(); }
  async play(id: string): Promise<void> {
    this.beforePlay();
    const engine = this.engine(); const synth = engine?.getChannel(id);
    if (!engine || !synth || this.blocked?.id === id) return;
    const source = this.source(id);
    if (!this.hasSource(id, source)) { this.report(`Timbre ${id}: no Sequence data; Trigger is available.`); return; }
    this.stop(id);
    const request = (this.requests.get(id) ?? 0) + 1;
    this.requests.set(id, -request); this.changed();
    try { await this.ensureRunning(); } catch { if (this.requests.get(id) === -request) this.requests.set(id, request); this.changed(); return; }
    if (this.requests.get(id) !== -request || this.engine() !== engine || engine.getChannel(id) !== synth || this.blocked?.id === id) return;
    this.requests.set(id, request);
    this.start(id, this.alignedStart(engine.context.currentTime + .08, id));
  }
  async playAll(): Promise<void> {
    this.beforePlay();
    this.stopAll(); const engine = this.engine(); if (!engine) return;
    const candidates = new Map(engine.getChannelIds().map(id => [id, engine.getChannel(id)]));
    const tokens = new Map(engine.getChannelIds().map(id => [id, this.requests.get(id)]));
    const request = ++this.allRequest;
    try { await this.ensureRunning(); } catch { return; }
    if (request !== this.allRequest || this.engine() !== engine) return;
    const startAt = this.alignedStart(engine.context.currentTime + .08);
    for (const id of engine.getChannelIds()) if (id !== this.blocked?.id && tokens.get(id) === this.requests.get(id) &&
      candidates.get(id) && engine.getChannel(id) === candidates.get(id) && this.hasSource(id, this.source(id))) this.start(id, startAt);
    this.changed();
  }
  stop(id: string): void {
    const request = this.requests.get(id) ?? 0;
    this.requests.set(id, Math.abs(request) + 1);
    this.stopRun(id); this.changed();
  }
  stopAll(): void { ++this.allRequest; for (const id of this.engine()?.getChannelIds() ?? []) if (id !== this.blocked?.id) this.stop(id); }
  beforeReplace(id: string): void { this.stop(id); }

  gateRecordingChanged(id: string, patternId: UserPatternId): void {
    const run = this.runs.get(id); const engine = this.engine();
    if (!run?.gate || !engine || run.source.gateMode !== 'user' || run.source.gateUserId !== patternId) return;
    const boundary = this.nextBoundary(run.gate, engine.context.currentTime);
    engine.cancelScheduledGatesFrom(id, boundary);
    run.gate.pending = { recording: engine.getGateRecording(id, patternId), boundary };
    this.tick(id, run);
  }
  setGateMonitorRecording(id: string, recording: TriggerRecording, boundary?: number): void {
    let run = this.runs.get(id); const engine = this.engine();
    if (!engine || !this.blocked || this.blocked.id !== id) return;
    const hasEvents = selectedTriggerGates(recording).length > 0;
    if (!hasEvents && !run?.gate) return;
    if (!run) {
      const synth = engine.getChannel(id); if (!synth) return;
      run = { source: this.source(id), synth, autoGate: false, timer: 0 };
      this.runs.set(id, run);
    }
    if (!run.gate) {
      run.gate = this.createGateRun(recording, this.monitorSpeed('gate', id), boundary ?? engine.context.currentTime + .02);
      if (boundary !== undefined && boundary <= engine.context.currentTime) {
        const phase = this.phase(run.gate, engine.context.currentTime);
        if (!this.gateMuted(id) && selectedTriggerGates(recording).some(gate => gate.onSec <= phase && phase < gate.offSec)) engine.gateOn(id, engine.context.currentTime);
        this.seekAfter(run.gate, phase, run.gate.events);
      }
      this.ensureTimer(id, run); this.tick(id, run); return;
    }
    const switchAt = boundary ?? this.nextBoundary(run.gate, engine.context.currentTime);
    engine.cancelScheduledGatesFrom(id, switchAt);
    if (switchAt <= engine.context.currentTime) {
      if (!hasEvents) run.gate = undefined;
      else {
        const next = this.createGateRun(recording, run.gate.speed, switchAt);
        const phase = this.phase(next, engine.context.currentTime);
        if (!this.gateMuted(id) && selectedTriggerGates(recording).some(gate => gate.onSec <= phase && phase < gate.offSec)) engine.gateOn(id, engine.context.currentTime);
        this.seekAfter(next, phase, next.events);
        run.gate = next;
      }
      this.tick(id, run);
    } else run.gate.pending = { recording: hasEvents ? recording : null, boundary: switchAt };
  }
  /** The first Gate input of a Replace lap takes ownership from the old monitor immediately. */
  suppressGateMonitor(id: string): void {
    if (this.blocked?.id !== id) return;
    const run = this.runs.get(id), engine = this.engine();
    if (!engine) return;
    run && (run.gate = undefined);
    engine.cancelScheduledGates(id);
  }
  setPitchMonitorRecording(id: string, recording: PitchRecording, boundary?: number): void {
    let run = this.runs.get(id); const engine = this.engine();
    if (!engine || this.blocked?.id !== id) return;
    if (!run) {
      const synth = engine.getChannel(id); if (!synth) return;
      run = { source: this.source(id), synth, autoGate: false, timer: 0 };
      this.runs.set(id, run);
    }
    const settings = this.monitorPitchSettings(id, run.source.pitchUserId);
    if (!run.pitch) {
      run.pitch = this.createPitchRun(recording, settings, boundary ?? engine.context.currentTime + .02);
      if (!run.pitchPunch && boundary !== undefined && boundary <= engine.context.currentTime)
        this.retimePitch(id, run.pitch, settings, engine.context.currentTime);
      this.ensureTimer(id, run); this.tick(id, run); return;
    }
    if (run.pitchPunch) {
      run.pitch.recording = recording;
      run.pitch.operations = this.pitchOperations(recording, settings);
      return;
    }
    const switchAt = boundary ?? this.nextBoundary(run.pitch, engine.context.currentTime);
    if (switchAt <= engine.context.currentTime) {
      run.pitch.recording = recording;
      this.retimePitch(id, run.pitch, settings, engine.context.currentTime);
      this.tick(id, run);
    } else {
      engine.holdSequencePitch(id, switchAt);
      run.pitch.pending = { recording, settings, boundary: switchAt };
    }
  }
  beginPitchPunch(id: string): void {
    let run = this.runs.get(id); const engine = this.engine();
    if (!engine || this.blocked?.id !== id || run?.pitchPunch) return;
    if (!run) {
      const synth = engine.getChannel(id); if (!synth) return;
      run = { source: this.source(id), synth, autoGate: false, timer: 0 };
      this.runs.set(id, run);
    }
    run.pitchPunch = true;
    if (run.pitch) engine.holdSequencePitch(id);
  }
  endPitchPunch(id: string, recording: PitchRecording, absolutePosition: number): void {
    const run = this.runs.get(id), engine = this.engine();
    if (!engine || this.blocked?.id !== id) return;
    if (!run?.pitch) {
      const settings = this.monitorPitchSettings(id, this.source(id).pitchUserId);
      if (run) {
        const phase = absolutePosition - recording.selectionStartSec;
        run.pitchPunch = false;
        run.pitch = this.createPitchRun(recording, settings, engine.context.currentTime - phase / settings.playSpeed);
        this.retimePitch(id, run.pitch, settings, engine.context.currentTime);
        this.ensureTimer(id, run); this.tick(id, run);
      } else engine.setSequencePitch(id, pitchValueAt(recording.points, Math.min(recording.durationSec, absolutePosition + .001)), settings.pitchScaleCent,
        settings.filterAmountCent, engine.context.currentTime, 0);
      return;
    }
    run.pitchPunch = false;
    run.pitch.recording = recording;
    this.retimePitch(id, run.pitch, this.monitorPitchSettings(id, run.source.pitchUserId), engine.context.currentTime);
    this.tick(id, run);
  }
  private monitorSpeed(lane: 'gate' | 'pitch', id: string): number { return this.monitorSpeeds?.[lane] ?? this.source(id).playSpeed; }
  private monitorPitchSettings(id: string, patternId: UserPatternId): SequenceSettings {
    const settings = this.engine()!.getSequenceSettings(id, patternId);
    return { ...settings, playSpeed: this.monitorSpeed('pitch', id) };
  }
  /**
   * Lane Mute silences output only: the loop clock and its cursor keep running, and unmuting resumes
   * at the current phase. Gate drops its ON events; Pitch is disconnected after its automation.
   */
  laneMutedChanged(id: string, lane: 'gate' | 'pitch'): void {
    const run = this.runs.get(id), engine = this.engine(); if (!run || !engine) return;
    const now = engine.context.currentTime;
    if (lane === 'gate' && run.gate) {
      if (this.gateMuted(id)) { engine.cancelScheduledGatesFrom(id, now); engine.gateOff(id, now); }
      else {
        const phase = this.phase(run.gate, now);
        if (selectedTriggerGates(run.gate.recording).some(gate => gate.onSec <= phase && phase < gate.offSec)) engine.gateOn(id, now);
      }
    }
    if (lane === 'pitch' && run.pitch) engine.setSequencePitchMuted(id, engine.getPitchMuted(id, run.source.pitchUserId));
    this.changed();
  }
  /** Clear removes the lane from playback (unlike Mute, which keeps its clock running). */
  laneCleared(id: string, lane: 'gate' | 'pitch'): void {
    const run = this.runs.get(id), engine = this.engine(); if (!run || !engine) return;
    if (lane === 'gate' && run.source.gateMode === 'user') { engine.cancelScheduledGates(id); run.gate = undefined; }
    if (lane === 'pitch' && run.pitch) {
      engine.resetSequencePitch(id); run.pitch = undefined;
      engine.setSequencePitchMuted(id, false, engine.context.currentTime + .05);
    }
    if (!run.autoGate && !run.gate && !run.pitch && !run.pitchPunch) this.stop(id);
    else this.changed();
  }
  /** Real loop periods (seconds) of every playing lane, for the Play All drift warning. */
  playingPeriods(): Array<{ id: string; lane: 'gate' | 'pitch'; seconds: number; stretch: boolean }> {
    const periods: Array<{ id: string; lane: 'gate' | 'pitch'; seconds: number; stretch: boolean }> = [];
    for (const [id, run] of this.runs) {
      const stretch = !!run.stretch;
      if (run.gate) periods.push({ id, lane: 'gate', seconds: run.gate.period / run.gate.speed, stretch });
      if (run.pitch) periods.push({ id, lane: 'pitch', seconds: run.pitch.period / run.pitch.speed, stretch });
    }
    return periods;
  }
  /**
   * True when two or more playing timbres loop with periods that are not whole multiples of each other: for
   * some pair (shorter a, longer b), `|b − round(b/a)·a|` exceeds 1 ms. 2.000 s and 0.500 s stay together;
   * 2.000 s and 0.503 s drift 12 ms a lap. Stretch lanes are whole bars or bar fractions on one grid, so each
   * counts as one bar.
   */
  playAllMismatch(): boolean {
    const periods = this.playingPeriods();
    if (new Set(periods.map(item => item.id)).size < 2) return false;
    const seconds = periods.map(item => item.stretch ? this.anchorBarSec : item.seconds).sort((a, b) => a - b);
    return seconds.some((a, index) => seconds.slice(index + 1).some(b => Math.abs(b - Math.round(b / a) * a) > .001));
  }
  /** Compatibility name retained until the Phase 3 recorder is split into lanes. */
  recordingChanged(id: string, patternId: UserPatternId): void { this.gateRecordingChanged(id, patternId); }

  pitchRecordingChanged(id: string, patternId: UserPatternId): void {
    const run = this.runs.get(id); const engine = this.engine();
    if (!run || !engine || run.source.pitchUserId !== patternId) return;
    const recording = engine.getPitchRecording(id, patternId);
    const settings = engine.getSequenceSettings(id, patternId);
    if (!run.pitch) {
      if (recording) { run.pitch = this.createPitchRun(recording, this.pitchSettings(id, run, recording, settings), engine.context.currentTime + .02); this.ensureTimer(id, run); this.tick(id, run); }
      return;
    }
    const boundary = this.nextBoundary(run.pitch, engine.context.currentTime);
    engine.holdSequencePitch(id, boundary);
    run.pitch.pending = { recording, settings, boundary };
    this.tick(id, run);
  }

  sequenceSettingsChanged(id: string): void {
    const run = this.runs.get(id); const engine = this.engine();
    if (!run || !engine) return;
    const settings = engine.getSequenceSettings(id, run.source.pitchUserId); const now = engine.context.currentTime;
    if (this.blocked?.id === id && !run.handover) { this.monitorSettingsChanged(id, run, now); return; }
    if (run.autoGate) engine.setAutoPlaySpeed(id, settings.playSpeed);
    const gateSpeed = run.gate ? this.gateSpeed(id, run, run.gate.recording, settings.playSpeed) : 0;
    if (run.gate && run.gate.speed !== gateSpeed) this.retimeGate(id, run.gate, gateSpeed, now);
    if (run.pitch) this.retimePitch(id, run.pitch, this.pitchSettings(id, run, run.pitch.recording, settings), now);
    this.tick(id, run); this.changed();
  }
  /**
   * Pitch settings changed on the recording target. Its loops keep the recording clock, so only the Pitch
   * monitor is rebuilt with the new settings; a held controller Pitch keeps the lane until it is released.
   */
  private monitorSettingsChanged(id: string, run: Run, now: number): void {
    const pitch = run.pitch;
    if (pitch) {
      const settings = this.monitorPitchSettings(id, run.source.pitchUserId);
      const pending = pitch.pending;
      if (run.pitchPunch) { pitch.settings = settings; pitch.operations = this.pitchOperations(pitch.recording, settings); }
      else this.retimePitch(id, pitch, settings, now);
      // The lap switch to the new take stays at its boundary.
      if (pending) pitch.pending = { ...pending, settings };
    }
    this.tick(id, run); this.changed();
  }
  /**
   * BPM or a Pattern's bars changed. A BPM change rescales the bar grid and every Stretch loop at its
   * current position, leaving sounding Gates alone; a loop whose bar count changed restarts at the next bar head.
   */
  stretchTimingChanged(): void {
    const engine = this.engine(); if (!engine || !this.anchorBarSec) return;
    const now = engine.context.currentTime, barSec = 240 / engine.getSongSettings().bpm;
    if (now > this.barAnchor) this.barAnchor = now - (now - this.barAnchor) / this.anchorBarSec * barSec;
    const oldBarSec = this.anchorBarSec; this.anchorBarSec = barSec;
    for (const [id, run] of this.runs) {
      if (!run.stretch) continue;
      const loopSec = this.stretchLoopSec(id, run.source), lane = run.gate ?? run.pitch;
      if (!loopSec || !lane) continue;
      if (Math.abs(lane.period / lane.speed / oldBarSec - loopSec / barSec) > 1e-6) {
        run.switchAt ??= this.nextBar(now + .02); this.ensureTimer(id, run); continue;
      }
      if (run.gate) this.retimeHeldGate(id, run.gate, run.gate.period / loopSec, now);
      if (run.pitch) {
        const settings = { ...run.pitch.settings, playSpeed: run.pitch.period / loopSec };
        if (run.pitch.startedAt > now) Object.assign(run.pitch, { settings, speed: settings.playSpeed, cycle: 0, index: 0 });
        else this.retimePitch(id, run.pitch, settings, now);
      }
      this.tick(id, run);
    }
    this.changed();
  }

  position(id: string, lane: 'gate' | 'pitch' = 'gate'): LanePosition | null {
    const run = this.runs.get(id); const engine = this.engine();
    const state = lane === 'gate' ? run?.gate : run?.pitch;
    return state && engine ? { elapsed: this.phase(state, engine.context.currentTime), period: state.period,
      start: state.recording.selectionStartSec, duration: state.recording.durationSec } : null;
  }

  private alignedStart(earliest: number, id?: string): number {
    if (this.blocked && this.startAligner) return this.startAligner(earliest);
    return id && this.source(id).stretch && this.otherStretchRunning(id) ? this.nextBar(earliest) : earliest;
  }
  private otherStretchRunning(id: string): boolean { return [...this.runs].some(([other, run]) => other !== id && run.stretch); }
  private nextBar(earliest: number): number {
    const bars = Math.ceil((earliest - this.barAnchor) / this.anchorBarSec - 1e-6);
    return this.barAnchor + Math.max(0, bars) * this.anchorBarSec;
  }
  /** Real seconds of one Stretch loop: the timbre's bars of its Gate Pattern (else its Pitch Pattern) at the Session BPM. */
  private stretchLoopSec(id: string, source: SequenceSelection): number | null {
    const engine = this.engine(); if (!source.stretch || !engine) return null;
    const base = stretchBasePattern(source, !!engine.getGateRecording(id, source.gateUserId));
    return stretchLoopSeconds(engine.getPatternBars(id, base), engine.getSongSettings());
  }
  private gateSpeed(id: string, run: Run, recording: TriggerRecording, playSpeed: number): number {
    const loopSec = run.stretch ? this.stretchLoopSec(id, run.source) : null;
    return loopSec ? stretchSpeed(recording.selectionEndSec - recording.selectionStartSec, loopSec) : playSpeed;
  }
  private pitchSettings(id: string, run: Run, recording: PitchRecording, settings: SequenceSettings): SequenceSettings {
    const loopSec = run.stretch ? this.stretchLoopSec(id, run.source) : null;
    return loopSec ? { ...settings, playSpeed: stretchSpeed(recording.selectionEndSec - recording.selectionStartSec, loopSec) } : settings;
  }
  private hasSource(id: string, source: SequenceSelection): boolean {
    if (source.gateMode === 'auto') return true;
    const engine = this.engine(); if (!engine) return false;
    // A muted lane still runs its clock (silently), so it counts as playable data.
    return !!engine.getGateRecording(id, source.gateUserId) || !!engine.getPitchRecording(id, source.pitchUserId);
  }
  private start(id: string, startAt: number, blockedLane?: RecordingLane, speedOverride?: number,
    monitorGate = false, monitorPitch = false): void {
    const engine = this.engine(), synth = engine?.getChannel(id); if (!engine || !synth) return;
    const source = this.source(id); const settings = engine.getSequenceSettings(id, source.pitchUserId);
    const speed = speedOverride ?? settings.playSpeed;
    // The recording target's monitor follows the recorder's lane speeds (Stretch included); it does not join the bar grid.
    const loopSec = blockedLane === undefined ? this.stretchLoopSec(id, source) : null;
    const laneSpeed = (recording: { selectionStartSec: number; selectionEndSec: number }, lane: 'gate' | 'pitch') =>
      loopSec ? stretchSpeed(recording.selectionEndSec - recording.selectionStartSec, loopSec)
        : blockedLane !== undefined && this.monitorSpeeds ? this.monitorSpeeds[lane] : speed;
    const allowGate = blockedLane !== 'gate' && blockedLane !== 'both';
    const allowPitch = blockedLane !== 'pitch' && blockedLane !== 'both';
    const gateRecording = allowGate && source.gateMode === 'user' || monitorGate ? engine.getGateRecording(id, source.gateUserId) : null;
    const autoGate = source.gateMode === 'auto' && allowGate && !(monitorGate && gateRecording);
    // A selection without Gates still runs as a silent loop clock.
    const gate = gateRecording ? this.createGateRun(gateRecording, laneSpeed(gateRecording, 'gate'), startAt) : undefined;
    const pitchRecording = allowPitch || monitorPitch ? engine.getPitchRecording(id, source.pitchUserId) : null;
    const pitch = pitchRecording ? this.createPitchRun(pitchRecording, { ...settings, playSpeed: laneSpeed(pitchRecording, 'pitch') }, startAt) : undefined;
    if (!autoGate && !gate && !pitch) return;
    if (!pitch && allowPitch) engine.resetSequencePitch(id, startAt, 0);
    if (pitch) engine.setSequencePitchMuted(id, engine.getPitchMuted(id, source.pitchUserId));
    if (loopSec && !this.otherStretchRunning(id)) { this.barAnchor = startAt; this.anchorBarSec = 240 / engine.getSongSettings().bpm; }
    if (autoGate || gate) this.forgetManual(id);
    if (autoGate) engine.startAuto(id, startAt, speed);
    const run: Run = { source, synth, autoGate, gate, pitch, timer: 0, stretch: !!loopSec };
    this.runs.set(id, run); this.ensureTimer(id, run); this.tick(id, run); this.changed();
  }
  private stopRun(id: string): void {
    const run = this.runs.get(id); this.runs.delete(id); if (!run) return;
    if (run.timer) window.clearInterval(run.timer);
    const engine = this.engine(); if (engine?.getChannel(id) !== run.synth) return;
    if (run.gate) engine.cancelScheduledGates(id);
    if (run.autoGate) engine.stopAuto(id);
    if (run.pitch) {
      engine.resetSequencePitch(id);
      // Reconnect after the reset ramp so a muted lane does not jump to its old offset.
      engine.setSequencePitchMuted(id, false, engine.context.currentTime + .05);
    }
  }
  /** Gate lane Mute applies to recorded Gate playback only; Auto Gate is never muted by it. */
  private gateMuted(id: string): boolean {
    const source = this.runs.get(id)?.source ?? this.source(id);
    return !!this.engine()?.getGateMuted(id, source.gateUserId);
  }
  private ensureTimer(id: string, run: Run): void {
    if (!run.timer && (run.gate || run.pitch || run.switchAt !== undefined)) run.timer = window.setInterval(() => this.tick(id, run), 15);
  }
  private events(recording: TriggerRecording): Event[] { return selectedTriggerGates(recording).flatMap(gate => [
    { time: gate.onSec, kind: 'on' as const }, { time: gate.offSec, kind: 'off' as const }
  ]).sort((a, b) => a.time - b.time || (a.kind === 'off' ? -1 : 1)); }
  private createGateRun(recording: TriggerRecording, speed: number, startedAt: number): GateRun {
    return { recording, events: this.events(recording), startedAt,
      period: recording.selectionEndSec - recording.selectionStartSec, speed, cycle: 0, index: 0, pending: null };
  }
  private createPitchRun(recording: PitchRecording, settings: SequenceSettings, startedAt: number): PitchRun {
    return { recording, settings, operations: this.pitchOperations(recording, settings), startedAt,
      period: recording.selectionEndSec - recording.selectionStartSec, speed: settings.playSpeed, cycle: 0, index: 0, pending: null };
  }
  private selectedPitchPoints(recording: PitchRecording): PitchPoint[] {
    const start = recording.selectionStartSec, end = recording.selectionEndSec;
    return [
      { timeSec: 0, valueNormalized: pitchValueAt(recording.points, start) },
      ...recording.points.filter(point => point.timeSec > start && point.timeSec < end)
        .map(point => ({ timeSec: point.timeSec - start, valueNormalized: point.valueNormalized })),
      { timeSec: end - start, valueNormalized: pitchValueAt(recording.points, end) }
    ];
  }
  private pitchOperations(recording: PitchRecording, settings: SequenceSettings): PitchOperation[] {
    const points = this.selectedPitchPoints(recording);
    if (settings.pitchMode.kind === 'smooth') {
      const operations: PitchOperation[] = [{ time: 0, targetNormalized: points[0]!.valueNormalized, transitionStoredSec: 0 }];
      for (let index = 0; index < points.length - 1; index += 1) {
        const point = points[index]!, next = points[index + 1]!;
        operations.push({ time: point.timeSec, targetNormalized: next.valueNormalized, transitionStoredSec: next.timeSec - point.timeSec });
      }
      return operations;
    }
    const operations: PitchOperation[] = [];
    for (const point of points.slice(0, -1)) {
      const targetNormalized = quantizePitchValue(point.valueNormalized, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent);
      if (operations.at(-1)?.targetNormalized === targetNormalized) continue;
      operations.push({ time: point.timeSec, targetNormalized, transitionStoredSec: settings.pitchMode.portamentoSec });
    }
    return operations.length ? operations : [{ time: 0, targetNormalized: 0, transitionStoredSec: settings.pitchMode.portamentoSec }];
  }
  private tick(id: string, run: Run): void {
    const engine = this.engine();
    if (this.runs.get(id) !== run || !engine || engine.getChannel(id) !== run.synth || engine.context.state !== 'running') { this.stop(id); return; }
    const horizon = engine.context.currentTime + .05;
    if (run.gate) this.tickGate(id, run, horizon);
    if (run.pitch) this.tickPitch(id, run, horizon);
    if (run.switchAt !== undefined && horizon >= run.switchAt) { this.switchRun(id, run, run.switchAt); return; }
    if (!run.autoGate && !run.gate && !run.pitch && !run.pitchPunch) this.stop(id);
  }
  /** Ends the old run's events at `at` and starts the current selection there, keeping the bar grid. */
  private switchRun(id: string, run: Run, at: number): void {
    const engine = this.engine()!;
    this.runs.delete(id); if (run.timer) window.clearInterval(run.timer);
    if (run.gate) engine.cancelScheduledGatesFrom(id, at);
    if (run.autoGate) engine.stopAuto(id);
    const handover = run.handover;
    if (!handover) this.start(id, at);
    else if (this.blocked?.id === id) this.start(id, at, this.blocked.lane, handover.autoSpeed, handover.monitorGate, handover.monitorPitch);
    if (!this.runs.has(id) && run.pitch) { engine.resetSequencePitch(id, at, 0); engine.setSequencePitchMuted(id, false, at + .05); }
    this.changed();
  }
  private tickGate(id: string, run: Run, horizon: number): void {
    const engine = this.engine(); let gate = run.gate;
    if (!engine || !gate) return;
    while (gate) {
      if (!gate.events.length) {
        if (!gate.pending || gate.pending.boundary > horizon) break;
        gate = this.applyPendingGate(run, gate.pending); run.gate = gate;
        continue;
      }
      const event = gate.events[gate.index]!;
      const time = gate.startedAt + (gate.cycle * gate.period + event.time) / gate.speed;
      if (run.switchAt !== undefined && time >= run.switchAt - EPSILON) break;
      if (gate.pending && time >= gate.pending.boundary - EPSILON) {
        // Keep the current loop (and its progress) until the switch boundary is near.
        if (gate.pending.boundary > horizon) break;
        gate = this.applyPendingGate(run, gate.pending); run.gate = gate;
        continue;
      }
      if (time > horizon) break;
      if (event.kind === 'off') engine.gateOff(id, time); else if (!this.gateMuted(id)) engine.gateOn(id, time);
      if (++gate.index === gate.events.length) { gate.index = 0; ++gate.cycle; }
    }
  }
  private applyPendingGate(run: Run, pending: PendingGate): GateRun | undefined {
    if (!pending.recording) return undefined;
    const id = [...this.runs].find(([, item]) => item === run)?.[0];
    const speed = run.stretch && id ? this.gateSpeed(id, run, pending.recording, 1) : run.gate?.speed ?? run.source.playSpeed;
    return this.createGateRun(pending.recording, speed, pending.boundary);
  }
  private tickPitch(id: string, run: Run, horizon: number): void {
    if (run.pitchPunch) return;
    const engine = this.engine(); let pitch = run.pitch;
    if (!engine || !pitch) return;
    while (pitch) {
      const operation = pitch.operations[pitch.index]!;
      const time = pitch.startedAt + (pitch.cycle * pitch.period + operation.time) / pitch.speed;
      if (run.switchAt !== undefined && time >= run.switchAt - EPSILON) break;
      if (pitch.pending && time >= pitch.pending.boundary - EPSILON) {
        if (pitch.pending.boundary > horizon) break;
        pitch = this.applyPendingPitch(id, pitch.pending); run.pitch = pitch;
        continue;
      }
      if (time > horizon) break;
      engine.setSequencePitch(id, operation.targetNormalized, pitch.settings.pitchScaleCent, pitch.settings.filterAmountCent, time,
        operation.transitionStoredSec / pitch.speed);
      if (++pitch.index === pitch.operations.length) { pitch.index = 0; ++pitch.cycle; }
    }
  }
  private applyPendingPitch(id: string, pending: PendingPitch): PitchRun | undefined {
    if (!pending.recording) { this.engine()!.resetSequencePitch(id, pending.boundary, 0); return undefined; }
    const run = this.runs.get(id);
    return this.createPitchRun(pending.recording, run ? this.pitchSettings(id, run, pending.recording, pending.settings) : pending.settings, pending.boundary);
  }
  private retimeGate(id: string, gate: GateRun, speed: number, now: number): void {
    const engine = this.engine()!; const phase = this.phase(gate, now);
    engine.cancelScheduledGatesFrom(id, now);
    gate.startedAt = now - phase / speed; gate.speed = speed; gate.pending = null;
    const active = selectedTriggerGates(gate.recording).some(item => item.onSec <= phase && phase < item.offSec);
    if (active && !this.gateMuted(id)) engine.gateOn(id, now);
    this.seekAfter(gate, phase, gate.events);
  }
  /** Rescales a Gate loop at its current position without re-sending ON to a sounding Gate. */
  private retimeHeldGate(id: string, gate: GateRun, speed: number, now: number): void {
    const engine = this.engine()!;
    engine.cancelSongFuture(id, now);
    if (gate.startedAt > now) { gate.speed = speed; gate.cycle = 0; gate.index = 0; return; }
    const phase = this.phase(gate, now);
    gate.startedAt = now - phase / speed; gate.speed = speed;
    if (gate.pending) gate.pending.boundary = this.nextBoundary(gate, now);
    this.seekAfter(gate, phase, gate.events);
  }
  private retimePitch(id: string, pitch: PitchRun, settings: SequenceSettings, now: number): void {
    const engine = this.engine()!; const phase = this.phase(pitch, now);
    engine.holdSequencePitch(id, now);
    pitch.settings = settings; pitch.speed = settings.playSpeed; pitch.startedAt = now - phase / pitch.speed;
    pitch.operations = this.pitchOperations(pitch.recording, settings); pitch.pending = null;
    const points = this.selectedPitchPoints(pitch.recording);
    if (settings.pitchMode.kind === 'smooth') {
      const absolute = pitch.recording.selectionStartSec + phase;
      engine.setSequencePitch(id, pitchValueAt(pitch.recording.points, absolute), settings.pitchScaleCent, settings.filterAmountCent, now, 0);
      const next = points.find(point => point.timeSec > phase + EPSILON);
      if (next) engine.setSequencePitch(id, next.valueNormalized, settings.pitchScaleCent, settings.filterAmountCent, now, (next.timeSec - phase) / pitch.speed);
    } else {
      const previous = [...points.slice(0, -1)].reverse().find(point => point.timeSec <= phase + EPSILON) ?? points[0]!;
      const target = quantizePitchValue(previous.valueNormalized, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent);
      const remaining = Math.max(0, previous.timeSec + settings.pitchMode.portamentoSec - phase);
      engine.setSequencePitch(id, target, settings.pitchScaleCent, settings.filterAmountCent, now, remaining / pitch.speed);
    }
    this.seekAfter(pitch, phase, pitch.operations);
  }
  private seekAfter(state: { cycle: number; index: number }, phase: number, entries: Array<{ time: number }>): void {
    const index = entries.findIndex(entry => entry.time > phase + EPSILON);
    state.cycle = index < 0 ? 1 : 0; state.index = index < 0 ? 0 : index;
  }
  private phase(state: { startedAt: number; period: number; speed: number }, now: number): number {
    if (now <= state.startedAt) return 0;
    const elapsed = (now - state.startedAt) * state.speed;
    return ((elapsed % state.period) + state.period) % state.period;
  }
  private nextBoundary(state: { startedAt: number; period: number; speed: number }, now: number): number {
    if (state.startedAt > now) return state.startedAt;
    const cycles = Math.floor((now - state.startedAt) * state.speed / state.period) + 1;
    return state.startedAt + cycles * state.period / state.speed;
  }
}
