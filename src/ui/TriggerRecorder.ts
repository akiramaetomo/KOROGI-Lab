import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { PitchPoint, PitchRecording, SequenceSelection, SequenceSettings, TriggerGate, TriggerRecording, UserPatternId } from '../audio/types';
import { MAX_RECORDING_SEC } from '../model/triggerRecording';
import { pitchPositions, quantizePitchValue, simplifyPitchPoints } from '../model/sequencePitch';
import type { PitchScaleMode } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { spliceGateRecording, splicePitchRecording } from '../model/sequenceLoopRecording';
import type { RecordingLane, SequenceTransport } from './SequenceTransport';

type Mode = 'idle' | 'starting' | 'recording';
type SelectionEdge = 'start' | 'end';
type TimelineLane = 'gate' | 'pitch';

function timeText(seconds: number): string {
  const centiseconds = Math.floor(Math.max(0, seconds) * 100);
  return `${String(Math.floor(centiseconds / 6000)).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function sourceLabel(id: UserPatternId): string { return `User ${id.slice(-1)}`; }
const SCALE_STOPS = [0, 200, 400, 600, 1200, 2400] as const;
const MOTION_STORAGE_KEY = 'KOROGI-Lab/sequence-slide-gate-motion-v1';
const STOP_TIME_STORAGE_KEY = 'KOROGI-Lab/sequence-slide-gate-stop-time-v1';

interface PitchGesture {
  pointerId: number;
  owner: string;
  ownsGate: boolean;
  id: string;
  synth: ChannelSynth;
  source: SequenceSelection;
  startValue: number;
  offsetX: number;
  lastSignificantX: number;
  lastMovedAt: number | null;
}

/** Records independent Gate and Pitch lanes while retaining the unrecorded lane. */
export class TriggerRecorder {
  private mode: Mode = 'idle';
  private targetId: string | null = null;
  private targetSource: SequenceSelection | null = null;
  private targetSynth: ChannelSynth | null = null;
  private request = 0;
  private timer: number | null = null;
  private startedAt = 0;
  private limitSec = P['record-length'].defaultValue;
  private recordSpeed = 1;
  private recordingLane: RecordingLane = 'gate';
  private userRecordingLane: RecordingLane = 'gate';
  private linked = false;
  private lengthLocked = false;
  private loopRecording = false;
  private loopStart = 0;
  private loopEnd = 0;
  private pitchLoopStart = 0;
  private pitchLoopEnd = 0;
  private completedLaps = 0;
  private gateTouched = false;
  private pitchTouched = false;
  private gatePunchStart: number | null = null;
  private pitchPunchStart: number | null = null;
  private gateWorking: TriggerRecording | null = null;
  private pitchWorking: PitchRecording | null = null;
  private previousRecordLength = String(P['record-length'].defaultValue);
  private lengthLockedToSelection = false;
  private heldOwner: string | null = null;
  private heldId: string | null = null;
  private heldSynth: ChannelSynth | null = null;
  private heldActive = false;
  private heldOnSec: number | null = null;
  private pitchGesture: PitchGesture | null = null;
  private pitchRequest = 0;
  private motionEnabled = true;
  private motionStopMs = 150;
  private gateDraft: TriggerGate[] = [];
  private pitchDraft: PitchPoint[] = [];

  private readonly length = this.element<HTMLInputElement>('#record-length');
  private readonly toggle = this.element<HTMLButtonElement>('#record-toggle');
  private readonly gate = this.element<HTMLButtonElement>('#record-gate');
  private readonly counter = this.element<HTMLOutputElement>('#record-counter');
  private readonly recordMode = this.element<HTMLSelectElement>('#record-mode');
  private readonly pitchInput = this.element<HTMLInputElement>('#sequence-pitch-input');
  private readonly pitchTrack = this.element<HTMLElement>('#sequence-pitch-track');
  private readonly motion = this.element<HTMLButtonElement>('#sequence-motion');
  private readonly motionStop = this.element<HTMLInputElement>('#sequence-motion-stop');
  private readonly motionStopValue = this.element<HTMLOutputElement>('#sequence-motion-stop-value');
  private readonly pitchReadout = this.element<HTMLOutputElement>('#sequence-pitch-readout');
  private readonly pitchCenter = this.element<HTMLButtonElement>('#sequence-pitch-center');
  private readonly pitchMode = this.element<HTMLSelectElement>('#sequence-pitch-mode');
  private readonly pitchSteps = this.element<HTMLInputElement>('#sequence-pitch-steps');
  private readonly portamento = this.element<HTMLInputElement>('#sequence-portamento');
  private readonly filterAmount = this.element<HTMLInputElement>('#sequence-filter-amount');
  private readonly filterWide = this.element<HTMLButtonElement>('#sequence-filter-wide');
  private readonly pitchScale = this.element<HTMLInputElement>('#sequence-pitch-scale');
  private readonly playSpeedInput = this.element<HTMLInputElement>('#sequence-play-speed');
  private readonly pitchTicks = this.element<HTMLElement>('#sequence-pitch-ticks');
  private readonly target = this.element<HTMLElement>('#record-target');
  private readonly pitchTarget = this.element<HTMLElement>('#pitch-record-target');
  private readonly play = this.element<HTMLButtonElement>('#sequence-panel');
  private readonly status = this.element<HTMLElement>('#record-status');
  private readonly log = this.element<HTMLOListElement>('#record-log');
  private readonly link = this.element<HTMLButtonElement>('#sequence-link');
  private readonly lengthLock = this.element<HTMLButtonElement>('#sequence-length-lock');
  private readonly gateMute = this.element<HTMLButtonElement>('#gate-mute');
  private readonly pitchMute = this.element<HTMLButtonElement>('#pitch-mute');
  private readonly gateClear = this.element<HTMLButtonElement>('#gate-clear');
  private readonly pitchClear = this.element<HTMLButtonElement>('#pitch-clear');
  private readonly scaleCustom = this.element<HTMLOutputElement>('#sequence-scale-custom');

  private readonly gateTimeline = this.timelineElements('record');
  private readonly pitchTimeline = this.timelineElements('pitch');
  private readonly gateBars = this.element<HTMLElement>('#record-gates');
  private readonly pitchCurve = this.element<SVGPolylineElement>('#pitch-curve-line');

  constructor(private readonly engine: () => AudioEngine | null, private readonly selectedId: () => string,
    private readonly ensureRunning: (forceAttempt?: boolean) => Promise<void>, private readonly prepareTarget: (id: string) => void,
    private readonly lockTarget: (id: string | null, lane: RecordingLane) => void, private readonly transport: SequenceTransport) {
    this.length.value = String(P['record-length'].defaultValue);
    this.length.setAttribute('aria-label', `Record length in seconds, ${P['record-length'].min} to ${P['record-length'].max}`);
    this.toggle.addEventListener('click', () => { if (this.mode === 'recording') this.finishRecording(); else if (this.mode === 'idle') void this.beginRecording(); });
    this.length.addEventListener('change', () => { if (this.mode === 'idle') this.refresh(); });
    this.play.addEventListener('click', () => { if (this.mode === 'idle') void this.transport.toggle(this.selectedId()); });
    this.recordMode.addEventListener('change', () => {
      this.userRecordingLane = this.recordMode.value as RecordingLane;
      this.refresh();
    });
    this.link.addEventListener('click', () => {
      if (this.mode !== 'idle') return;
      this.linked = !this.linked; this.refresh();
      this.status.textContent = this.linked
        ? this.lengthLocked
          ? 'Link ON: locked intervals shift together, even with different lengths. Loop recording requires equal lengths.'
          : 'Link ON: intervals share a length; Pitch start is independent. Recording loops until End.'
        : 'Link OFF: one take with the specified Record length.';
    });
    this.lengthLock.addEventListener('click', () => {
      if (this.mode !== 'idle') return;
      this.lengthLocked = !this.lengthLocked; this.refresh();
      this.status.textContent = this.lengthLocked
        ? this.linked
          ? 'Length Lock ON: either handle shifts both intervals by the same amount; loop recording requires equal lengths.'
          : 'Length Lock ON: either handle shifts its interval without changing its length.'
        : this.linked
          ? 'Length Lock OFF: Link matches interval lengths while editing handles.'
          : 'Length Lock OFF: selection handles edit the interval edges.';
    });
    this.gateMute.addEventListener('click', () => this.changeMute('gate'));
    this.pitchMute.addEventListener('click', () => this.changeMute('pitch'));
    this.gateClear.addEventListener('click', () => this.clearRecording('gate'));
    this.pitchClear.addEventListener('click', () => this.clearRecording('pitch'));
    this.loadMotionOptions();
    this.motion.addEventListener('click', () => {
      this.motionEnabled = !this.motionEnabled;
      this.syncMotionOptions();
      this.saveMotionOptions();
    });
    this.motionStop.addEventListener('input', () => {
      this.motionStopMs = Number(this.motionStop.value);
      this.syncMotionOptions();
      this.saveMotionOptions();
    });
    this.pitchInput.addEventListener('input', () => {
      this.updateGatePosition();
      this.changePitch(Number(this.pitchInput.value));
    });
    this.pitchCenter.addEventListener('click', () => { this.pitchInput.value = '0'; this.updateGatePosition(); this.changePitch(0); });
    this.filterWide.addEventListener('click', () => {
      if (this.filterWide.disabled) return;
      const wide = this.filterWide.getAttribute('aria-pressed') !== 'true';
      this.filterWide.setAttribute('aria-pressed', String(wide));
      if (!wide) this.filterAmount.value = String(Math.max(-4800, Math.min(4800, Number(this.filterAmount.value))));
      this.filterAmount.dataset.sliderMin = String(wide ? -7200 : -4800);
      this.filterAmount.dataset.sliderMax = String(wide ? 7200 : 4800);
      this.filterAmount.dispatchEvent(new Event('slider-range-change'));
      this.changeSettings();
    });
    for (const input of [this.pitchMode, this.pitchSteps, this.portamento, this.pitchScale, this.filterAmount, this.playSpeedInput]) {
      input.addEventListener('change', () => this.changeSettings(input === this.pitchScale));
    }
    this.bindSelectionHandle(this.gateTimeline.startHandle, 'gate', 'start');
    this.bindSelectionHandle(this.gateTimeline.endHandle, 'gate', 'end');
    this.bindSelectionHandle(this.pitchTimeline.startHandle, 'pitch', 'start');
    this.bindSelectionHandle(this.pitchTimeline.endHandle, 'pitch', 'end');
    this.bindTrigger();
    new ResizeObserver(() => this.updateGatePosition()).observe(this.pitchTrack);
    let lastStatus = '';
    new MutationObserver(() => {
      const message = this.status.textContent?.trim() ?? '';
      if (!message || message === lastStatus) return;
      lastStatus = message;
      const entry = document.createElement('li');
      entry.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
      this.log.prepend(entry);
      while (this.log.children.length > 20) this.log.lastElementChild?.remove();
    }).observe(this.status, { childList: true, characterData: true, subtree: true });
    window.addEventListener('blur', () => { this.endPitchGesture(true); if (this.mode === 'recording') this.finishRecording(); else this.cancel(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.endPitchGesture(true); if (this.mode === 'recording') this.finishRecording(); else this.cancel(); } });
    this.refresh();
  }

  private element<T extends Element>(selector: string): T {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`Missing recording control: ${selector}`);
    return node;
  }

  private timelineElements(prefix: 'record' | 'pitch') {
    return {
      timeline: this.element<HTMLElement>(`#${prefix}-timeline`), selection: this.element<HTMLElement>(`#${prefix}-selection`),
      playhead: this.element<HTMLElement>(`#${prefix}-playhead`), midpoint: this.element<HTMLElement>(`#${prefix}-midpoint`),
      endpoint: this.element<HTMLElement>(`#${prefix}-endpoint`), startHandle: this.element<HTMLButtonElement>(`#${prefix}-start-handle`),
      endHandle: this.element<HTMLButtonElement>(`#${prefix}-end-handle`), startValue: this.element<HTMLOutputElement>(`#${prefix}-start-value`),
      endValue: this.element<HTMLOutputElement>(`#${prefix}-end-value`),
      durationValue: this.element<HTMLOutputElement>(`#${prefix}-duration-value`)
    };
  }

  private currentSource(): SequenceSelection { return this.targetSource ?? this.transport.source(this.targetId ?? this.selectedId()); }
  private includes(lane: TimelineLane): boolean { return this.recordingLane === lane || this.recordingLane === 'both'; }
  isBusy(): boolean { return this.mode !== 'idle'; }
  lockedId(): string | null { return this.targetId; }

  refreshClock(): void {
    const id = this.targetId ?? this.selectedId();
    if (this.mode === 'recording' || this.transport.position(id, 'gate') || this.transport.position(id, 'pitch')) this.updateClock();
  }

  refresh(): void {
    this.updateGatePosition();
    const engine = this.engine(); const id = this.targetId ?? this.selectedId(); const source = this.currentSource();
    const gateRecording = this.mode === 'recording' && this.includes('gate') && this.gateTouched ? this.draftGateRecording()
      : engine?.getChannel(id) ? engine.getGateRecording(id, source.gateUserId) : null;
    const pitchRecording = this.mode === 'recording' && this.includes('pitch') && this.pitchTouched ? this.draftPitchRecording()
      : engine?.getChannel(id) ? engine.getPitchRecording(id, source.pitchUserId) : null;
    this.target.textContent = `Timbre ${id} · ${sourceLabel(source.gateUserId)} · ${gateRecording ? `${gateRecording.gates.length} Gates` : 'Null'}`;
    this.pitchTarget.textContent = `Timbre ${id} · ${sourceLabel(source.pitchUserId)} · ${pitchRecording ?
      pitchRecording.points.every(point => point.valueNormalized === pitchRecording.points[0]!.valueNormalized) ? 'Constant Pitch' : `${pitchRecording.points.length} Points` : 'Null'}`;
    this.renderGateTimeline(gateRecording); this.renderPitchTimeline(pitchRecording);
    this.syncSettings(engine?.getChannel(id) ? engine.getSequenceSettings(id, source.pitchUserId) : null);
    this.updateControls(gateRecording, pitchRecording, source); this.updateClock();
    this.link.setAttribute('aria-pressed', String(this.linked)); this.link.textContent = this.linked ? 'Link ON' : 'Link OFF';
    this.lengthLock.setAttribute('aria-pressed', String(this.lengthLocked)); this.lengthLock.textContent = this.lengthLocked ? 'Lock ON' : 'Lock OFF';
    if (this.mode === 'idle') this.syncRecordLength(gateRecording, pitchRecording);
    if (this.mode === 'idle') {
      if (this.transport.isPlaying(id)) this.status.textContent = 'Loop playing';
      else if (this.status.textContent === 'Loop playing') this.status.textContent = 'Stopped';
    }
  }

  cancel(releaseTrigger = true): void {
    this.endPitchGesture(true);
    ++this.request;
    if (releaseTrigger) this.endGate(Math.min(this.elapsed(), this.limitSec));
    if (this.mode === 'recording' && this.targetId) this.engine()?.cancelScheduledGates(this.targetId);
    this.clearTimer(); this.mode = 'idle'; this.targetId = null; this.targetSource = null; this.targetSynth = null;
    this.loopRecording = false; this.gateWorking = null; this.pitchWorking = null;
    this.lockTarget(null, 'both'); this.status.textContent = 'Stopped'; this.refresh();
  }

  stop(): void { if (this.mode === 'starting') this.cancel(false); else if (this.mode === 'recording') this.finishRecording(); }

  private async beginRecording(): Promise<void> {
    const engine = this.engine(); const id = this.selectedId(); const synth = engine?.getChannel(id); const source = this.transport.source(id);
    const seconds = Number(this.length.value); const range = P['record-length'];
    const oldGate = engine?.getChannel(id) ? engine.getGateRecording(id, source.gateUserId) : null;
    const oldPitch = engine?.getChannel(id) ? engine.getPitchRecording(id, source.pitchUserId) : null;
    const gateLength = oldGate ? oldGate.selectionEndSec - oldGate.selectionStartSec : null;
    const pitchLength = oldPitch ? oldPitch.selectionEndSec - oldPitch.selectionStartSec : null;
    if (this.linked && gateLength !== null && pitchLength !== null && Math.abs(gateLength - pitchLength) > .00001) {
      this.status.textContent = 'Link: Gate and Pitch lengths differ. Move a selection handle to match them.'; return;
    }
    const reference = this.linked ? oldGate ?? oldPitch : null;
    if (!reference && (!Number.isInteger(seconds) || seconds < range.min || seconds > range.max || seconds > MAX_RECORDING_SEC)) {
      this.status.textContent = `Record length: ${range.min}–${range.max} whole seconds`; return;
    }
    if (!engine || !synth) { this.status.textContent = `Timbre ${id} is unavailable. Select a loaded Timbre.`; return; }
    this.recordingLane = this.userRecordingLane; this.endGate(0);
    this.loopRecording = this.linked;
    const loopLength = gateLength ?? pitchLength ?? seconds;
    this.loopStart = oldGate?.selectionStartSec ?? 0; this.loopEnd = this.loopStart + loopLength;
    this.pitchLoopStart = oldPitch?.selectionStartSec ?? 0; this.pitchLoopEnd = this.pitchLoopStart + loopLength;
    this.completedLaps = 0;
    const request = ++this.request;
    this.mode = 'starting'; this.targetId = id; this.targetSource = source; this.targetSynth = synth;
    this.limitSec = this.loopRecording ? loopLength : seconds;
    this.recordSpeed = source.playSpeed;
    this.lockTarget(id, this.recordingLane); this.updateControls(null, null, source);
    this.status.textContent = `Starting Timbre ${id} · ${this.recordingLane} · ${this.loopRecording ? 'Loop' : 'One take'} · Gate ${source.gateUserId}, Pitch ${source.pitchUserId}…`;
    try { await this.ensureRunning(); } catch (error) {
      if (this.request === request) { this.cancel(); this.status.textContent = `Recording could not start audio: ${error instanceof Error ? error.message : String(error)}. Try Start Recording again.`; }
      return;
    }
    if (request !== this.request || this.engine()?.getChannel(id) !== synth) { if (request === this.request) this.cancel(); return; }
    this.prepareTarget(id); this.mode = 'recording'; this.startedAt = engine.context.currentTime + .03;
    this.gateDraft = []; this.pitchDraft = []; this.gateTouched = false; this.pitchTouched = false;
    this.gatePunchStart = null; this.pitchPunchStart = null;
    this.heldOwner = null; this.heldId = null; this.heldSynth = null; this.heldActive = false; this.heldOnSec = null;
    const initialPitch = this.effectivePitchValue(Number(this.pitchInput.value));
    this.gateWorking = this.loopRecording ? oldGate ?? { durationSec: this.loopEnd, selectionStartSec: this.loopStart,
      selectionEndSec: this.loopEnd, gates: [] } : null;
    this.pitchWorking = this.loopRecording ? oldPitch ?? { durationSec: this.pitchLoopEnd, selectionStartSec: this.pitchLoopStart,
      selectionEndSec: this.pitchLoopEnd, points: [{ timeSec: 0, valueNormalized: initialPitch }, { timeSec: this.pitchLoopEnd, valueNormalized: initialPitch }] } : null;
    if (this.includes('pitch')) this.pitchDraft.push({ timeSec: this.loopRecording ? this.pitchLoopStart : 0, valueNormalized: initialPitch });
    this.transport.playRetained(id, this.recordSpeed, this.loopRecording && this.includes('gate'), this.startedAt);
    this.timer = window.setInterval(() => {
      if (this.mode !== 'recording') return;
      if (this.engine()?.context.state !== 'running' || !this.loopRecording && this.elapsed() >= this.limitSec) { this.finishRecording(); return; }
      if (this.loopRecording) this.advanceLaps();
      this.updateClock(); if (this.heldOnSec !== null) this.renderGateTimeline(this.draftGateRecording());
    }, 25);
    this.status.textContent = this.loopRecording ? 'Recording · Loop until End Recording' : 'Recording · One take';
    this.refresh();
  }

  private elapsed(): number { return Math.max(0, (this.engine()?.context.currentTime ?? this.startedAt) - this.startedAt) * this.recordSpeed; }
  private recordPosition(lane: TimelineLane = 'gate'): number {
    return this.loopRecording ? (lane === 'gate' ? this.loopStart : this.pitchLoopStart)
      + Math.max(0, this.elapsed() - this.completedLaps * this.limitSec) : Math.min(this.elapsed(), this.limitSec);
  }
  private configuredLength(): number {
    const value = Number(this.length.value); const range = P['record-length'];
    return Number.isInteger(value) && value >= range.min && value <= range.max ? value : this.limitSec;
  }

  releaseScreenTrigger(): void {
    this.endPitchGesture(true);
    if (this.heldOwner && this.heldOwner !== 'document-space') this.release(this.heldOwner);
  }

  releaseSource(id: string): void {
    if (this.pitchGesture?.id === id) this.endPitchGesture(true);
    if (this.heldId === id && this.heldOwner) this.release(this.heldOwner);
  }

  private loadMotionOptions(): void {
    try {
      this.motionEnabled = localStorage.getItem(MOTION_STORAGE_KEY) !== 'off';
      const stopMs = Number(localStorage.getItem(STOP_TIME_STORAGE_KEY));
      if (stopMs >= 50 && stopMs <= 400 && stopMs % 10 === 0) this.motionStopMs = stopMs;
    } catch { /* Storage can be unavailable in private browsing. */ }
    this.syncMotionOptions();
  }

  private saveMotionOptions(): void {
    try {
      localStorage.setItem(MOTION_STORAGE_KEY, this.motionEnabled ? 'on' : 'off');
      localStorage.setItem(STOP_TIME_STORAGE_KEY, String(this.motionStopMs));
    } catch { /* The controls still work for this page. */ }
  }

  private syncMotionOptions(): void {
    this.motion.setAttribute('aria-pressed', String(this.motionEnabled));
    this.motion.textContent = this.motionEnabled ? 'Motion ON' : 'Motion OFF';
    this.motionStop.value = String(this.motionStopMs);
    this.motionStopValue.textContent = `${this.motionStopMs} ms`;
    this.motionStop.disabled = !this.motionEnabled;
  }

  private updateGatePosition(): void {
    const ratio = (Math.max(-1, Math.min(1, Number(this.pitchInput.value))) + 1) / 2;
    this.gate.style.left = `${28 + ratio * Math.max(0, this.pitchTrack.clientWidth - 56)}px`;
  }

  private pitchAtClientX(clientX: number): number {
    const rect = this.pitchTrack.getBoundingClientRect();
    const position = Math.max(0, Math.min(1, (clientX - rect.left - 28) / Math.max(1, rect.width - 56)));
    return -1 + position * 2;
  }

  private moveGesturePitch(clientX: number): void {
    const gesture = this.pitchGesture;
    if (!gesture) return;
    const value = this.pitchAtClientX(clientX - gesture.offsetX);
    if (Math.abs(Number(this.pitchInput.value) - value) < .0005) return;
    this.pitchInput.value = String(value);
    this.pitchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private recordPitchReturn(valueBefore: number, valueAfter: number): void {
    if (this.mode !== 'recording' || !this.includes('pitch')) return;
    if (this.loopRecording) this.advanceLaps();
    const position = this.recordPosition('pitch');
    const previousTime = this.pitchDraft.at(-1)?.timeSec ?? -Infinity;
    const before = Math.max(previousTime, position - .001);
    this.pitchTouched = true;
    this.pitchPunchStart ??= before;
    this.appendPitchPoint(before, this.effectivePitchValue(valueBefore));
    this.appendPitchPoint(position, this.effectivePitchValue(valueAfter));
    this.renderPitchTimeline(this.draftPitchRecording());
  }

  private endPitchGesture(canceled: boolean): void {
    const gesture = this.pitchGesture;
    if (!gesture) return;
    const shouldReturn = canceled || this.motionEnabled && gesture.lastMovedAt !== null
      && performance.now() - gesture.lastMovedAt < this.motionStopMs;
    if (shouldReturn && Number(this.pitchInput.value) !== gesture.startValue) {
      this.recordPitchReturn(Number(this.pitchInput.value), gesture.startValue);
      this.pitchInput.value = String(gesture.startValue);
      this.updateGatePosition();
      this.changePitch(gesture.startValue, false);
    }
    this.pitchGesture = null;
    if (gesture.ownsGate) this.release(gesture.owner);
    if (this.pitchTrack.hasPointerCapture(gesture.pointerId)) this.pitchTrack.releasePointerCapture(gesture.pointerId);
  }

  private bindTrigger(): void {
    this.pitchTrack.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.pitchInput.disabled || this.pitchGesture) return;
      const id = this.targetId ?? this.selectedId();
      const synth = this.engine()?.getChannel(id);
      if (!synth) return;
      event.preventDefault();
      const thumb = this.gate.getBoundingClientRect();
      const onThumb = event.target === this.gate;
      const gesture: PitchGesture = {
        pointerId: event.pointerId, owner: `pointer:${event.pointerId}`, ownsGate: false, id, synth, source: this.currentSource(),
        startValue: Number(this.pitchInput.value), offsetX: onThumb ? event.clientX - (thumb.left + thumb.width / 2) : 0,
        lastSignificantX: event.clientX, lastMovedAt: null
      };
      this.pitchGesture = gesture;
      if (!onThumb) this.moveGesturePitch(event.clientX);
      gesture.ownsGate = this.press(gesture.owner);
      if (!gesture.ownsGate && !this.heldOwner) { this.pitchGesture = null; return; }
      this.pitchTrack.setPointerCapture(event.pointerId);
    });
    this.pitchTrack.addEventListener('pointermove', event => {
      const gesture = this.pitchGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (Math.abs(event.clientX - gesture.lastSignificantX) >= 3) {
        gesture.lastSignificantX = event.clientX;
        gesture.lastMovedAt = performance.now();
      }
      this.moveGesturePitch(event.clientX);
    });
    this.pitchTrack.addEventListener('pointerup', event => {
      if (this.pitchGesture?.pointerId !== event.pointerId) return;
      this.endPitchGesture(false);
      if (event.pointerType !== 'mouse' && this.engine()?.context.state !== 'running') void this.ensureRunning(true).catch(() => {});
    });
    this.pitchTrack.addEventListener('pointercancel', event => { if (this.pitchGesture?.pointerId === event.pointerId) this.endPitchGesture(true); });
    this.pitchTrack.addEventListener('lostpointercapture', event => { if (this.pitchGesture?.pointerId === event.pointerId) this.endPitchGesture(true); });
    this.gate.addEventListener('keydown', event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); this.press('button-keyboard'); } });
    this.gate.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.release('button-keyboard'); } });
    this.gate.addEventListener('blur', () => this.release('button-keyboard'));
    document.addEventListener('keydown', event => {
      if (event.code !== 'Space' || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || this.spaceBlocked(event.target)) return;
      if (this.press('document-space')) event.preventDefault();
    });
    document.addEventListener('keyup', event => {
      if (event.code === 'Space' && !event.isComposing && this.heldOwner === 'document-space') { event.preventDefault(); this.release('document-space'); }
    });
  }

  private spaceBlocked(target: EventTarget | null): boolean {
    const element = target instanceof HTMLElement ? target : null;
    return !!element?.closest('input, select, textarea, button, [contenteditable="true"]');
  }

  private press(owner: string): boolean {
    if (this.mode === 'starting' || this.heldOwner) return false;
    if (this.mode === 'recording' && !this.loopRecording && this.elapsed() >= this.limitSec) { this.finishRecording(); return false; }
    if (this.mode === 'recording' && this.loopRecording) this.advanceLaps();
    const id = this.targetId ?? this.selectedId(); const engine = this.engine(); const synth = engine?.getChannel(id);
    if (!engine || !synth) return false;
    const mode = this.mode; this.heldOwner = owner; this.heldId = id; this.heldSynth = synth;
    const start = () => {
      if (this.heldOwner !== owner || this.heldSynth !== synth || this.mode !== mode || this.engine()?.getChannel(id) !== synth) return;
      if (mode === 'recording' && !this.loopRecording && this.elapsed() >= this.limitSec) { this.finishRecording(); return; }
      engine.triggerGateOn(id); this.heldActive = true;
      if (mode === 'recording' && this.includes('gate')) {
        this.heldOnSec = this.recordPosition('gate'); this.gateTouched = true;
        this.gatePunchStart ??= this.heldOnSec;
      }
      this.gate.setAttribute('aria-pressed', 'true');
      if (mode === 'recording' && this.includes('gate')) this.renderGateTimeline(this.draftGateRecording());
    };
    if (engine.context.state === 'running') start(); else void this.ensureRunning().then(start).catch(() => this.release(owner));
    return true;
  }

  private release(owner: string): void {
    if (this.heldOwner !== owner) return;
    if (this.mode === 'recording' && this.loopRecording) this.advanceLaps();
    this.endGate(this.recordPosition());
    if (this.mode === 'recording' && this.includes('gate')) this.renderGateTimeline(this.draftGateRecording());
  }

  private endGate(offSec: number): void {
    if (this.heldActive && this.heldId && this.engine()?.getChannel(this.heldId) === this.heldSynth) this.engine()!.triggerGateOff(this.heldId);
    if (this.includes('gate') && this.heldOnSec !== null && offSec > this.heldOnSec) this.gateDraft.push({ onSec: this.heldOnSec, offSec });
    this.heldOwner = null; this.heldId = null; this.heldSynth = null; this.heldActive = false; this.heldOnSec = null;
    this.gate.setAttribute('aria-pressed', 'false');
  }

  private changePitch(rawValue: number, record = true): void {
    if (this.mode === 'recording' && this.loopRecording) this.advanceLaps();
    const value = Math.max(-1, Math.min(1, rawValue)); const engine = this.engine();
    const id = this.pitchGesture?.id ?? this.targetId ?? this.selectedId();
    const source = this.pitchGesture?.source ?? this.currentSource();
    if (this.pitchGesture && engine?.getChannel(id) !== this.pitchGesture.synth) return;
    const settings = engine?.getChannel(id) ? engine.getSequenceSettings(id, source.pitchUserId) : null;
    const effective = settings?.pitchMode.kind === 'stepped'
      ? quantizePitchValue(value, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent) : value;
    this.pitchReadout.textContent = `${Math.round(effective * (settings?.pitchScaleCent ?? P['sequence-pitch-scale'].defaultValue))} cent`;
    if (record && this.mode === 'recording' && this.includes('pitch')) {
      const position = this.recordPosition('pitch'); this.pitchTouched = true; this.pitchPunchStart ??= position;
      this.appendPitchPoint(position, effective);
    }
    if (!engine?.getChannel(id) || !settings) return;
    const synth = engine.getChannel(id);
    const request = ++this.pitchRequest;
    const apply = () => {
      if (request !== this.pitchRequest || engine.getChannel(id) !== synth) return;
      engine.setSequencePitch(id, effective, settings.pitchScaleCent, settings.filterAmountCent, engine.context.currentTime,
        settings.pitchMode.kind === 'stepped' ? settings.pitchMode.portamentoSec : 0);
    };
    if (engine.context.state === 'running') apply(); else void this.ensureRunning().then(apply).catch(() => {});
    if (this.mode === 'recording' && this.includes('pitch')) this.renderPitchTimeline(this.draftPitchRecording());
  }

  private effectivePitchValue(value: number): number {
    const engine = this.engine(); const id = this.targetId ?? this.selectedId();
    const settings = engine?.getChannel(id) ? engine.getSequenceSettings(id, this.currentSource().pitchUserId) : null;
    return settings?.pitchMode.kind === 'stepped'
      ? quantizePitchValue(value, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent) : value;
  }

  private appendPitchPoint(timeSec: number, valueNormalized: number): void {
    const previous = this.pitchDraft.at(-1);
    if (previous && timeSec <= previous.timeSec + 1e-6) { previous.valueNormalized = valueNormalized; return; }
    if (previous?.valueNormalized === valueNormalized) return;
    this.pitchDraft.push({ timeSec, valueNormalized });
  }

  private changeSettings(snapScale = false): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(); const id = this.selectedId(); const source = this.transport.source(id);
    if (!engine?.getChannel(id)) return;
    const steps = Number(this.pitchSteps.value);
    const scale = this.pitchMode.value as PitchScaleMode;
    const portamentoSec = Number(this.portamento.value) / 1000;
    const pitchMode = steps > 0
      ? { kind: 'stepped' as const, stepsPerSide: steps, scale, portamentoSec }
      : { kind: 'smooth' as const, scale, portamentoSec };
    const rawScale = Number(this.pitchScale.value);
    const pitchScaleCent = snapScale ? SCALE_STOPS.reduce((best, value) => Math.abs(value - rawScale) < Math.abs(best - rawScale) ? value : best) : rawScale;
    engine.setSequenceSettings(id, source.pitchUserId, { pitchScaleCent, filterAmountCent: Number(this.filterAmount.value),
      filterAmountWide: this.filterWide.getAttribute('aria-pressed') === 'true', pitchMode,
      recordSpeed: engine.getSequenceSelection(id).recordSpeed, playSpeed: Number(this.playSpeedInput.value) });
    this.transport.sequenceSettingsChanged(id);
    if (!this.transport.isPlaying(id)) this.changePitch(Number(this.pitchInput.value));
    this.refresh();
  }

  private syncSettings(settings: SequenceSettings | null): void {
    this.recordMode.value = this.userRecordingLane; this.syncSegmented(this.recordMode);
    if (!settings) return;
    this.pitchMode.value = settings.pitchMode.scale ?? 'equal';
    this.pitchSteps.value = String(settings.pitchMode.kind === 'stepped' ? settings.pitchMode.stepsPerSide : 0);
    this.portamento.value = String((settings.pitchMode.portamentoSec ?? 0) * 1000);
    this.filterAmount.value = String(settings.filterAmountCent); this.pitchScale.value = String(settings.pitchScaleCent); this.playSpeedInput.value = String(settings.playSpeed);
    this.filterWide.setAttribute('aria-pressed', String(settings.filterAmountWide));
    this.filterAmount.dataset.sliderMin = String(settings.filterAmountWide ? -7200 : -4800);
    this.filterAmount.dataset.sliderMax = String(settings.filterAmountWide ? 7200 : 4800);
    this.filterAmount.dispatchEvent(new Event('slider-range-change'));
    for (const input of [this.pitchSteps, this.portamento, this.pitchScale, this.filterAmount]) input.dispatchEvent(new Event('slider-range-change'));
    this.scaleCustom.textContent = SCALE_STOPS.includes(settings.pitchScaleCent as typeof SCALE_STOPS[number]) ? '' : `Custom ${settings.pitchScaleCent} cent`;
    this.renderPitchTicks(settings);
    this.pitchReadout.textContent = `${Math.round(this.effectivePitchValue(Number(this.pitchInput.value)) * settings.pitchScaleCent)} cent`;
  }

  private syncSegmented(select: HTMLSelectElement): void {
    select.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]').forEach(button => {
      const checked = button.dataset.value === select.value; button.setAttribute('aria-checked', String(checked)); button.tabIndex = checked ? 0 : -1;
    });
  }

  private renderPitchTicks(settings: SequenceSettings): void {
    this.pitchTicks.replaceChildren();
    this.pitchInput.step = settings.pitchMode.kind === 'stepped' && (settings.pitchMode.scale ?? 'equal') === 'equal'
      ? String(1 / settings.pitchMode.stepsPerSide)
      : String(P['sequence-pitch-input'].step);
    const positions = settings.pitchMode.kind === 'stepped'
      ? pitchPositions(settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent)
      : [0];
    for (const value of positions) {
      const tick = document.createElement('span');
      tick.className = value === 0 ? 'center' : ''; tick.style.left = `${(value + 1) * 50}%`;
      this.pitchTicks.append(tick);
    }
  }

  private advanceLaps(): void {
    if (!this.loopRecording || this.mode !== 'recording' || !this.limitSec) return;
    while (this.elapsed() >= (this.completedLaps + 1) * this.limitSec) {
      if (this.includes('gate') && this.gateWorking && this.gatePunchStart !== null) {
        if (this.heldOnSec !== null && this.loopEnd > this.heldOnSec) {
          this.gateDraft.push({ onSec: this.heldOnSec, offSec: this.loopEnd }); this.heldOnSec = this.loopStart;
        }
        this.gateWorking = spliceGateRecording(this.gateWorking, this.gatePunchStart, this.loopEnd, this.gateDraft);
        this.gateDraft = [];
        this.gatePunchStart = this.loopStart;
        this.transport.setGateMonitorRecording(this.targetId!, this.gateWorking);
      }
      if (this.includes('pitch') && this.pitchWorking && this.pitchPunchStart !== null) {
        const value = this.effectivePitchValue(Number(this.pitchInput.value));
        const take = [...this.pitchDraft];
        if (take.at(-1)?.timeSec !== this.pitchLoopEnd) take.push({ timeSec: this.pitchLoopEnd, valueNormalized: value });
        this.pitchWorking = splicePitchRecording(this.pitchWorking, this.pitchPunchStart, this.pitchLoopEnd, take);
        this.pitchDraft = [{ timeSec: this.pitchLoopStart, valueNormalized: value }];
        this.pitchPunchStart = this.pitchLoopStart;
      }
      ++this.completedLaps;
    }
  }

  private draftGateRecording(): TriggerRecording {
    if (this.loopRecording && this.gateWorking) {
      const end = Math.min(this.loopEnd, this.recordPosition());
      const gates = [...this.gateDraft];
      if (this.heldOnSec !== null && end > this.heldOnSec) gates.push({ onSec: this.heldOnSec, offSec: end });
      return this.gatePunchStart !== null && end > this.gatePunchStart
        ? spliceGateRecording(this.gateWorking, this.gatePunchStart, end, gates) : this.gateWorking;
    }
    const durationSec = this.mode === 'recording' ? this.limitSec : Math.max(.001, this.elapsed()); const gates = [...this.gateDraft];
    if (this.heldOnSec !== null) { const offSec = Math.min(this.elapsed(), durationSec); if (offSec > this.heldOnSec) gates.push({ onSec: this.heldOnSec, offSec }); }
    return { durationSec, selectionStartSec: 0, selectionEndSec: durationSec, gates };
  }

  private draftPitchRecording(durationSec = this.mode === 'recording' ? this.limitSec : Math.max(.001, this.elapsed())): PitchRecording {
    if (this.loopRecording && this.pitchWorking) {
      const end = Math.min(this.pitchLoopEnd, this.recordPosition('pitch'));
      const points = [...this.pitchDraft]; const value = this.effectivePitchValue(Number(this.pitchInput.value));
      if (points.at(-1)?.timeSec !== end) points.push({ timeSec: end, valueNormalized: value });
      return this.pitchPunchStart !== null && end > this.pitchPunchStart
        ? splicePitchRecording(this.pitchWorking, this.pitchPunchStart, end, points) : this.pitchWorking;
    }
    const points = this.pitchDraft.length ? this.pitchDraft.map(point => ({ ...point }))
      : [{ timeSec: 0, valueNormalized: this.effectivePitchValue(Number(this.pitchInput.value)) }];
    const value = points.at(-1)!.valueNormalized;
    if (points.at(-1)!.timeSec >= durationSec) points[points.length - 1] = { timeSec: durationSec, valueNormalized: value };
    else points.push({ timeSec: durationSec, valueNormalized: value });
    if (points.length === 1) points.push({ timeSec: durationSec, valueNormalized: value });
    return { durationSec, selectionStartSec: 0, selectionEndSec: durationSec, points };
  }

  private finishRecording(): void {
    if (this.mode !== 'recording') return;
    this.endPitchGesture(true);
    if (this.loopRecording) this.advanceLaps();
    const durationSec = Math.max(.001, Math.min(this.limitSec, this.elapsed()));
    this.endGate(this.recordPosition()); this.clearTimer();
    const id = this.targetId!; const source = this.targetSource!;
    if (this.engine()?.getChannel(id) === this.targetSynth) {
      if (this.includes('gate') && this.gateTouched) this.engine()!.setGateRecording(id, source.gateUserId, this.loopRecording ? this.draftGateRecording()
        : { durationSec, selectionStartSec: 0, selectionEndSec: durationSec, gates: this.gateDraft });
      if (this.includes('pitch') && this.pitchTouched) {
        const recording = this.draftPitchRecording(durationSec); recording.points = simplifyPitchPoints(recording.points);
        this.engine()!.setPitchRecording(id, source.pitchUserId, recording);
      }
      if (this.includes('gate') && this.gateTouched) this.engine()!.setSequenceSelection(id, { gateMode: 'user' });
    }
    this.mode = 'idle'; this.targetId = null; this.targetSource = null; this.targetSynth = null;
    this.loopRecording = false; this.gateWorking = null; this.pitchWorking = null;
    this.lockTarget(null, 'both'); this.status.textContent = this.gateTouched || this.pitchTouched
      ? 'Recording complete' : 'No input recorded; previous Gate and Pitch preserved. Use Trigger or Pitch/Center to record.'; this.refresh();
  }

  private bindSelectionHandle(handle: HTMLButtonElement, lane: TimelineLane, edge: SelectionEdge): void {
    const timeline = lane === 'gate' ? this.gateTimeline.timeline : this.pitchTimeline.timeline;
    const move = (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const rect = timeline.getBoundingClientRect(); this.changeSelection(lane, edge, Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
    };
    handle.addEventListener('pointerdown', event => { if (event.button !== 0 || handle.disabled) return; event.preventDefault(); handle.setPointerCapture(event.pointerId); move(event); });
    handle.addEventListener('pointermove', move);
    const release = (event: PointerEvent) => { if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId); };
    handle.addEventListener('pointerup', release); handle.addEventListener('pointercancel', release);
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const duration = Number(handle.getAttribute('aria-valuemax')) || 0; const current = Number(handle.getAttribute('aria-valuenow')) || 0;
      const value = event.key === 'Home' ? 0 : event.key === 'End' ? duration : current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? .1 : .01);
      this.changeSelection(lane, edge, duration ? value / duration : 0);
    });
  }

  private changeSelection(lane: TimelineLane, edge: SelectionEdge, ratio: number): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(); const id = this.selectedId(); const source = this.transport.source(id);
    const recording = lane === 'gate' ? engine?.getGateRecording(id, source.gateUserId) : engine?.getPitchRecording(id, source.pitchUserId);
    if (!recording) return;
    const gap = .001;
    const value = Math.max(0, Math.min(recording.durationSec, ratio * recording.durationSec));
    const gate = this.linked ? engine?.getGateRecording(id, source.gateUserId) : null;
    const pitch = this.linked ? engine?.getPitchRecording(id, source.pitchUserId) : null;
    if (this.lengthLocked) {
      const active = lane === 'gate' ? gate ?? recording : pitch ?? recording;
      const current = edge === 'start' ? active.selectionStartSec : active.selectionEndSec;
      const paired = lane === 'gate' ? pitch : gate;
      const intervals = paired ? [active, paired] : [active];
      const minDelta = Math.max(...intervals.map(item => -item.selectionStartSec));
      const maxDelta = Math.min(...intervals.map(item => item.durationSec - item.selectionEndSec));
      const delta = Math.max(minDelta, Math.min(maxDelta, value - current));
      if (delta === 0) return;
      for (const item of intervals) {
        item.selectionStartSec += delta;
        item.selectionEndSec += delta;
      }
      if (lane === 'gate' || paired) {
        engine!.setGateRecording(id, source.gateUserId, (gate ?? active) as TriggerRecording);
        this.transport.gateRecordingChanged(id, source.gateUserId);
      }
      if (lane === 'pitch' || paired) {
        engine!.setPitchRecording(id, source.pitchUserId, (pitch ?? active) as PitchRecording);
        this.transport.pitchRecordingChanged(id, source.pitchUserId);
      }
    } else if (gate && pitch) {
      if (lane === 'pitch' && edge === 'start') {
        const length = gate.selectionEndSec - gate.selectionStartSec;
        if (length > pitch.durationSec) { this.status.textContent = 'Link: shorten the Gate interval to fit the Pitch recording.'; return; }
        pitch.selectionStartSec = Math.min(value, pitch.durationSec - length);
        pitch.selectionEndSec = pitch.selectionStartSec + length;
      } else {
        const start = lane === 'gate' ? gate.selectionStartSec : pitch.selectionStartSec;
        const desiredLength = lane === 'gate' && edge === 'start' ? gate.selectionEndSec - value : value - start;
        const maxLength = Math.min(lane === 'gate' && edge === 'start' ? gate.selectionEndSec : gate.durationSec - gate.selectionStartSec,
          pitch.durationSec - pitch.selectionStartSec);
        if (maxLength < gap) { this.status.textContent = 'Link: no room for this interval. Move the Pitch start earlier.'; return; }
        const length = Math.max(gap, Math.min(maxLength, desiredLength));
        if (lane === 'gate' && edge === 'start') gate.selectionStartSec = gate.selectionEndSec - length;
        else gate.selectionEndSec = gate.selectionStartSec + length;
        pitch.selectionEndSec = pitch.selectionStartSec + length;
      }
      engine!.setGateRecording(id, source.gateUserId, gate); this.transport.gateRecordingChanged(id, source.gateUserId);
      engine!.setPitchRecording(id, source.pitchUserId, pitch); this.transport.pitchRecordingChanged(id, source.pitchUserId);
    } else {
      if (edge === 'start') recording.selectionStartSec = Math.min(value, recording.selectionEndSec - gap);
      else recording.selectionEndSec = Math.max(recording.selectionStartSec + gap, value);
      if (lane === 'gate') { engine!.setGateRecording(id, source.gateUserId, recording as TriggerRecording); this.transport.gateRecordingChanged(id, source.gateUserId); }
      else { engine!.setPitchRecording(id, source.pitchUserId, recording as PitchRecording); this.transport.pitchRecordingChanged(id, source.pitchUserId); }
    }
    this.refresh();
  }

  private changeMute(lane: TimelineLane): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(), id = this.selectedId(); if (!engine?.getChannel(id)) return;
    const source = this.transport.source(id);
    if (lane === 'gate') {
      if (!engine.getGateRecording(id, source.gateUserId)) return;
      engine.setGateMuted(id, source.gateUserId, !engine.getGateMuted(id, source.gateUserId));
    } else {
      if (!engine.getPitchRecording(id, source.pitchUserId)) return;
      engine.setPitchMuted(id, source.pitchUserId, !engine.getPitchMuted(id, source.pitchUserId));
    }
    this.transport.laneMutedChanged(id, lane); this.refresh();
  }

  private clearRecording(lane: TimelineLane): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(), id = this.selectedId(); if (!engine?.getChannel(id)) return;
    const source = this.transport.source(id), patternId = lane === 'gate' ? source.gateUserId : source.pitchUserId;
    const recording = lane === 'gate' ? engine.getGateRecording(id, patternId) : engine.getPitchRecording(id, patternId);
    if (!recording || !window.confirm(`Clear Timbre ${id} ${lane === 'gate' ? 'Gate' : 'Pitch'} ${sourceLabel(patternId)}?`)) return;
    if (lane === 'gate') { engine.setGateRecording(id, patternId, null); engine.setGateMuted(id, patternId, false); this.transport.laneMutedChanged(id, 'gate'); }
    else { engine.setPitchRecording(id, patternId, null); engine.setPitchMuted(id, patternId, false); this.transport.laneMutedChanged(id, 'pitch'); }
    this.refresh();
  }

  private syncRecordLength(gate: TriggerRecording | null, pitch: PitchRecording | null): void {
    const reference = this.linked ? gate ?? pitch : null;
    if (reference) {
      if (!this.lengthLockedToSelection) this.previousRecordLength = this.length.value;
      this.length.value = String(Number((reference.selectionEndSec - reference.selectionStartSec).toFixed(3)));
      this.length.disabled = true;
      this.lengthLockedToSelection = true;
    } else {
      if (this.lengthLockedToSelection) this.length.value = this.previousRecordLength;
      this.length.disabled = false;
      this.lengthLockedToSelection = false;
    }
  }

  private clearTimer(): void { if (this.timer !== null) window.clearInterval(this.timer); this.timer = null; }

  private updateControls(gateRecording: TriggerRecording | null | undefined, pitchRecording: PitchRecording | null | undefined, source: SequenceSelection): void {
    const available = !!this.engine()?.getChannel(this.selectedId());
    this.toggle.disabled = !available || this.mode === 'starting'; this.toggle.textContent = this.mode === 'recording' ? 'End Recording' : 'Start Recording';
    this.toggle.setAttribute('aria-pressed', String(this.mode === 'recording')); this.length.disabled = this.mode !== 'idle';
    this.gate.disabled = !available || this.mode === 'starting'; this.gate.setAttribute('aria-pressed', String(this.heldOwner !== null));
    this.recordMode.disabled = this.mode !== 'idle';
    this.recordMode.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]').forEach(button => { button.disabled = this.recordMode.disabled; });
    this.gateTimeline.startHandle.disabled = this.gateTimeline.endHandle.disabled = !gateRecording || this.mode !== 'idle';
    this.pitchTimeline.startHandle.disabled = this.pitchTimeline.endHandle.disabled = !pitchRecording || this.mode !== 'idle';
    this.link.disabled = this.mode !== 'idle';
    this.lengthLock.disabled = this.mode !== 'idle';
    this.gateMute.disabled = !gateRecording || this.mode !== 'idle';
    this.pitchMute.disabled = !pitchRecording || this.mode !== 'idle';
    this.gateClear.disabled = !gateRecording || this.mode !== 'idle'; this.pitchClear.disabled = !pitchRecording || this.mode !== 'idle';
    this.gateMute.setAttribute('aria-pressed', String(available && this.engine()!.getGateMuted(this.selectedId(), source.gateUserId)));
    this.pitchMute.setAttribute('aria-pressed', String(available && this.engine()!.getPitchMuted(this.selectedId(), source.pitchUserId)));
    const settingsDisabled = !available || this.mode !== 'idle';
    for (const input of [this.pitchMode, this.pitchSteps, this.portamento, this.pitchScale, this.filterAmount, this.playSpeedInput]) input.disabled = settingsDisabled;
    this.filterWide.disabled = settingsDisabled;
    this.portamento.disabled = settingsDisabled || Number(this.pitchSteps.value) === 0;
    this.pitchInput.disabled = !available || this.mode === 'starting'; this.pitchCenter.disabled = this.pitchInput.disabled;
    this.pitchTrack.classList.toggle('disabled', this.pitchInput.disabled);
    const stopping = this.transport.isPlaying(this.selectedId()); this.play.disabled = !available || this.mode !== 'idle';
    this.play.textContent = stopping ? '■ Stop' : '▶ Play'; this.play.setAttribute('aria-pressed', String(stopping));
  }

  private renderGateTimeline(recording: TriggerRecording | null | undefined): void {
    const duration = recording?.durationSec ?? this.configuredLength(); const gates = recording?.gates ?? [];
    this.gateBars.replaceChildren(...gates.map(gate => { const bar = document.createElement('span'); bar.style.left = `${gate.onSec / duration * 100}%`; bar.style.width = `${(gate.offSec - gate.onSec) / duration * 100}%`; return bar; }));
    this.renderTimeline(this.gateTimeline, recording, duration, `${gates.length} recorded Gates`);
  }

  private renderPitchTimeline(recording: PitchRecording | null | undefined): void {
    const duration = recording?.durationSec ?? this.configuredLength(); const points = recording?.points ?? [];
    this.pitchCurve.setAttribute('points', points.map(point => `${point.timeSec / duration * 1000},${(1 - point.valueNormalized) * 50}`).join(' '));
    this.renderTimeline(this.pitchTimeline, recording, duration, `${points.length} recorded Pitch points`);
  }

  private renderTimeline(elements: ReturnType<TriggerRecorder['timelineElements']>, recording: TriggerRecording | PitchRecording | null | undefined,
    duration: number, description: string): void {
    const start = recording?.selectionStartSec ?? 0; const end = recording?.selectionEndSec ?? duration;
    elements.selection.style.left = `${start / duration * 100}%`; elements.selection.style.width = `${(end - start) / duration * 100}%`;
    elements.startHandle.style.left = `${start / duration * 100}%`; elements.endHandle.style.left = `${end / duration * 100}%`;
    elements.midpoint.textContent = `${(duration / 2).toFixed(1)} s`; elements.endpoint.textContent = `${duration.toFixed(1)} s`;
    for (const [handle, value, name] of [[elements.startHandle, start, 'Start'], [elements.endHandle, end, 'End']] as const) {
      handle.setAttribute('aria-valuemin', '0'); handle.setAttribute('aria-valuemax', String(duration)); handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', `${name} ${value.toFixed(2)} seconds`);
    }
    elements.startValue.textContent = `${start.toFixed(2)} s`; elements.endValue.textContent = `${end.toFixed(2)} s`;
    elements.durationValue.textContent = `${(end - start).toFixed(2)} s`;
    elements.timeline.setAttribute('aria-label', `${description} over ${duration.toFixed(2)} seconds; selected ${start.toFixed(2)} to ${end.toFixed(2)} seconds`);
  }

  private updateClock(): void {
    const id = this.targetId ?? this.selectedId(); const gatePosition = this.transport.position(id, 'gate'); const pitchPosition = this.transport.position(id, 'pitch');
    const position = gatePosition ?? pitchPosition; const duration = this.mode === 'recording' ? this.limitSec : position?.duration ?? this.configuredLength();
    const elapsed = this.mode === 'recording' ? this.loopRecording ? Math.max(0, this.elapsed() - this.completedLaps * this.limitSec) : Math.min(this.elapsed(), duration)
      : position?.elapsed ?? 0;
    this.counter.textContent = `${timeText(elapsed)} / ${timeText(this.mode === 'recording' ? duration : position?.period ?? duration)}${this.mode === 'recording' && this.loopRecording ? ` · Lap ${this.completedLaps + 1}` : ''}`;
    const place = (element: HTMLElement, info: ReturnType<SequenceTransport['position']>, recordingActive: boolean, lane: TimelineLane) => {
      const timelinePosition = this.mode === 'recording' && recordingActive ? this.loopRecording ? (lane === 'gate' ? this.loopStart : this.pitchLoopStart) + elapsed : elapsed
        : info ? info.start + info.elapsed : 0;
      const fullDuration = this.mode === 'recording' && recordingActive && this.loopRecording
        ? (lane === 'gate' ? this.gateWorking?.durationSec : this.pitchWorking?.durationSec) ?? duration : info?.duration ?? duration;
      element.style.left = `${Math.max(0, Math.min(100, timelinePosition / fullDuration * 100))}%`;
    };
    place(this.gateTimeline.playhead, gatePosition, this.includes('gate'), 'gate');
    place(this.pitchTimeline.playhead, pitchPosition, this.includes('pitch'), 'pitch');
  }
}
