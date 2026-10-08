import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { PitchPoint, PitchRecording, SequenceSelection, SequenceSettings, TriggerGate, TriggerRecording, UserPatternId } from '../audio/types';
import { MAX_RECORDING_SEC, normalizeTriggerRecording } from '../model/triggerRecording';
import { normalizePitchRecording, pitchPositions, quantizePitchValue, simplifyPitchPoints } from '../model/sequencePitch';
import type { PitchScaleMode } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { centerSelectedPitch, clearSelectedGates, mergeGateGesture, splicePitchRecording } from '../model/sequenceLoopRecording';
import { maxSongBars } from '../model/recordingLimits';
import { quantizeGateRecording, type GateQuantizeDenominator, type GateQuantizeMode } from '../model/quantizeGateRecording';
import type { RecordingLane, SequenceTransport } from './SequenceTransport';

type Mode = 'idle' | 'starting' | 'recording';
type SelectionEdge = 'start' | 'end';
type TimelineLane = 'gate' | 'pitch';
type WriteMode = 'replace' | 'overdub';
type SongLanePosition = (id: string, lane: TimelineLane, patternId: UserPatternId) => ReturnType<SequenceTransport['position']>;

function timeText(seconds: number): string {
  const centiseconds = Math.floor(Math.max(0, seconds) * 100);
  return `${String(Math.floor(centiseconds / 6000)).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function sourceLabel(id: UserPatternId): string { return `Pattern ${id.slice(-1)}`; }
// Negative Scale inverts the Pitch motion (higher input → lower pitch).
const SCALE_STOPS = [-2400, -1200, -600, -400, -200, 0, 200, 400, 600, 1200, 2400] as const;
const MOTION_STORAGE_KEY = 'KOROGI-Lab/sequence-slide-gate-motion-v1';
const STOP_TIME_STORAGE_KEY = 'KOROGI-Lab/sequence-slide-gate-stop-time-v1';
const QUANTIZE_STORAGE_KEY = 'KOROGI-Lab/gate-quantize-options-v1';

interface QuantizeHistory {
  id: string;
  patternId: UserPatternId;
  before: TriggerRecording;
  after: TriggerRecording;
  state: 'before' | 'after';
}

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

function setText(element: HTMLElement, text: string): void { if (element.textContent !== text) element.textContent = text; }

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
  private gatePeriodSec = this.limitSec;
  private pitchPeriodSec = this.limitSec;
  private recordClockSpeed = 1;
  private recordingLane: RecordingLane = 'gate';
  private userRecordingLane: RecordingLane = 'both';
  private linked = false;
  private lengthLocked = false;
  private loopRecording = false;
  private loopStart = 0;
  private loopEnd = 0;
  private pitchLoopStart = 0;
  private pitchLoopEnd = 0;
  private gateLaps = 0;
  private pitchLaps = 0;
  private gateTouched = false;
  private pitchTouched = false;
  private gateLapCapturing = false;
  private pitchLapCapturing = false;
  private pitchPunchStart: number | null = null;
  private pitchMonitorNeedsUpdate = false;
  private writeMode: WriteMode = 'overdub';
  private songPosition: SongLanePosition = () => null;
  private gateWasEmpty = false;
  private pitchWasEmpty = false;
  private centerHandled = false;
  private gateWorking: TriggerRecording | null = null;
  private pitchWorking: PitchRecording | null = null;
  private displayedLengthMode: 'seconds' | 'bars' = 'seconds';
  private recordingBars: number | null = null;
  private heldOwner: string | null = null;
  private heldId: string | null = null;
  private heldSynth: ChannelSynth | null = null;
  private heldActive = false;
  private heldOnSec: number | null = null;
  private pitchGesture: PitchGesture | null = null;
  private pitchRequest = 0;
  private separate = false;
  private pitchHeldId: string | null = null;
  private pitchHeldSynth: ChannelSynth | null = null;
  private motionEnabled = true;
  private motionStopMs = 150;
  private gateDraft: TriggerGate[] = [];
  private pitchDraft: PitchPoint[] = [];
  private gateEditRange: { key: string; selectionStartSec: number; selectionEndSec: number; startSec: number; endSec: number } | null = null;
  private quantizeHistory: QuantizeHistory | null = null;

  private readonly length = this.element<HTMLInputElement>('#record-length');
  private readonly lengthMode = this.element<HTMLSelectElement>('#record-length-mode');
  private readonly newLength = this.element<HTMLFieldSetElement>('#record-new-length');
  private readonly toggle = this.element<HTMLButtonElement>('#record-toggle');
  private readonly gate = this.element<HTMLButtonElement>('#record-gate');
  private readonly separateGate = this.element<HTMLButtonElement>('#sequence-separate-gate');
  private readonly separateButton = this.element<HTMLButtonElement>('#sequence-separate');
  private readonly counter = this.element<HTMLOutputElement>('#record-counter');
  private readonly recordMode = this.element<HTMLSelectElement>('#record-mode');
  private readonly writeModeInput = this.element<HTMLSelectElement>('#record-write-mode');
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
  private readonly gateApplyBars = this.element<HTMLButtonElement>('#gate-apply-bars');
  private readonly pitchApplyBars = this.element<HTMLButtonElement>('#pitch-apply-bars');
  private readonly quantizeGrid = this.element<HTMLSelectElement>('#gate-quantize-grid');
  private readonly quantizeMode = this.element<HTMLSelectElement>('#gate-quantize-mode');
  private readonly quantizeGap = this.element<HTMLSelectElement>('#gate-quantize-gap');
  private readonly quantizeButton = this.element<HTMLButtonElement>('#gate-quantize');
  private readonly quantizeUndo = this.element<HTMLButtonElement>('#gate-quantize-undo');
  private readonly quantizeRedo = this.element<HTMLButtonElement>('#gate-quantize-redo');
  private readonly editTimeline = this.element<HTMLElement>('#gate-edit-timeline');
  private readonly editSelection = this.element<HTMLElement>('#gate-edit-selection');
  private readonly editStartHandle = this.element<HTMLButtonElement>('#gate-edit-start-handle');
  private readonly editEndHandle = this.element<HTMLButtonElement>('#gate-edit-end-handle');
  private readonly editStartValue = this.element<HTMLOutputElement>('#gate-edit-start-value');
  private readonly editEndValue = this.element<HTMLOutputElement>('#gate-edit-end-value');
  private readonly scaleCustom = this.element<HTMLOutputElement>('#sequence-scale-custom');

  private readonly gateTimeline = this.timelineElements('record');
  private readonly pitchTimeline = this.timelineElements('pitch');
  private readonly gateBars = this.element<HTMLElement>('#record-gates');
  private readonly pitchCurve = this.element<SVGPolylineElement>('#pitch-curve-line');

  constructor(private readonly engine: () => AudioEngine | null, private readonly selectedId: () => string,
    private readonly ensureRunning: (forceAttempt?: boolean) => Promise<void>, private readonly prepareTarget: (id: string) => void,
    private readonly lockTarget: (id: string | null, lane: RecordingLane) => void, private readonly transport: SequenceTransport,
    private readonly beforeSongEdit: () => void, private readonly songSettingsChanged: () => void,
    private readonly songLaneMuted: (id: string, lane: TimelineLane) => void = () => {}) {
    this.length.value = String(P['record-length'].defaultValue);
    this.length.setAttribute('aria-label', `Record length in seconds, ${P['record-length'].min} to ${P['record-length'].max}`);
    this.toggle.addEventListener('click', () => { if (this.mode === 'recording') this.finishRecording(); else if (this.mode === 'idle') void this.beginRecording(); });
    this.length.addEventListener('change', () => { if (this.mode === 'idle') this.refresh(); });
    this.lengthMode.addEventListener('change', () => {
      const bpm = this.engine()?.getSongSettings().bpm ?? P['song-bpm'].defaultValue;
      const previous = Number(this.length.value);
      if (Number.isFinite(previous) && previous > 0) {
        const seconds = this.displayedLengthMode === 'bars' ? previous * 240 / bpm : previous;
        const converted = this.lengthMode.value === 'bars' ? seconds * bpm / 240 : seconds;
        const display = String(Number(converted.toFixed(6)));
        this.length.value = display;
      }
      this.displayedLengthMode = this.lengthMode.value as 'seconds' | 'bars';
      this.refresh();
    });
    this.play.addEventListener('click', () => { if (this.mode === 'idle') void this.transport.toggle(this.selectedId()); });
    this.recordMode.addEventListener('change', () => {
      this.userRecordingLane = this.recordMode.value as RecordingLane;
      this.refresh();
    });
    this.writeModeInput.addEventListener('change', () => {
      this.writeMode = this.writeModeInput.value as WriteMode;
      this.refresh();
    });
    this.link.addEventListener('click', () => {
      if (this.mode !== 'idle') return;
      this.linked = !this.linked; this.refresh();
      this.status.textContent = this.linked
        ? this.lengthLocked
          ? 'Link ON: locked intervals shift together; recording always loops independently.'
          : 'Link ON: interval edits are linked; recording always loops independently.'
        : 'Link OFF: interval edits are independent; recording loops until End.';
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
    this.gateApplyBars.addEventListener('click', () => this.applySelectionBars('gate'));
    this.pitchApplyBars.addEventListener('click', () => this.applySelectionBars('pitch'));
    const gapRange = P['gate-quantize-gap'];
    for (let ms = gapRange.min; ms <= gapRange.max; ms += gapRange.step) {
      const option = document.createElement('option'); option.value = option.textContent = String(ms);
      this.quantizeGap.append(option);
    }
    this.quantizeGap.value = String(gapRange.defaultValue);
    this.loadQuantizeOptions();
    this.quantizeGrid.addEventListener('change', () => this.saveQuantizeOptions());
    this.quantizeMode.addEventListener('change', () => this.saveQuantizeOptions());
    this.quantizeGap.addEventListener('change', () => this.saveQuantizeOptions());
    this.quantizeButton.addEventListener('click', () => this.applyGateQuantize());
    this.quantizeUndo.addEventListener('click', () => this.restoreGateQuantize('before'));
    this.quantizeRedo.addEventListener('click', () => this.restoreGateQuantize('after'));
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
      if (!this.pitchGesture) this.beginPitchControl();
      this.updateGatePosition();
      this.changePitch(Number(this.pitchInput.value));
    });
    const finishPitchInput = () => { if (!this.pitchGesture) { this.advanceLaps(); this.closePitchPunch(); this.endPitchControl(); } };
    this.pitchInput.addEventListener('change', finishPitchInput);
    this.pitchInput.addEventListener('keyup', finishPitchInput);
    this.pitchInput.addEventListener('blur', finishPitchInput);
    const centerDown = () => { this.centerHandled = true; this.beginPitchControl(); this.pitchInput.value = '0'; this.updateGatePosition(); this.changePitch(0); };
    const centerUp = () => { this.advanceLaps(); this.closePitchPunch(); this.endPitchControl(); };
    this.pitchCenter.addEventListener('pointerdown', centerDown);
    this.pitchCenter.addEventListener('pointerup', centerUp);
    this.pitchCenter.addEventListener('pointercancel', centerUp);
    this.pitchCenter.addEventListener('click', () => {
      if (this.centerHandled) { this.centerHandled = false; return; }
      centerDown(); centerUp(); this.centerHandled = false;
    });
    this.pitchCenter.addEventListener('keydown', event => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { this.pitchCenter.classList.add('is-pressed'); centerDown(); }
    });
    this.pitchCenter.addEventListener('keyup', event => {
      if (event.key === ' ' || event.key === 'Enter') { this.pitchCenter.classList.remove('is-pressed'); centerUp(); }
    });
    this.pitchCenter.addEventListener('blur', () => { this.pitchCenter.classList.remove('is-pressed'); centerUp(); });
    this.separateButton.addEventListener('click', event => {
      if (this.mode !== 'idle' || this.heldOwner || this.pitchHeldId) return;
      this.separate = !this.separate;
      this.refresh();
      // A pointer-selected mode must leave Space available for Gate performance.
      if (event.detail > 0) this.separateButton.blur();
    });
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
    this.bindEditHandle(this.editStartHandle, 'start');
    this.bindEditHandle(this.editEndHandle, 'end');
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
  private controllerPitchAllowed(): boolean { return this.mode !== 'recording' || this.includes('pitch'); }
  private controllerGateAllowed(): boolean { return this.mode !== 'recording' || this.includes('gate'); }
  private sliderGateAllowed(): boolean { return !this.separate && this.controllerGateAllowed(); }

  private beginPitchControl(): void {
    if (!this.controllerPitchAllowed() || this.pitchHeldId || this.mode === 'starting') return;
    const engine = this.engine(); const id = this.targetId ?? this.selectedId(); const synth = engine?.getChannel(id);
    if (!engine || !synth) return;
    const settings = engine.getSequenceSettings(id, this.currentSource().pitchUserId);
    const raw = Number(this.pitchInput.value);
    const value = settings.pitchMode.kind === 'stepped'
      ? quantizePitchValue(raw, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent) : raw;
    engine.setControllerPitch(id, value, settings.pitchScaleCent, settings.filterAmountCent);
    this.pitchHeldId = id; this.pitchHeldSynth = synth;
    this.pitchTrack.classList.add('pitch-held');
    engine.controllerPitchOn(id);
  }

  private endPitchControl(): void {
    const id = this.pitchHeldId, synth = this.pitchHeldSynth;
    ++this.pitchRequest;
    this.pitchHeldId = null; this.pitchHeldSynth = null;
    this.pitchTrack.classList.remove('pitch-held');
    if (id && synth && this.engine()?.getChannel(id) === synth) this.engine()!.controllerPitchOff(id);
  }
  isBusy(): boolean { return this.mode !== 'idle'; }
  lockedId(): string | null { return this.targetId; }
  discardQuantizeHistory(): void { this.quantizeHistory = null; this.gateEditRange = null; }

  /** Song supplies the cursor for the displayed Patterns while it plays them. */
  setSongPosition(source: SongLanePosition): void { this.songPosition = source; }

  refreshClock(): void {
    const id = this.targetId ?? this.selectedId();
    if (this.mode === 'recording' || this.lanePosition(id, 'gate') || this.lanePosition(id, 'pitch')) this.updateClock();
  }

  private lanePosition(id: string, lane: TimelineLane): ReturnType<SequenceTransport['position']> {
    const own = this.transport.position(id, lane);
    if (own || this.mode === 'recording') return own;
    const source = this.transport.source(id);
    return this.songPosition(id, lane, lane === 'gate' ? source.gateUserId : source.pitchUserId);
  }

  refresh(): void {
    this.updateGatePosition();
    const engine = this.engine(); const id = this.targetId ?? this.selectedId(); const source = this.currentSource();
    const maxBars = maxSongBars(engine?.getSongSettings().bpm ?? P['song-bpm'].defaultValue);
    this.length.setAttribute('aria-label', this.lengthMode.value === 'bars'
      ? `Record length in bars, 1 to ${maxBars}` : 'Record length in seconds, 1 to 300');
    const gateRecording = this.mode === 'recording' && this.includes('gate') && this.gateTouched ? this.draftGateRecording()
      : engine?.getChannel(id) ? engine.getGateRecording(id, source.gateUserId) : null;
    const pitchRecording = this.mode === 'recording' && this.includes('pitch') && this.pitchTouched ? this.draftPitchRecording()
      : engine?.getChannel(id) ? engine.getPitchRecording(id, source.pitchUserId) : null;
    this.syncGateEditRange(gateRecording, id, source.gateUserId);
    this.target.textContent = `Timbre ${id} · ${sourceLabel(source.gateUserId)} · ${gateRecording ? `${gateRecording.gates.length} Gates` : 'Null'}`;
    this.pitchTarget.textContent = `Timbre ${id} · ${sourceLabel(source.pitchUserId)} · ${pitchRecording ?
      pitchRecording.points.every(point => point.valueNormalized === pitchRecording.points[0]!.valueNormalized) ? 'Constant Pitch' : `${pitchRecording.points.length} Points` : 'Null'}`;
    this.renderGateTimeline(gateRecording); this.renderPitchTimeline(pitchRecording);
    this.syncSettings(engine?.getChannel(id) ? engine.getSequenceSettings(id, source.pitchUserId) : null);
    this.updateControls(gateRecording, pitchRecording, source); this.updateClock();
    this.link.setAttribute('aria-pressed', String(this.linked)); this.link.textContent = this.linked ? 'Link ON' : 'Link OFF';
    this.lengthLock.setAttribute('aria-pressed', String(this.lengthLocked)); this.lengthLock.textContent = this.lengthLocked ? 'Lock ON' : 'Lock OFF';
    if (this.mode === 'idle') {
      if (this.transport.isPlaying(id)) this.status.textContent = 'Loop playing';
      else if (this.status.textContent === 'Loop playing') this.status.textContent = 'Stopped';
    }
  }

  cancel(releaseTrigger = true): void {
    this.endPitchGesture(true);
    this.endPitchControl();
    ++this.request;
    if (releaseTrigger) this.endGate(this.recordPosition());
    if (this.mode === 'recording' && this.targetId) this.engine()?.cancelScheduledGates(this.targetId);
    this.clearTimer(); this.mode = 'idle'; this.targetId = null; this.targetSource = null; this.targetSynth = null;
    this.loopRecording = false; this.recordingBars = null; this.gateWorking = null; this.pitchWorking = null;
    this.lockTarget(null, 'both'); this.status.textContent = 'Stopped'; this.refresh();
  }

  stop(): void { if (this.mode === 'starting') this.cancel(false); else if (this.mode === 'recording') this.finishRecording(); }

  private async beginRecording(): Promise<void> {
    const engine = this.engine(); const id = this.selectedId(); const synth = engine?.getChannel(id); const source = this.transport.source(id);
    const lengthValue = Number(this.length.value); const range = P['record-length'];
    const barsMode = this.lengthMode.value === 'bars';
    const seconds = barsMode ? lengthValue * 240 / (engine?.getSongSettings().bpm ?? 120) : lengthValue;
    const oldGate = engine?.getChannel(id) ? engine.getGateRecording(id, source.gateUserId) : null;
    const oldPitch = engine?.getChannel(id) ? engine.getPitchRecording(id, source.pitchUserId) : null;
    const gateLength = oldGate ? oldGate.selectionEndSec - oldGate.selectionStartSec : null;
    const pitchLength = oldPitch ? oldPitch.selectionEndSec - oldPitch.selectionStartSec : null;
    const reference = oldGate ?? oldPitch;
    if (!reference && (!Number.isInteger(lengthValue) || (barsMode ? lengthValue < P['song-bars'].min || lengthValue > maxSongBars(engine?.getSongSettings().bpm ?? P['song-bpm'].defaultValue) : lengthValue < range.min || lengthValue > range.max) || seconds > MAX_RECORDING_SEC)) {
      this.status.textContent = barsMode ? `Record length: ${P['song-bars'].min}–${maxSongBars(engine?.getSongSettings().bpm ?? P['song-bpm'].defaultValue)} whole bars` : `Record length: ${range.min}–${range.max} whole seconds`; return;
    }
    if (!engine || !synth) { this.status.textContent = `Timbre ${id} is unavailable. Select a loaded Timbre.`; return; }
    this.recordingLane = this.userRecordingLane; this.endGate(0);
    this.loopRecording = true;
    this.gateWasEmpty = !oldGate; this.pitchWasEmpty = !oldPitch;
    this.writeMode = this.writeModeInput.value as WriteMode;
    this.gatePeriodSec = gateLength ?? pitchLength ?? seconds;
    this.pitchPeriodSec = pitchLength ?? gateLength ?? seconds;
    const plannedBars = this.gatePeriodSec * (engine?.getSongSettings().bpm ?? 120) / 240;
    this.recordingBars = barsMode && Math.abs(plannedBars - Math.round(plannedBars)) < 1e-6
      ? Math.round(plannedBars) : null;
    this.loopStart = oldGate?.selectionStartSec ?? 0; this.loopEnd = this.loopStart + this.gatePeriodSec;
    this.pitchLoopStart = oldPitch?.selectionStartSec ?? 0; this.pitchLoopEnd = this.pitchLoopStart + this.pitchPeriodSec;
    this.gateLaps = 0; this.pitchLaps = 0;
    const request = ++this.request;
    this.mode = 'starting'; this.targetId = id; this.targetSource = source; this.targetSynth = synth;
    this.limitSec = Math.max(this.gatePeriodSec, this.pitchPeriodSec);
    this.recordClockSpeed = source.playSpeed;
    this.lockTarget(id, this.recordingLane); this.updateControls(null, null, source);
    this.status.textContent = `Starting Timbre ${id} · ${this.recordingLane} · Loop · ${this.writeMode} · Gate ${sourceLabel(source.gateUserId)}, Pitch ${sourceLabel(source.pitchUserId)}…`;
    try { await this.ensureRunning(); } catch (error) {
      if (this.request === request) { this.cancel(); this.status.textContent = `Recording could not start audio: ${error instanceof Error ? error.message : String(error)}. Try Start Recording again.`; }
      return;
    }
    if (request !== this.request || this.engine()?.getChannel(id) !== synth) { if (request === this.request) this.cancel(); return; }
    this.prepareTarget(id); this.mode = 'recording'; this.startedAt = engine.context.currentTime + .03;
    this.gateDraft = []; this.pitchDraft = []; this.gateTouched = false; this.pitchTouched = false;
    this.gateLapCapturing = false; this.pitchLapCapturing = false;
    this.pitchPunchStart = null; this.pitchMonitorNeedsUpdate = false;
    this.heldOwner = null; this.heldId = null; this.heldSynth = null; this.heldActive = false; this.heldOnSec = null;
    this.gateWorking = oldGate ?? { durationSec: this.loopEnd, selectionStartSec: this.loopStart,
      selectionEndSec: this.loopEnd, gates: [] };
    this.pitchWorking = oldPitch ?? { durationSec: this.pitchLoopEnd, selectionStartSec: this.pitchLoopStart,
      selectionEndSec: this.pitchLoopEnd, points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: this.pitchLoopEnd, valueNormalized: 0 }] };
    this.transport.playRetained(id, source.playSpeed, true, true, this.startedAt);
    this.timer = window.setInterval(() => {
      if (this.mode !== 'recording') return;
      if (this.engine()?.context.state !== 'running') { this.finishRecording(); return; }
      this.advanceLaps();
      this.updateClock();
      if (this.heldOnSec !== null) this.renderGateTimeline(this.draftGateRecording());
      if (this.pitchPunchStart !== null) this.renderPitchTimeline(this.draftPitchRecording());
    }, 25);
    this.updateRecordingStatus();
    this.refresh();
  }

  private elapsed(): number { return Math.max(0, (this.engine()?.context.currentTime ?? this.startedAt) - this.startedAt) * this.recordClockSpeed; }
  private recordPosition(lane: TimelineLane = 'gate'): number {
    const start = lane === 'gate' ? this.loopStart : this.pitchLoopStart;
    const period = lane === 'gate' ? this.gatePeriodSec : this.pitchPeriodSec;
    const laps = lane === 'gate' ? this.gateLaps : this.pitchLaps;
    return start + Math.max(0, Math.min(period, this.elapsed() - laps * period));
  }

  private updateRecordingStatus(): void {
    if (this.mode !== 'recording') return;
    if (this.writeMode === 'overdub') {
      const message = 'Recording · Loop · Overdub · correcting selected passages';
      if (this.status.textContent !== message) this.status.textContent = message;
      return;
    }
    const laneStatus = (lane: TimelineLane) => `${lane === 'gate' ? 'Gate' : 'Pitch'}: ${(lane === 'gate' ? this.gateLapCapturing : this.pitchLapCapturing)
      ? 'recording new take' : 'listening to old recording'}`;
    const message = `Recording · Loop · Replace · ${(['gate', 'pitch'] as const).filter(lane => this.includes(lane)).map(laneStatus).join(' · ')}`;
    if (this.status.textContent !== message) this.status.textContent = message;
  }
  private configuredLength(): number {
    const value = Number(this.length.value); const range = P['record-length'];
    if (this.lengthMode.value === 'bars') return Number.isFinite(value) && value > 0 && value <= maxSongBars(this.engine()?.getSongSettings().bpm ?? 120)
      ? value * 240 / (this.engine()?.getSongSettings().bpm ?? 120) : this.limitSec;
    return Number.isFinite(value) && value > 0 && value <= range.max ? value : this.limitSec;
  }

  releaseScreenTrigger(): void {
    this.endPitchGesture(true);
    this.endPitchControl();
    if (this.heldOwner && this.heldOwner !== 'document-space') this.release(this.heldOwner);
  }

  releaseSource(id: string): void {
    if (this.pitchGesture?.id === id) this.endPitchGesture(true);
    if (this.pitchHeldId === id) this.endPitchControl();
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

  private loadQuantizeOptions(): void {
    try {
      const raw = localStorage.getItem(QUANTIZE_STORAGE_KEY);
      if (!raw) return;
      const options = JSON.parse(raw) as { denominator?: number; mode?: string; gapMs?: number };
      if ([4, 8, 16, 32].includes(options.denominator ?? 0)) this.quantizeGrid.value = String(options.denominator);
      if (options.mode === 'on' || options.mode === 'on-off') this.quantizeMode.value = options.mode;
      const gapRange = P['gate-quantize-gap'];
      if (Number.isInteger(options.gapMs) && options.gapMs! >= gapRange.min && options.gapMs! <= gapRange.max) this.quantizeGap.value = String(options.gapMs);
    } catch { /* Editor preferences are optional. */ }
  }

  private saveQuantizeOptions(): void {
    try {
      localStorage.setItem(QUANTIZE_STORAGE_KEY, JSON.stringify({ denominator: Number(this.quantizeGrid.value),
        mode: this.quantizeMode.value, gapMs: Number(this.quantizeGap.value) }));
    } catch { /* The controls still work for this page. */ }
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

  private startGateInput(): void {
    if (this.writeMode !== 'replace' || this.gateLapCapturing || !this.gateWorking) return;
    this.gateWorking = clearSelectedGates(this.gateWorking);
    this.gateDraft = [];
    this.gateLapCapturing = true;
    this.transport.suppressGateMonitor(this.targetId!);
    this.updateRecordingStatus();
    this.renderGateTimeline(this.draftGateRecording());
  }

  private startPitchInput(): void {
    if (this.writeMode !== 'replace' || this.pitchLapCapturing || !this.pitchWorking) return;
    this.pitchWorking = centerSelectedPitch(this.pitchWorking);
    this.pitchLapCapturing = true;
    this.updateRecordingStatus();
  }

  private recordPitchReturn(valueBefore: number, valueAfter: number): void {
    if (this.mode !== 'recording' || !this.includes('pitch')) return;
    if (this.loopRecording) this.advanceLaps();
    this.startPitchInput();
    const position = this.recordPosition('pitch');
    const previousTime = this.pitchDraft.at(-1)?.timeSec ?? -Infinity;
    const before = Math.max(previousTime, position - .001);
    this.pitchTouched = true;
    if (this.pitchPunchStart === null) { this.pitchPunchStart = before; this.transport.beginPitchPunch(this.targetId!); }
    this.appendPitchPoint(before, this.effectivePitchValue(valueBefore));
    this.appendPitchPoint(position, this.effectivePitchValue(valueAfter));
    this.renderPitchTimeline(this.draftPitchRecording());
  }

  private endPitchGesture(canceled: boolean): void {
    const gesture = this.pitchGesture;
    if (!gesture) return;
    this.advanceLaps();
    const shouldReturn = canceled || this.motionEnabled && gesture.lastMovedAt !== null
      && performance.now() - gesture.lastMovedAt < this.motionStopMs;
    if (shouldReturn && Number(this.pitchInput.value) !== gesture.startValue) {
      this.recordPitchReturn(Number(this.pitchInput.value), gesture.startValue);
      this.pitchInput.value = String(gesture.startValue);
      this.updateGatePosition();
      this.changePitch(gesture.startValue, false);
    }
    this.closePitchPunch();
    this.pitchGesture = null;
    if (gesture.ownsGate) this.release(gesture.owner);
    this.endPitchControl();
    if (this.pitchTrack.hasPointerCapture(gesture.pointerId)) this.pitchTrack.releasePointerCapture(gesture.pointerId);
  }

  private bindTrigger(): void {
    this.separateGate.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.separateGate.disabled) return;
      event.preventDefault();
      this.separateGate.setPointerCapture(event.pointerId);
      this.press(`separate:${event.pointerId}`);
    });
    const releaseSeparate = (event: PointerEvent) => {
      this.release(`separate:${event.pointerId}`);
      if (this.separateGate.hasPointerCapture(event.pointerId)) this.separateGate.releasePointerCapture(event.pointerId);
    };
    this.separateGate.addEventListener('pointerup', releaseSeparate);
    this.separateGate.addEventListener('pointercancel', releaseSeparate);
    this.separateGate.addEventListener('lostpointercapture', releaseSeparate);
    this.separateGate.addEventListener('keydown', event => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); this.press('separate-keyboard'); }
    });
    this.separateGate.addEventListener('keyup', event => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.release('separate-keyboard'); }
    });
    this.separateGate.addEventListener('blur', () => this.release('separate-keyboard'));
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
      this.beginPitchControl();
      if (!onThumb) this.moveGesturePitch(event.clientX);
      // A tap is an interval even when the slider value did not change.
      if (this.mode === 'recording' && this.includes('pitch') && onThumb) this.changePitch(Number(this.pitchInput.value));
      if (this.mode === 'recording' && this.includes('pitch') && !onThumb && this.pitchPunchStart === null)
        this.changePitch(Number(this.pitchInput.value));
      if (this.sliderGateAllowed()) gesture.ownsGate = this.press(gesture.owner);
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
    this.gate.addEventListener('keydown', event => { if (this.sliderGateAllowed() && (event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); this.press('button-keyboard'); } });
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
    return !!element?.closest('input, select, textarea, button, summary, [contenteditable="true"]');
  }

  private press(owner: string): boolean {
    if (this.mode === 'starting' || this.heldOwner || !this.controllerGateAllowed()) return false;
    if (this.mode === 'recording') this.advanceLaps();
    const id = this.targetId ?? this.selectedId(); const engine = this.engine(); const synth = engine?.getChannel(id);
    if (!engine || !synth) return false;
    const mode = this.mode; this.heldOwner = owner; this.heldId = id; this.heldSynth = synth;
    const start = () => {
      if (this.heldOwner !== owner || this.heldSynth !== synth || this.mode !== mode || this.engine()?.getChannel(id) !== synth) return;
      if (mode === 'recording' && this.includes('gate')) this.startGateInput();
      engine.controllerGateOn(id); this.heldActive = true;
      if (mode === 'recording' && this.includes('gate')) {
        this.heldOnSec = this.recordPosition('gate'); this.gateTouched = true;
      }
      this.gate.setAttribute('aria-pressed', String(!this.separate));
      this.separateGate.setAttribute('aria-pressed', String(this.separate));
      if (mode === 'recording' && this.includes('gate')) this.renderGateTimeline(this.draftGateRecording());
    };
    if (engine.context.state === 'running') start(); else void this.ensureRunning().then(start).catch(() => this.release(owner));
    return true;
  }

  private release(owner: string): void {
    if (this.heldOwner !== owner) return;
    if (this.mode === 'recording') this.advanceLaps();
    this.endGate(this.recordPosition());
    if (this.mode === 'recording' && this.includes('gate')) this.renderGateTimeline(this.draftGateRecording());
  }

  private endGate(offSec: number): void {
    if (this.heldActive && this.heldId && this.engine()?.getChannel(this.heldId) === this.heldSynth) this.engine()!.controllerGateOff(this.heldId);
    if (this.includes('gate') && this.heldOnSec !== null && offSec > this.heldOnSec) this.gateDraft.push({ onSec: this.heldOnSec, offSec });
    this.heldOwner = null; this.heldId = null; this.heldSynth = null; this.heldActive = false; this.heldOnSec = null;
    this.gate.setAttribute('aria-pressed', 'false');
    this.separateGate.setAttribute('aria-pressed', 'false');
  }

  private changePitch(rawValue: number, record = true): void {
    if (this.mode === 'recording') this.advanceLaps();
    const value = Math.max(-1, Math.min(1, rawValue)); const engine = this.engine();
    const id = this.pitchGesture?.id ?? this.targetId ?? this.selectedId();
    const source = this.pitchGesture?.source ?? this.currentSource();
    if (this.pitchGesture && engine?.getChannel(id) !== this.pitchGesture.synth) return;
    const settings = engine?.getChannel(id) ? engine.getSequenceSettings(id, source.pitchUserId) : null;
    const effective = settings?.pitchMode.kind === 'stepped'
      ? quantizePitchValue(value, settings.pitchMode.stepsPerSide, settings.pitchMode.scale, settings.pitchScaleCent) : value;
    this.pitchReadout.textContent = `${Math.round(effective * (settings?.pitchScaleCent ?? P['sequence-pitch-scale'].defaultValue))} cent`;
    if (record && this.mode === 'recording' && this.includes('pitch')) {
      this.startPitchInput();
      const position = this.recordPosition('pitch'); this.pitchTouched = true;
      if (this.pitchPunchStart === null) {
        this.pitchPunchStart = position; this.pitchDraft = [{ timeSec: position, valueNormalized: effective }];
        this.transport.beginPitchPunch(id);
      } else this.appendPitchPoint(position, effective);
    }
    if (!engine?.getChannel(id) || !settings || this.pitchHeldId !== id || !this.controllerPitchAllowed()) return;
    const synth = engine.getChannel(id);
    const request = ++this.pitchRequest;
    const apply = () => {
      if (request !== this.pitchRequest || engine.getChannel(id) !== synth || this.pitchHeldId !== id) return;
      engine.setControllerPitch(id, effective, settings.pitchScaleCent, settings.filterAmountCent, engine.context.currentTime,
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
    this.writeModeInput.value = this.writeMode; this.syncSegmented(this.writeModeInput);
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
    if (!this.loopRecording || this.mode !== 'recording') return;
    const elapsed = this.elapsed();
    while (elapsed >= (this.gateLaps + 1) * this.gatePeriodSec) {
      if (this.includes('gate') && this.gateWorking) {
        if (this.heldOnSec !== null && this.loopEnd > this.heldOnSec) {
          this.gateDraft.push({ onSec: this.heldOnSec, offSec: this.loopEnd });
          this.heldOnSec = this.loopStart;
        }
        const completed = this.gateDraft.length > 0;
        if (completed) {
          this.commitGateDraft();
        }
        if (this.gateLapCapturing || completed)
          this.transport.setGateMonitorRecording(this.targetId!, this.gateWorking,
            this.startedAt + (this.gateLaps + 1) * this.gatePeriodSec / this.recordClockSpeed);
      }
      ++this.gateLaps;
      this.gateLapCapturing = false;
      if (this.includes('gate') && this.heldOnSec !== null) this.startGateInput();
    }
    while (elapsed >= (this.pitchLaps + 1) * this.pitchPeriodSec) {
      if (this.includes('pitch') && this.pitchWorking && this.pitchPunchStart !== null) {
        const value = this.effectivePitchValue(Number(this.pitchInput.value));
        this.closePitchPunch(this.pitchLoopEnd, false);
        this.transport.setPitchMonitorRecording(this.targetId!, this.pitchWorking,
          this.startedAt + (this.pitchLaps + 1) * this.pitchPeriodSec / this.recordClockSpeed);
        this.pitchPunchStart = this.pitchLoopStart;
        this.pitchDraft = [{ timeSec: this.pitchLoopStart, valueNormalized: value }];
      }
      if (this.includes('pitch') && this.pitchWorking && this.pitchMonitorNeedsUpdate) {
        this.transport.setPitchMonitorRecording(this.targetId!, this.pitchWorking,
          this.startedAt + (this.pitchLaps + 1) * this.pitchPeriodSec / this.recordClockSpeed);
        this.pitchMonitorNeedsUpdate = false;
      }
      ++this.pitchLaps;
      this.pitchLapCapturing = false;
      if (this.includes('pitch') && this.pitchPunchStart !== null) this.startPitchInput();
    }
    this.updateRecordingStatus();
  }

  private commitGateDraft(): void {
    if (!this.gateWorking) return;
    for (const gate of this.gateDraft) this.gateWorking = mergeGateGesture(this.gateWorking, gate, this.writeMode);
    this.gateDraft = [];
  }

  private closePitchPunch(end = this.recordPosition('pitch'), resumeMonitor = true): void {
    if (this.pitchPunchStart === null || !this.pitchWorking) return;
    const stop = Math.min(this.pitchLoopEnd, Math.max(this.pitchPunchStart + .000001, end));
    const value = this.pitchDraft.at(-1)?.valueNormalized ?? this.effectivePitchValue(Number(this.pitchInput.value));
    const points = [...this.pitchDraft];
    if (points.at(-1)?.timeSec !== stop) points.push({ timeSec: stop, valueNormalized: value });
    this.pitchWorking = splicePitchRecording(this.pitchWorking, this.pitchPunchStart, stop, points);
    this.pitchPunchStart = null; this.pitchDraft = [];
    this.pitchMonitorNeedsUpdate = true;
    if (resumeMonitor && this.targetId) this.transport.endPitchPunch(this.targetId, this.pitchWorking, stop);
    this.renderPitchTimeline(this.pitchWorking);
  }

  private draftGateRecording(): TriggerRecording {
    let recording = this.gateWorking!;
    for (const gate of this.gateDraft) recording = mergeGateGesture(recording, gate, this.writeMode);
    const end = Math.min(this.loopEnd, this.recordPosition());
    if (this.heldOnSec !== null && end > this.heldOnSec)
      recording = mergeGateGesture(recording, { onSec: this.heldOnSec, offSec: end }, this.writeMode);
    return recording;
  }

  private draftPitchRecording(): PitchRecording {
    if (!this.pitchWorking || this.pitchPunchStart === null) return this.pitchWorking!;
    const end = Math.min(this.pitchLoopEnd, Math.max(this.pitchPunchStart + .000001, this.recordPosition('pitch')));
    const points = [...this.pitchDraft]; const value = this.effectivePitchValue(Number(this.pitchInput.value));
    if (points.at(-1)?.timeSec !== end) points.push({ timeSec: end, valueNormalized: value });
    return splicePitchRecording(this.pitchWorking, this.pitchPunchStart, end, points);
  }

  private finishRecording(): void {
    if (this.mode !== 'recording') return;
    this.advanceLaps();
    this.endPitchGesture(false);
    this.closePitchPunch();
    this.endPitchControl();
    this.endGate(this.recordPosition()); this.clearTimer();
    this.commitGateDraft();
    const id = this.targetId!; const source = this.targetSource!;
    let saveError: string | null = null;
    if (this.engine()?.getChannel(id) === this.targetSynth) {
      try {
        const gate = this.includes('gate') && this.gateTouched ? normalizeTriggerRecording(this.gateWorking) : null;
        const pitch = this.includes('pitch') && this.pitchTouched ? this.draftPitchRecording() : null;
        if (pitch) pitch.points = simplifyPitchPoints(pitch.points);
        const validPitch = pitch ? normalizePitchRecording(pitch) : null;
        if (gate) this.engine()!.setGateRecording(id, source.gateUserId, gate);
        if (validPitch) this.engine()!.setPitchRecording(id, source.pitchUserId, validPitch);
        if (gate) this.engine()!.setSequenceSelection(id, { gateMode: 'user' });
        if (this.recordingBars !== null && ((gate && this.gateWasEmpty) || (validPitch && this.pitchWasEmpty))) {
          const settings = this.engine()!.getSongSettings();
          if (gate && this.gateWasEmpty) settings.bars[Number(source.gateUserId.slice(-1)) - 1] = this.recordingBars;
          if (validPitch && this.pitchWasEmpty) settings.bars[Number(source.pitchUserId.slice(-1)) - 1] = this.recordingBars;
          this.engine()!.setSongSettings(settings);
          this.songSettingsChanged();
        }
      } catch (error) { saveError = error instanceof Error ? error.message : String(error); }
    }
    this.mode = 'idle'; this.targetId = null; this.targetSource = null; this.targetSynth = null;
    this.loopRecording = false; this.recordingBars = null; this.gateWorking = null; this.pitchWorking = null;
    this.lockTarget(null, 'both'); this.status.textContent = saveError ? `Recording could not be saved: ${saveError}` : this.gateTouched || this.pitchTouched
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

  private bindEditHandle(handle: HTMLButtonElement, edge: SelectionEdge): void {
    const move = (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const rect = this.editTimeline.getBoundingClientRect();
      this.changeGateEditRange(edge, (event.clientX - rect.left) / rect.width);
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
      const id = this.selectedId();
      const duration = this.engine()?.getGateRecording(id, this.transport.source(id).gateUserId)?.durationSec ?? 0;
      const current = Number(handle.getAttribute('aria-valuenow')) || 0;
      const value = event.key === 'Home' ? this.gateEditRange?.selectionStartSec ?? 0
        : event.key === 'End' ? this.gateEditRange?.selectionEndSec ?? duration
          : current + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? .1 : .01);
      this.changeGateEditRange(edge, duration ? value / duration : 0);
    });
  }

  private syncGateEditRange(recording: TriggerRecording | null, id: string, patternId: UserPatternId): void {
    if (!recording) { this.gateEditRange = null; return; }
    const key = `${id}:${patternId}`;
    if (!this.gateEditRange || this.gateEditRange.key !== key ||
      this.gateEditRange.selectionStartSec !== recording.selectionStartSec ||
      this.gateEditRange.selectionEndSec !== recording.selectionEndSec) {
      this.gateEditRange = { key, selectionStartSec: recording.selectionStartSec, selectionEndSec: recording.selectionEndSec,
        startSec: recording.selectionStartSec, endSec: recording.selectionEndSec };
    }
  }

  private changeGateEditRange(edge: SelectionEdge, ratio: number): void {
    if (this.mode !== 'idle' || this.engine()?.getSongSettings().timingMode !== 'bars' || !this.gateEditRange) return;
    const range = this.gateEditRange;
    const recording = this.engine()?.getGateRecording(this.selectedId(), this.transport.source(this.selectedId()).gateUserId);
    if (!recording) return;
    const value = Math.max(range.selectionStartSec, Math.min(range.selectionEndSec, ratio * recording.durationSec));
    if (edge === 'start') range.startSec = Math.min(value, range.endSec - .001);
    else range.endSec = Math.max(value, range.startSec + .001);
    this.renderGateEditRange(recording);
  }

  private applyGateQuantize(): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(); const id = this.selectedId(); const source = this.transport.source(id);
    if (!engine?.getChannel(id) || engine.getSongSettings().timingMode !== 'bars' || !this.gateEditRange) return;
    const recording = engine.getGateRecording(id, source.gateUserId);
    if (!recording) return;
    const bars = engine.getSongSettings().bars[Number(source.gateUserId.slice(-1)) - 1]!;
    const result = quantizeGateRecording(recording, { bars, denominator: Number(this.quantizeGrid.value) as GateQuantizeDenominator,
      mode: this.quantizeMode.value as GateQuantizeMode, gapSec: Number(this.quantizeGap.value) / 1000,
      editStartSec: this.gateEditRange.startSec, editEndSec: this.gateEditRange.endSec });
    if (!result.changedGates && !result.deletedGates) { this.status.textContent = 'Quantize: no Gate times changed.'; return; }
    this.beforeSongEdit();
    engine.setGateRecording(id, source.gateUserId, result.recording);
    this.transport.gateRecordingChanged(id, source.gateUserId);
    this.quantizeHistory = { id, patternId: source.gateUserId, before: recording, after: result.recording, state: 'after' };
    this.refresh();
    this.status.textContent = `Quantized ${result.changedGates} Gates; deleted ${result.deletedGates}.`;
  }

  private restoreGateQuantize(target: 'before' | 'after'): void {
    if (this.mode !== 'idle') return;
    const history = this.quantizeHistory; const engine = this.engine(); const id = this.selectedId();
    if (!history || !engine?.getChannel(id) || engine.getSongSettings().timingMode !== 'bars' ||
      history.id !== id || history.patternId !== this.transport.source(id).gateUserId || history.state === target) return;
    const expected = history.state === 'after' ? history.after : history.before;
    if (JSON.stringify(engine.getGateRecording(id, history.patternId)) !== JSON.stringify(expected)) {
      this.quantizeHistory = null; this.refresh(); this.status.textContent = 'Quantize history expired after another Gate edit.'; return;
    }
    this.beforeSongEdit();
    engine.setGateRecording(id, history.patternId, target === 'before' ? history.before : history.after);
    this.transport.gateRecordingChanged(id, history.patternId);
    history.state = target; this.refresh();
    this.status.textContent = target === 'before' ? 'Gate quantize undone.' : 'Gate quantize redone.';
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
    this.beforeSongEdit();
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

  private applySelectionBars(lane: TimelineLane): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(); const id = this.selectedId();
    if (!engine?.getChannel(id)) return;
    if (engine.getSongSettings().timingMode !== 'bars') return;
    const source = this.transport.source(id);
    const patternId = lane === 'gate' ? source.gateUserId : source.pitchUserId;
    const gate = engine.getGateRecording(id, source.gateUserId);
    const pitch = engine.getPitchRecording(id, source.pitchUserId);
    const active = lane === 'gate' ? gate : pitch;
    if (!active) return;
    const settings = engine.getSongSettings();
    const bars = settings.bars[Number(patternId.slice(-1)) - 1]!;
    const seconds = bars * 240 / settings.bpm;
    const intervals = this.linked && gate && pitch ? [gate, pitch] : [active];
    const exceeded = intervals.find(item => item.selectionStartSec + seconds > item.durationSec + 1e-9);
    if (exceeded) {
      this.status.textContent = `${bars} Fit to Bars (${seconds.toFixed(2)} s) exceeds the ${exceeded === gate ? 'Gate' : 'Pitch'} recording. Move the start earlier or choose fewer Bars.`;
      return;
    }
    this.beforeSongEdit();
    for (const item of intervals) item.selectionEndSec = Math.min(item.durationSec, item.selectionStartSec + seconds);
    if (lane === 'gate' || intervals.length === 2) {
      engine.setGateRecording(id, source.gateUserId, gate!);
      this.transport.gateRecordingChanged(id, source.gateUserId);
    }
    if (lane === 'pitch' || intervals.length === 2) {
      engine.setPitchRecording(id, source.pitchUserId, pitch!);
      this.transport.pitchRecordingChanged(id, source.pitchUserId);
    }
    this.status.textContent = `${bars} Fit to Bars applied to ${this.linked && intervals.length === 2 ? 'Gate and Pitch' : lane}.`;
    this.refresh();
  }

  private changeMute(lane: TimelineLane): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(), id = this.selectedId(); if (!engine?.getChannel(id)) return;
    const source = this.transport.source(id);
    // Mute applies live to Play, Play All and Song; it never stops a transport.
    if (lane === 'gate') {
      if (!engine.getGateRecording(id, source.gateUserId)) return;
      engine.setGateMuted(id, source.gateUserId, !engine.getGateMuted(id, source.gateUserId));
    } else {
      if (!engine.getPitchRecording(id, source.pitchUserId)) return;
      engine.setPitchMuted(id, source.pitchUserId, !engine.getPitchMuted(id, source.pitchUserId));
    }
    this.transport.laneMutedChanged(id, lane); this.songLaneMuted(id, lane); this.refresh();
  }

  private clearRecording(lane: TimelineLane): void {
    if (this.mode !== 'idle') return;
    const engine = this.engine(), id = this.selectedId(); if (!engine?.getChannel(id)) return;
    const source = this.transport.source(id), patternId = lane === 'gate' ? source.gateUserId : source.pitchUserId;
    const recording = lane === 'gate' ? engine.getGateRecording(id, patternId) : engine.getPitchRecording(id, patternId);
    if (!recording || !window.confirm(`Clear Timbre ${id} ${lane === 'gate' ? 'Gate' : 'Pitch'} ${sourceLabel(patternId)}?`)) return;
    this.beforeSongEdit();
    if (lane === 'gate') { engine.setGateRecording(id, patternId, null); engine.setGateMuted(id, patternId, false); this.transport.laneCleared(id, 'gate'); }
    else { engine.setPitchRecording(id, patternId, null); engine.setPitchMuted(id, patternId, false); this.transport.laneCleared(id, 'pitch'); }
    this.refresh();
  }

  private clearTimer(): void { if (this.timer !== null) window.clearInterval(this.timer); this.timer = null; }

  private updateControls(gateRecording: TriggerRecording | null | undefined, pitchRecording: PitchRecording | null | undefined, source: SequenceSelection): void {
    const available = !!this.engine()?.getChannel(this.selectedId());
    this.toggle.disabled = !available || this.mode === 'starting';
    const recordLabel = this.mode === 'recording' ? 'End Recording' : 'Start Recording';
    // Replacing an unchanged label during a press makes Chrome drop the click.
    setText(this.toggle, this.mode === 'recording' ? '■' : '●');
    this.toggle.setAttribute('aria-label', recordLabel); this.toggle.title = recordLabel;
    this.toggle.setAttribute('aria-pressed', String(this.mode === 'recording'));
    // New Pattern Length applies only to a Null Gate and Null Pitch; recorded Patterns keep their own length.
    this.newLength.disabled = this.mode !== 'idle' || !!gateRecording || !!pitchRecording;
    this.length.disabled = this.newLength.disabled;
    this.gate.disabled = !available || this.mode === 'starting';
    const pitchOnlyThumb = this.separate || this.mode === 'recording' && !this.includes('gate');
    this.pitchTrack.classList.toggle('pitch-only', pitchOnlyThumb);
    this.gate.tabIndex = pitchOnlyThumb ? -1 : 0;
    this.gate.setAttribute('aria-hidden', String(pitchOnlyThumb));
    this.gate.setAttribute('aria-pressed', String(!pitchOnlyThumb && this.heldOwner !== null));
    this.separateGate.disabled = !available || this.mode === 'starting' || !this.separate || !this.controllerGateAllowed();
    this.separateGate.setAttribute('aria-pressed', String(this.separate && this.heldOwner !== null));
    this.separateButton.disabled = !available || this.mode !== 'idle';
    this.separateButton.setAttribute('aria-pressed', String(this.separate));
    this.recordMode.disabled = this.mode !== 'idle';
    this.writeModeInput.disabled = this.mode !== 'idle';
    this.lengthMode.disabled = this.mode !== 'idle';
    this.recordMode.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]').forEach(button => { button.disabled = this.recordMode.disabled; });
    this.writeModeInput.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]').forEach(button => { button.disabled = this.writeModeInput.disabled; });
    this.gateTimeline.startHandle.disabled = this.gateTimeline.endHandle.disabled = !gateRecording || this.mode !== 'idle';
    this.pitchTimeline.startHandle.disabled = this.pitchTimeline.endHandle.disabled = !pitchRecording || this.mode !== 'idle';
    this.link.disabled = this.mode !== 'idle';
    this.lengthLock.disabled = this.mode !== 'idle';
    this.gateMute.disabled = !gateRecording || this.mode !== 'idle';
    this.pitchMute.disabled = !pitchRecording || this.mode !== 'idle';
    this.gateClear.disabled = !gateRecording || this.mode !== 'idle'; this.pitchClear.disabled = !pitchRecording || this.mode !== 'idle';
    const barsMode = this.engine()?.getSongSettings().timingMode === 'bars';
    this.gateApplyBars.disabled = !barsMode || !gateRecording || this.mode !== 'idle';
    this.pitchApplyBars.disabled = !barsMode || !pitchRecording || this.mode !== 'idle';
    const quantizeEnabled = barsMode && !!gateRecording && this.mode === 'idle';
    for (const control of [this.quantizeGrid, this.quantizeMode, this.quantizeGap, this.quantizeButton,
      this.editStartHandle, this.editEndHandle]) control.disabled = !quantizeEnabled;
    const history = this.quantizeHistory;
    if (history && history.id === this.selectedId() && history.patternId === source.gateUserId &&
      JSON.stringify(gateRecording) !== JSON.stringify(history.state === 'after' ? history.after : history.before)) this.quantizeHistory = null;
    const activeHistory = this.quantizeHistory;
    const sameTarget = activeHistory?.id === this.selectedId() && activeHistory.patternId === source.gateUserId;
    this.quantizeUndo.disabled = !quantizeEnabled || !sameTarget || activeHistory?.state !== 'after';
    this.quantizeRedo.disabled = !quantizeEnabled || !sameTarget || activeHistory?.state !== 'before';
    this.gateMute.setAttribute('aria-pressed', String(available && this.engine()!.getGateMuted(this.selectedId(), source.gateUserId)));
    this.pitchMute.setAttribute('aria-pressed', String(available && this.engine()!.getPitchMuted(this.selectedId(), source.pitchUserId)));
    const settingsDisabled = !available || this.mode !== 'idle';
    for (const input of [this.pitchMode, this.pitchSteps, this.portamento, this.pitchScale, this.filterAmount, this.playSpeedInput]) input.disabled = settingsDisabled;
    this.filterWide.disabled = settingsDisabled;
    this.portamento.disabled = settingsDisabled || Number(this.pitchSteps.value) === 0;
    this.pitchInput.disabled = !available || this.mode === 'starting' || this.mode === 'recording' && this.separate && !this.includes('pitch');
    this.pitchCenter.disabled = this.pitchInput.disabled;
    this.pitchTrack.classList.toggle('disabled', this.pitchInput.disabled);
    const stopping = this.transport.isPlaying(this.selectedId()); this.play.disabled = !available || this.mode !== 'idle';
    setText(this.play, stopping ? '■' : '▶'); this.play.setAttribute('aria-pressed', String(stopping));
    this.play.setAttribute('aria-label', stopping ? 'Stop' : 'Play'); this.play.title = stopping ? 'Stop' : 'Play';
  }

  private renderGateTimeline(recording: TriggerRecording | null | undefined): void {
    const duration = recording?.durationSec ?? this.configuredLength(); const gates = recording?.gates ?? [];
    this.gateBars.replaceChildren(...gates.map(gate => { const bar = document.createElement('span'); bar.style.left = `${gate.onSec / duration * 100}%`; bar.style.width = `${(gate.offSec - gate.onSec) / duration * 100}%`; return bar; }));
    this.renderTimeline(this.gateTimeline, recording, duration, `${gates.length} recorded Gates`);
    this.renderGateEditRange(recording ?? null);
  }

  private renderGateEditRange(recording: TriggerRecording | null): void {
    const duration = recording?.durationSec ?? this.configuredLength();
    const range = this.gateEditRange;
    const start = range?.startSec ?? 0; const end = range?.endSec ?? duration;
    this.editSelection.style.left = `${start / duration * 100}%`;
    this.editSelection.style.width = `${(end - start) / duration * 100}%`;
    this.editStartHandle.style.left = `${start / duration * 100}%`;
    this.editEndHandle.style.left = `${end / duration * 100}%`;
    this.editStartValue.textContent = `${start.toFixed(2)} s`;
    this.editEndValue.textContent = `${end.toFixed(2)} s`;
    for (const [handle, value, name] of [[this.editStartHandle, start, 'start'], [this.editEndHandle, end, 'end']] as const) {
      handle.setAttribute('aria-valuemin', String(name === 'start' ? range?.selectionStartSec ?? 0 : start + .001));
      handle.setAttribute('aria-valuemax', String(name === 'start' ? end - .001 : range?.selectionEndSec ?? duration));
      handle.setAttribute('aria-valuenow', String(value));
      handle.setAttribute('aria-valuetext', `Quantize range ${name} ${value.toFixed(2)} seconds`);
    }
    this.editTimeline.setAttribute('aria-label', `Gate quantize range ${start.toFixed(2)} to ${end.toFixed(2)} seconds`);
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
    const id = this.targetId ?? this.selectedId(); const gatePosition = this.lanePosition(id, 'gate'); const pitchPosition = this.lanePosition(id, 'pitch');
    const position = gatePosition ?? pitchPosition;
    const source = this.transport.source(id), engine = this.engine();
    const gateRecording = engine?.getChannel(id) ? engine.getGateRecording(id, source.gateUserId) : null;
    const pitchRecording = engine?.getChannel(id) ? engine.getPitchRecording(id, source.pitchUserId) : null;
    const selectedDuration = gateRecording
      ? gateRecording.selectionEndSec - gateRecording.selectionStartSec
      : pitchRecording ? pitchRecording.selectionEndSec - pitchRecording.selectionStartSec : null;
    const duration = position?.duration ?? selectedDuration ?? this.configuredLength();
    const laneText = (lane: TimelineLane): string => {
      const period = lane === 'gate' ? this.gatePeriodSec : this.pitchPeriodSec;
      const laps = lane === 'gate' ? this.gateLaps : this.pitchLaps;
      const elapsed = Math.max(0, Math.min(period, this.elapsed() - laps * period));
      return `${lane === 'gate' ? 'Gate' : 'Pitch'} ${timeText(elapsed)} / ${timeText(period)} · Lap ${laps + 1}`;
    };
    this.counter.textContent = this.mode === 'recording'
      ? this.recordingLane === 'both' ? `${laneText('gate')}\n${laneText('pitch')}` : laneText(this.recordingLane)
      : `${timeText(position?.elapsed ?? 0)} / ${timeText(position?.period ?? duration)}`;
    const place = (element: HTMLElement, info: ReturnType<SequenceTransport['position']>, recordingActive: boolean, lane: TimelineLane) => {
      const timelinePosition = this.mode === 'recording' && recordingActive ? this.recordPosition(lane)
        : info ? info.start + info.elapsed : 0;
      const fullDuration = this.mode === 'recording' && recordingActive
        ? (lane === 'gate' ? this.gateWorking?.durationSec : this.pitchWorking?.durationSec) ?? duration : info?.duration ?? duration;
      element.style.left = `${Math.max(0, Math.min(100, timelinePosition / fullDuration * 100))}%`;
    };
    place(this.gateTimeline.playhead, gatePosition, this.includes('gate'), 'gate');
    place(this.pitchTimeline.playhead, pitchPosition, this.includes('pitch'), 'pitch');
  }
}
