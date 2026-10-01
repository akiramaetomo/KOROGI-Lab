import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { PitchPoint, PitchRecording, SequenceSelection, SequenceSettings, TriggerRecording, UserPatternId } from '../audio/types';
import { pitchValueAt, quantizePitchValue } from '../model/sequencePitch';
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
type Run = { source: SequenceSelection; synth: ChannelSynth; autoGate: boolean; gate?: GateRun; pitch?: PitchRun; timer: number };
type LanePosition = { elapsed: number; period: number; start: number; duration: number };

const EPSILON = 1e-9;

/** Per-slot transport with independent Gate and Pitch loop clocks. */
export class SequenceTransport {
  private readonly runs = new Map<string, Run>();
  private readonly requests = new Map<string, number>();
  private allRequest = 0;
  private blocked: { id: string; lane: RecordingLane } | null = null;
  constructor(private readonly engine: () => AudioEngine | null, private readonly ensureRunning: () => Promise<void>,
    private readonly changed: () => void, private readonly report: (message: string) => void,
    private readonly forgetManual: (id: string) => void, private readonly beforePlay: () => void = () => {}) {}

  setRecordingTarget(id: string | null, lane: RecordingLane = 'both'): void {
    const previous = this.blocked?.id ?? null;
    if (previous) this.stop(previous);
    this.blocked = id ? { id, lane } : null;
    if (id && id !== previous) this.stop(id);
    this.changed();
  }
  playRetained(id: string, speedOverride?: number, monitorGate = false, startAt?: number): void {
    const engine = this.engine();
    if (!engine?.getChannel(id) || this.blocked?.id !== id || engine.context.state !== 'running') return;
    this.stopRun(id);
    this.start(id, startAt ?? engine.context.currentTime + .02, this.blocked.lane, speedOverride, monitorGate);
  }
  isRecordingTarget(id: string): boolean { return this.blocked?.id === id; }
  isPlaying(id: string): boolean {
    const run = this.runs.get(id);
    if (run?.autoGate && !run.synth.isAutoTriggerRunning()) { this.stopRun(id); this.changed(); return false; }
    return !!run || (this.requests.get(id) ?? 0) < 0;
  }
  anyPlaying(): boolean { return !!this.engine()?.getChannelIds().some(id => this.isPlaying(id)); }
  source(id: string): SequenceSelection { return this.engine()?.getChannel(id) ? this.engine()!.getSequenceSelection(id)
    : { gateMode: 'auto', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1 }; }
  setSelection(id: string, changes: Partial<SequenceSelection>): void {
    const engine = this.engine(); if (!engine?.getChannel(id) || this.blocked?.id === id) return;
    const playing = this.isPlaying(id);
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
    this.start(id, engine.context.currentTime + .08);
  }
  async playAll(): Promise<void> {
    this.beforePlay();
    this.stopAll(); const engine = this.engine(); if (!engine) return;
    const candidates = new Map(engine.getChannelIds().map(id => [id, engine.getChannel(id)]));
    const tokens = new Map(engine.getChannelIds().map(id => [id, this.requests.get(id)]));
    const request = ++this.allRequest;
    try { await this.ensureRunning(); } catch { return; }
    if (request !== this.allRequest || this.engine() !== engine) return;
    const startAt = engine.context.currentTime + .08;
    for (const id of engine.getChannelIds()) if (id !== this.blocked?.id && tokens.get(id) === this.requests.get(id) &&
      candidates.get(id) && engine.getChannel(id) === candidates.get(id) && this.hasSource(id, this.source(id))) this.start(id, startAt);
    this.changed();
  }
  stop(id: string): void {
    const request = this.requests.get(id) ?? 0;
    this.requests.set(id, Math.abs(request) + 1);
    this.stopRun(id); this.changed();
  }
  stopAll(): void { ++this.allRequest; for (const id of this.engine()?.getChannelIds() ?? []) this.stop(id); }
  beforeReplace(id: string): void { this.stop(id); }

