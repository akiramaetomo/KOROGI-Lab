import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { TriggerGate, TriggerRecording, UserPatternId } from '../audio/types';
import { MAX_RECORDING_SEC } from '../model/triggerRecording';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import type { SequenceTransport } from './SequenceTransport';

type Mode = 'idle' | 'starting' | 'recording';
type SelectionEdge = 'start' | 'end';

function timeText(seconds: number): string {
  const centiseconds = Math.floor(Math.max(0, seconds) * 100);
  return `${String(Math.floor(centiseconds / 6000)).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function patternLabel(id: UserPatternId): string { return id === 'user-1' ? 'User 1' : 'User 2'; }

/** Records the selected User pattern; the draft remains separate until Stop. */
export class TriggerRecorder {
  private mode: Mode = 'idle';
  private targetId: string | null = null;
  private targetPatternId: UserPatternId | null = null;
  private targetSynth: ChannelSynth | null = null;
  private request = 0;
  private timer: number | null = null;
  private startedAt = 0;
  private limitSec = P['record-length'].defaultValue;
  private heldOwner: string | null = null;
  private heldId: string | null = null;
  private heldSynth: ChannelSynth | null = null;
  private heldActive = false;
  private heldOnSec: number | null = null;
  private draft: TriggerGate[] = [];

  private readonly length = this.element<HTMLInputElement>('#record-length');
  private readonly toggle = this.element<HTMLButtonElement>('#record-toggle');
  private readonly gate = this.element<HTMLButtonElement>('#record-gate');
  private readonly counter = this.element<HTMLOutputElement>('#record-counter');
  private readonly target = this.element<HTMLElement>('#record-target');
  private readonly timeline = this.element<HTMLElement>('#record-timeline');
  private readonly bars = this.element<HTMLElement>('#record-gates');
  private readonly selection = this.element<HTMLElement>('#record-selection');
  private readonly playhead = this.element<HTMLElement>('#record-playhead');
  private readonly midpoint = this.element<HTMLElement>('#record-midpoint');
  private readonly endpoint = this.element<HTMLElement>('#record-endpoint');
  private readonly startHandle = this.element<HTMLButtonElement>('#record-start-handle');
  private readonly endHandle = this.element<HTMLButtonElement>('#record-end-handle');
  private readonly startValue = this.element<HTMLOutputElement>('#record-start-value');
  private readonly endValue = this.element<HTMLOutputElement>('#record-end-value');
  private readonly play = this.element<HTMLButtonElement>('#sequence-panel');
  private readonly status = this.element<HTMLElement>('#record-status');

  constructor(private readonly engine: () => AudioEngine | null, private readonly selectedId: () => string,
    private readonly ensureRunning: () => Promise<void>, private readonly prepareTarget: (id: string) => void,
    private readonly lockTarget: (id: string | null) => void, private readonly transport: SequenceTransport) {
    this.length.value = String(P['record-length'].defaultValue);
    this.length.setAttribute('aria-label', `Record length in seconds, ${P['record-length'].min} to ${P['record-length'].max}`);
    this.toggle.addEventListener('click', () => { if (this.mode === 'recording') this.finishRecording(); else if (this.mode === 'idle') void this.beginRecording(); });
    this.length.addEventListener('change', () => { if (this.mode === 'idle') this.refresh(); });
    this.play.addEventListener('click', () => { if (this.mode === 'idle') void this.transport.toggle(this.selectedId()); });
    this.bindSelectionHandle(this.startHandle, 'start');
    this.bindSelectionHandle(this.endHandle, 'end');
    this.gate.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.gate.disabled) return;
      if (this.press(`pointer:${event.pointerId}`)) { event.preventDefault(); this.gate.setPointerCapture(event.pointerId); }
    });
    const releasePointer = (event: PointerEvent) => {
      this.release(`pointer:${event.pointerId}`);
      if (this.gate.hasPointerCapture(event.pointerId)) this.gate.releasePointerCapture(event.pointerId);
    };
    this.gate.addEventListener('pointerup', releasePointer);
    this.gate.addEventListener('pointercancel', releasePointer);
    this.gate.addEventListener('lostpointercapture', event => this.release(`pointer:${event.pointerId}`));
    this.gate.addEventListener('keydown', event => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); this.press('keyboard'); }
    });
    this.gate.addEventListener('keyup', event => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.release('keyboard'); }
    });
    this.gate.addEventListener('blur', () => this.release('keyboard'));
    window.addEventListener('blur', () => { if (this.mode === 'recording') this.finishRecording(); else this.cancel(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { if (this.mode === 'recording') this.finishRecording(); else this.cancel(); } });
    this.refresh();
  }

  private element<T extends HTMLElement>(selector: string): T {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`Missing recording control: ${selector}`);
    return node;
  }

  private selectedPatternId(): UserPatternId | null {
    const source = this.transport.source(this.targetId ?? this.selectedId());
    return source.kind === 'user' ? source.patternId : null;
  }

  isBusy(): boolean { return this.mode !== 'idle'; }
  lockedId(): string | null { return this.targetId; }
  refreshClock(): void {
    const id = this.targetId ?? this.selectedId();
    if (this.mode === 'recording') this.updateClock(this.draftRecording());
    else if (this.transport.position(id)) this.updateClock(null);
  }

  refresh(): void {
    const engine = this.engine();
    const id = this.targetId ?? this.selectedId();
    const patternId = this.targetPatternId ?? this.selectedPatternId();
    const recording = this.mode === 'recording' ? this.draftRecording()
      : engine?.getChannel(id) && patternId ? engine.getRecording(id, patternId) : null;
    this.target.textContent = patternId
      ? `Timbre ${id} · ${patternLabel(patternId)} · ${recording ? `${recording.gates.length} Gates` : 'No recording'}`
      : `Timbre ${id} · Select User 1 or User 2`;
    this.renderTimeline(recording);
    this.updateControls(recording, patternId);
    this.updateClock(recording);
    if (this.mode === 'idle') {
      if (this.transport.position(id)) this.status.textContent = 'Loop playing';
      else if (this.status.textContent === 'Loop playing') this.status.textContent = 'Stopped';
    }
  }

  cancel(releaseTrigger = true): void {
    ++this.request;
    if (releaseTrigger) this.endGate(Math.min(this.elapsed(), this.limitSec));
    if (this.mode === 'recording') this.engine()?.cancelScheduledGates(this.targetId!);
    this.clearTimer();
    this.mode = 'idle'; this.targetId = null; this.targetPatternId = null; this.targetSynth = null;
    this.lockTarget(null); this.status.textContent = 'Stopped'; this.refresh();
  }

  stop(): void {
    if (this.mode === 'starting') this.cancel(false);
    else if (this.mode === 'recording') this.finishRecording();
  }

  private async beginRecording(): Promise<void> {
    const engine = this.engine(); const id = this.selectedId(); const synth = engine?.getChannel(id);
    const patternId = this.selectedPatternId();
    if (!patternId) { this.status.textContent = 'Select User 1 or User 2 to record'; return; }
    const seconds = Number(this.length.value); const range = P['record-length'];
    if (!Number.isInteger(seconds) || seconds < range.min || seconds > range.max || seconds > MAX_RECORDING_SEC) {
      this.status.textContent = `Record length: ${range.min}–${range.max} whole seconds`; return;
    }
    if (!engine || !synth) return;
    this.endGate(0);
    const request = ++this.request;
    this.mode = 'starting'; this.targetId = id; this.targetPatternId = patternId; this.targetSynth = synth; this.limitSec = seconds;
    this.lockTarget(id); this.updateControls(engine.getRecording(id, patternId), patternId);
    this.status.textContent = 'Starting audio…';
    try { await this.ensureRunning(); } catch { if (this.request === request) this.cancel(); return; }
    if (request !== this.request || this.engine()?.getChannel(id) !== synth) { if (request === this.request) this.cancel(); return; }
    this.prepareTarget(id);
    this.mode = 'recording'; this.startedAt = engine.context.currentTime;
    this.draft = []; this.heldOwner = null; this.heldId = null; this.heldSynth = null; this.heldActive = false; this.heldOnSec = null;
    this.timer = window.setInterval(() => {
      if (this.mode !== 'recording') return;
      if (this.engine()?.context.state !== 'running' || this.elapsed() >= this.limitSec) { this.finishRecording(); return; }
      const recording = this.draftRecording(); this.updateClock(recording);
      if (this.heldOnSec !== null) this.renderTimeline(recording);
    }, 25);
    this.status.textContent = 'Recording'; this.refresh();
  }

  private elapsed(): number { return Math.max(0, (this.engine()?.context.currentTime ?? this.startedAt) - this.startedAt); }
  private configuredLength(): number {
    const value = Number(this.length.value); const range = P['record-length'];
    return Number.isInteger(value) && value >= range.min && value <= range.max ? value : this.limitSec;
  }

  private press(owner: string): boolean {
    if (this.mode === 'starting' || this.heldOwner) return false;
    if (this.mode === 'recording' && this.elapsed() >= this.limitSec) { this.finishRecording(); return false; }
    const id = this.targetId ?? this.selectedId(); const engine = this.engine(); const synth = engine?.getChannel(id);
    if (!engine || !synth) return false;
    const mode = this.mode;
    this.heldOwner = owner; this.heldId = id; this.heldSynth = synth;
    const start = () => {
      if (this.heldOwner !== owner || this.heldSynth !== synth || this.mode !== mode || this.engine()?.getChannel(id) !== synth) return;
      if (mode === 'recording' && this.elapsed() >= this.limitSec) { this.finishRecording(); return; }
      engine.triggerGateOn(id); this.heldActive = true;
      if (mode === 'recording') this.heldOnSec = Math.min(this.elapsed(), this.limitSec);
      this.gate.setAttribute('aria-pressed', 'true');
      if (mode === 'recording') this.renderTimeline(this.draftRecording());
    };
    if (engine.context.state === 'running') start();
    else void this.ensureRunning().then(start).catch(() => this.release(owner));
    return true;
  }

  private release(owner: string): void {
    if (this.heldOwner !== owner) return;
    this.endGate(Math.min(this.elapsed(), this.limitSec));
    if (this.mode === 'recording') this.renderTimeline(this.draftRecording());
  }

  private endGate(offSec: number): void {
    if (this.heldActive && this.heldId && this.engine()?.getChannel(this.heldId) === this.heldSynth) this.engine()!.triggerGateOff(this.heldId);
    if (this.heldOnSec !== null && offSec > this.heldOnSec) this.draft.push({ onSec: this.heldOnSec, offSec });
    this.heldOwner = null; this.heldId = null; this.heldSynth = null; this.heldActive = false; this.heldOnSec = null;
    this.gate.setAttribute('aria-pressed', 'false');
  }

  private draftRecording(): TriggerRecording {
    const durationSec = this.mode === 'recording' ? this.limitSec : Math.max(.001, this.elapsed());
    const gates = [...this.draft];
    if (this.heldOnSec !== null) {
      const offSec = Math.min(this.elapsed(), durationSec);
      if (offSec > this.heldOnSec) gates.push({ onSec: this.heldOnSec, offSec });
    }
    return { durationSec, selectionStartSec: 0, selectionEndSec: durationSec, gates };
  }

  private finishRecording(): void {
    if (this.mode !== 'recording') return;
    const durationSec = Math.max(.001, Math.min(this.limitSec, this.elapsed()));
    this.endGate(durationSec); this.clearTimer();
    const id = this.targetId!; const patternId = this.targetPatternId!;
    if (this.engine()?.getChannel(id) === this.targetSynth) {
      this.engine()!.setRecording(id, patternId, { durationSec, selectionStartSec: 0, selectionEndSec: durationSec, gates: this.draft });
    }
    this.mode = 'idle'; this.targetId = null; this.targetPatternId = null; this.targetSynth = null;
    this.lockTarget(null); this.status.textContent = 'Recording complete'; this.refresh();
  }

  private bindSelectionHandle(handle: HTMLButtonElement, edge: SelectionEdge): void {
    const move = (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const rect = this.timeline.getBoundingClientRect();
      this.changeSelection(edge, Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || handle.disabled) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId); move(event);
    });
    handle.addEventListener('pointermove', move);
    const release = (event: PointerEvent) => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); };
    handle.addEventListener('pointerup', release); handle.addEventListener('pointercancel', release);
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const duration = Number(handle.getAttribute('aria-valuemax')) || 0;
      const current = Number(handle.getAttribute('aria-valuenow')) || 0;
      const value = event.key === 'Home' ? 0 : event.key === 'End' ? duration
        : current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? .1 : .01);
      this.changeSelection(edge, duration ? value / duration : 0);
    });
  }

  private changeSelection(edge: SelectionEdge, ratio: number): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(); const id = this.selectedId(); const patternId = this.selectedPatternId();
    const recording = engine?.getChannel(id) && patternId ? engine.getRecording(id, patternId) : null;
    if (!recording || !patternId) return;
    const gap = Math.min(.001, recording.durationSec);
    const value = Math.max(0, Math.min(recording.durationSec, ratio * recording.durationSec));
    if (edge === 'start') recording.selectionStartSec = Math.max(0, Math.min(value, recording.selectionEndSec - gap));
    else recording.selectionEndSec = Math.min(recording.durationSec, Math.max(value, recording.selectionStartSec + gap));
    engine!.setRecording(id, patternId, recording);
    this.transport.recordingChanged(id, patternId); this.refresh();
  }

  private clearTimer(): void { if (this.timer !== null) window.clearInterval(this.timer); this.timer = null; }

  private updateControls(recording: TriggerRecording | null | undefined, patternId: UserPatternId | null): void {
    const available = !!this.engine()?.getChannel(this.selectedId());
    this.toggle.disabled = !available || !patternId || this.mode === 'starting';
    this.toggle.textContent = this.mode === 'recording' ? 'End Recording' : 'Start Recording';
    this.toggle.setAttribute('aria-pressed', String(this.mode === 'recording'));
    this.length.disabled = this.mode !== 'idle'; this.gate.disabled = !available || this.mode === 'starting';
    this.gate.setAttribute('aria-pressed', String(this.heldOwner !== null));
    this.startHandle.disabled = this.endHandle.disabled = !recording || this.mode !== 'idle';
    const stopping = this.transport.isPlaying(this.selectedId());
    this.play.disabled = !available || this.mode !== 'idle'; this.play.textContent = stopping ? 'Stop' : 'Play';
    this.play.setAttribute('aria-pressed', String(stopping));
  }

  private renderTimeline(recording: TriggerRecording | null | undefined): void {
    const duration = recording?.durationSec ?? this.configuredLength(); const gates = recording?.gates ?? [];
    this.bars.replaceChildren(...gates.map(gate => {
      const bar = document.createElement('span'); bar.style.left = `${gate.onSec / duration * 100}%`;
      bar.style.width = `${(gate.offSec - gate.onSec) / duration * 100}%`; return bar;
    }));
    const start = recording?.selectionStartSec ?? 0; const end = recording?.selectionEndSec ?? duration;
    this.selection.style.left = `${start / duration * 100}%`; this.selection.style.width = `${(end - start) / duration * 100}%`;
    this.startHandle.style.left = `${start / duration * 100}%`; this.endHandle.style.left = `${end / duration * 100}%`;
    this.midpoint.textContent = `${(duration / 2).toFixed(1)} s`; this.endpoint.textContent = `${duration.toFixed(1)} s`;
    for (const [handle, value, name] of [[this.startHandle, start, 'Start'], [this.endHandle, end, 'End']] as const) {
      handle.setAttribute('aria-valuemin', '0'); handle.setAttribute('aria-valuemax', String(duration));
      handle.setAttribute('aria-valuenow', String(value)); handle.setAttribute('aria-valuetext', `${name} ${value.toFixed(2)} seconds`);
    }
    this.startValue.textContent = `${start.toFixed(2)} s`; this.endValue.textContent = `${end.toFixed(2)} s`;
    this.timeline.setAttribute('aria-label', `${gates.length} recorded Gates over ${duration.toFixed(2)} seconds; selected ${start.toFixed(2)} to ${end.toFixed(2)} seconds`);
  }

  private updateClock(recording: TriggerRecording | null | undefined): void {
    const duration = recording?.durationSec ?? this.transport.position(this.selectedId())?.duration ?? this.configuredLength();
    const positionInfo = this.transport.position(this.selectedId());
    const elapsed = this.mode === 'recording' ? Math.min(this.elapsed(), duration) : positionInfo?.elapsed ?? (recording ? duration : 0);
    this.counter.textContent = `${timeText(elapsed)} / ${timeText(positionInfo?.period ?? duration)}`;
    const position = positionInfo ? positionInfo.start + elapsed : elapsed;
    this.playhead.style.left = `${Math.max(0, Math.min(100, position / duration * 100))}%`;
  }
}