  gateRecordingChanged(id: string, patternId: UserPatternId): void {
    const run = this.runs.get(id); const engine = this.engine();
    if (!run?.gate || !engine || run.source.gateMode !== 'user' || run.source.gateUserId !== patternId) return;
    const boundary = this.nextBoundary(run.gate, engine.context.currentTime);
    engine.cancelScheduledGatesFrom(id, boundary);
    run.gate.pending = { recording: engine.getGateRecording(id, patternId), boundary };
    this.tick(id, run);
  }
  setGateMonitorRecording(id: string, recording: TriggerRecording): void {
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
      run.gate = this.createGateRun(recording, this.source(id).playSpeed, engine.context.currentTime + .02);
      this.ensureTimer(id, run); this.tick(id, run); return;
    }
    const boundary = this.nextBoundary(run.gate, engine.context.currentTime);
    engine.cancelScheduledGatesFrom(id, boundary);
    run.gate.pending = { recording: hasEvents ? recording : null, boundary };
  }
  laneMutedChanged(id: string, lane: 'gate' | 'pitch'): void {
    const run = this.runs.get(id), engine = this.engine(); if (!run || !engine) return;
    const now = engine.context.currentTime;
    if (lane === 'gate' && run.source.gateMode === 'user') {
      engine.cancelScheduledGates(id); run.gate = undefined;
      const recording = engine.getGateMuted(id, run.source.gateUserId) ? null : engine.getGateRecording(id, run.source.gateUserId);
      if (recording && selectedTriggerGates(recording).length) run.gate = this.createGateRun(recording, run.source.playSpeed, now + .02);
    }
    if (lane === 'pitch') {
      engine.resetSequencePitch(id); run.pitch = undefined;
      const recording = engine.getPitchMuted(id, run.source.pitchUserId) ? null : engine.getPitchRecording(id, run.source.pitchUserId);
      if (recording) run.pitch = this.createPitchRun(recording, engine.getSequenceSettings(id, run.source.pitchUserId), now + .02);
    }
    if (!run.autoGate && !run.gate && !run.pitch) this.stop(id);
    else { this.ensureTimer(id, run); this.tick(id, run); this.changed(); }
  }
  /** Compatibility name retained until the Phase 3 recorder is split into lanes. */
  recordingChanged(id: string, patternId: UserPatternId): void { this.gateRecordingChanged(id, patternId); }

  pitchRecordingChanged(id: string, patternId: UserPatternId): void {
    const run = this.runs.get(id); const engine = this.engine();
    if (!run || !engine || run.source.pitchUserId !== patternId) return;
    const recording = engine.getPitchMuted(id, patternId) ? null : engine.getPitchRecording(id, patternId);
    const settings = engine.getSequenceSettings(id, patternId);
    if (!run.pitch) {
      if (recording) { run.pitch = this.createPitchRun(recording, settings, engine.context.currentTime + .02); this.ensureTimer(id, run); this.tick(id, run); }
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
    if (run.autoGate) engine.setAutoPlaySpeed(id, settings.playSpeed);
    if (run.gate && run.gate.speed !== settings.playSpeed) this.retimeGate(id, run.gate, settings.playSpeed, now);
    if (run.pitch) this.retimePitch(id, run.pitch, settings, now);
    this.tick(id, run); this.changed();
  }

  position(id: string, lane: 'gate' | 'pitch' = 'gate'): LanePosition | null {
    const run = this.runs.get(id); const engine = this.engine();
    const state = lane === 'gate' ? run?.gate : run?.pitch;
    return state && engine ? { elapsed: this.phase(state, engine.context.currentTime), period: state.period,
      start: state.recording.selectionStartSec, duration: state.recording.durationSec } : null;
  }

  private hasSource(id: string, source: SequenceSelection): boolean {
    if (source.gateMode === 'auto') return true;
    const engine = this.engine(); if (!engine) return false;
    const gate = engine.getGateMuted(id, source.gateUserId) ? null : engine.getGateRecording(id, source.gateUserId);
    const pitch = engine.getPitchMuted(id, source.pitchUserId) ? null : engine.getPitchRecording(id, source.pitchUserId);
    return (!!gate && selectedTriggerGates(gate).length > 0) || !!pitch;
  }
  private start(id: string, startAt: number, blockedLane?: RecordingLane, speedOverride?: number, monitorGate = false): void {
    const engine = this.engine(), synth = engine?.getChannel(id); if (!engine || !synth) return;
    const source = this.source(id); const settings = engine.getSequenceSettings(id, source.pitchUserId);
    const speed = speedOverride ?? settings.playSpeed;
    const allowGate = blockedLane !== 'gate' && blockedLane !== 'both';
    const allowPitch = blockedLane !== 'pitch' && blockedLane !== 'both';
    const autoGate = source.gateMode === 'auto' && allowGate;
    const gateRecording = (allowGate && source.gateMode === 'user' || monitorGate) && !engine.getGateMuted(id, source.gateUserId)
      ? engine.getGateRecording(id, source.gateUserId) : null;
    const gate = gateRecording && selectedTriggerGates(gateRecording).length
      ? this.createGateRun(gateRecording, speed, startAt) : undefined;
    const pitchRecording = allowPitch && !engine.getPitchMuted(id, source.pitchUserId) ? engine.getPitchRecording(id, source.pitchUserId) : null;
    const pitch = pitchRecording ? this.createPitchRun(pitchRecording, { ...settings, playSpeed: speed }, startAt) : undefined;
    if (!autoGate && !gate && !pitch) return;
    if (!pitch && allowPitch) engine.resetSequencePitch(id, startAt, 0);
    if (autoGate || gate) this.forgetManual(id);
    if (autoGate) engine.startAuto(id, startAt, speed);
    const run: Run = { source, synth, autoGate, gate, pitch, timer: 0 };
    this.runs.set(id, run); this.ensureTimer(id, run); this.tick(id, run); this.changed();
  }
  private stopRun(id: string): void {
    const run = this.runs.get(id); this.runs.delete(id); if (!run) return;
    if (run.timer) window.clearInterval(run.timer);
    const engine = this.engine(); if (engine?.getChannel(id) !== run.synth) return;
    if (run.gate) engine.cancelScheduledGates(id);
    if (run.autoGate) engine.stopAuto(id);
    if (run.pitch) engine.resetSequencePitch(id);
  }
  private ensureTimer(id: string, run: Run): void {
    if (!run.timer && (run.gate || run.pitch)) run.timer = window.setInterval(() => this.tick(id, run), 15);
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
    if (!run.autoGate && !run.gate && !run.pitch) this.stop(id);
  }
  private tickGate(id: string, run: Run, horizon: number): void {
    const engine = this.engine(); let gate = run.gate;
    if (!engine || !gate) return;
    while (gate) {
      const event = gate.events[gate.index]!;
      const time = gate.startedAt + (gate.cycle * gate.period + event.time) / gate.speed;
      if (gate.pending && time >= gate.pending.boundary - EPSILON) {
        gate = this.applyPendingGate(run, gate.pending); run.gate = gate;
        continue;
      }
      if (time > horizon) break;
      if (event.kind === 'on') engine.gateOn(id, time); else engine.gateOff(id, time);
      if (++gate.index === gate.events.length) { gate.index = 0; ++gate.cycle; }
    }
  }
  private applyPendingGate(run: Run, pending: PendingGate): GateRun | undefined {
    if (!pending.recording || !this.events(pending.recording).length) return undefined;
    return this.createGateRun(pending.recording, run.gate?.speed ?? run.source.playSpeed, pending.boundary);
  }
  private tickPitch(id: string, run: Run, horizon: number): void {
    const engine = this.engine(); let pitch = run.pitch;
    if (!engine || !pitch) return;
    while (pitch) {
      const operation = pitch.operations[pitch.index]!;
      const time = pitch.startedAt + (pitch.cycle * pitch.period + operation.time) / pitch.speed;
      if (pitch.pending && time >= pitch.pending.boundary - EPSILON) {
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
    return this.createPitchRun(pending.recording, pending.settings, pending.boundary);
  }
  private retimeGate(id: string, gate: GateRun, speed: number, now: number): void {
    const engine = this.engine()!; const phase = this.phase(gate, now);
    engine.cancelScheduledGatesFrom(id, now);
    gate.startedAt = now - phase / speed; gate.speed = speed; gate.pending = null;
    const active = selectedTriggerGates(gate.recording).some(item => item.onSec <= phase && phase < item.offSec);
    if (active) engine.gateOn(id, now);
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
