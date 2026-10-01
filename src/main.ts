import { ADSREditor } from './ui/ADSREditor';
import { FunctionEditor } from './ui/FunctionEditor';
import { CommonSpaceEditor, prepareCommonSpaceCards, type CommonCardId } from './ui/CommonSpaceEditor';
import type { EditorCardId } from './model/editorLayout';
import { DEFAULT_EDITOR_LAYOUT } from './model/editorLayout';
import { AudioEngine } from './audio/core/AudioEngine';
import { defaultBus, defaultSongSettings, defaultTimbre, DEFAULT_CHANNEL_MIX, LAB_SLOT_IDS, parseLabSession } from './model/documents';
import { MixerPanel } from './ui/MixerPanel';
import { TriggerRecorder } from './ui/TriggerRecorder';
import { SequenceTransport } from './ui/SequenceTransport';
import { SongTransport } from './ui/SongTransport';
import { USER_PATTERN_IDS } from './model/triggerRecording';
import { maxSongBars } from './model/recordingLimits';
import { SignalMap } from './ui/SignalMap';
import { mountPitchEnvelopeGuide, syncPitchEnvelopeGuide } from './ui/PitchEnvelopeGuide';
import type {
  BusAssignment,
  BurstSettings,
  ChannelBlock,
  EffectSlotIndex,
  EffectParameter,
  EffectSlotSettings,
  EffectType,
  EnvelopeCurve,
  ReleaseTiming,
  FilterOrder,
  Filter2Route,
  FilterType,
  TimbreDocument,
  UserPatternId,
  ModMode,
  OscSourceType
} from './audio/types';
import { DEFAULT_EFFECT_SLOT_SETTINGS, LIMITS } from './audio/constants';
import { NumericSliderControl } from './ui/NumericSliderControl';
import { PARAMETER_RANGES as P, parameterForInput, parameterValueBounds } from './config/parameterRanges';
import { validateParameterRanges } from './config/parameterSafety';
import { DEMO_SESSIONS } from './demoSessions';

const amplitudeEditor = new ADSREditor(document.querySelector<HTMLElement>('[data-adsr="aenv"]')!, 'aenv');
const filterEnvelopeEditor = new ADSREditor(document.querySelector<HTMLElement>('[data-adsr="fenv"]')!, 'fenv');
const numericSliders = new Map<HTMLInputElement, NumericSliderControl>();
const commonCards = prepareCommonSpaceCards(document.querySelector<HTMLElement>('.panel-deck')!);
mountPitchEnvelopeGuide(document.querySelector<HTMLElement>('#penv-shape-guide')!);

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Development harness DOM is incomplete: ${selector}`);
  return element;
}

function decimals(text: string): number {
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function clampUi(value: number, input: HTMLInputElement): number {
  const min = Number(input.dataset.numericMin ?? '-Infinity');
  const max = Number(input.dataset.numericMax ?? 'Infinity');
  const bounded = Math.min(max, Math.max(min, value));
  return input.dataset.numericInteger === 'true' ? Math.round(bounded) : bounded;
}

function sanitizeNumericInput(input: HTMLInputElement): void {
  const fallback = Number(input.dataset.lastValid ?? '0');
  const parsed = Number(input.value);
  const value = clampUi(Number.isFinite(parsed) ? parsed : fallback, input);
  input.value = String(value);
  input.dataset.lastValid = input.value;
}

function digitIndexForCaret(text: string, caret: number): number | null {
  if (caret < text.length && /\d/.test(text.charAt(caret))) return caret;
  for (let index = Math.min(caret - 1, text.length - 1); index >= 0; index -= 1) {
    if (/\d/.test(text.charAt(index))) return index;
    if (text.charAt(index) === '.') break;
  }
  for (let index = caret; index < text.length; index += 1) {
    if (/\d/.test(text.charAt(index))) return index;
  }
  return null;
}

function exponentForDigit(text: string, digitIndex: number): number {
  const decimalIndex = text.indexOf('.') >= 0 ? text.indexOf('.') : text.length;
  return digitIndex < decimalIndex
    ? decimalIndex - digitIndex - 1
    : decimalIndex - digitIndex;
}

function prepareNumericInputs(): void {
  document.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((input) => {
    const range = parameterForInput(input.id);
    if (!range) throw new Error(`src/config/parameterRanges.ts: missing definition for ${input.id}`);
    const bounds = parameterValueBounds(range);
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    input.step = String(range.step);
    input.defaultValue = String(range.defaultValue);
    input.value = input.defaultValue;
    input.dataset.numericMin = input.min;
    input.dataset.numericMax = input.max;
    input.dataset.numericStep = input.step;
    input.dataset.numericScale = range.scale;
    input.dataset.numericInteger = String(!!range.integer);
    if (range.coarseStep !== undefined) input.dataset.numericCoarseStep = String(range.coarseStep);
    input.dataset.lastValid = input.value;
    input.type = 'text';
    input.inputMode = 'decimal';

    input.addEventListener('change', () => sanitizeNumericInput(input));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (input.disabled) return;

      const text = input.value;
      const caret = input.selectionStart ?? text.length;
      const digitIndex = digitIndexForCaret(text, caret);
      if (digitIndex === null) return;

      event.preventDefault();
      const exponent = exponentForDigit(text, digitIndex);
      const delta = 10 ** exponent * (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1);
      const current = Number(text);
      if (!Number.isFinite(current)) return;

      const next = clampUi(current + delta, input);
      const precision = Math.min(8, Math.max(decimals(text), Math.max(0, -exponent)));
      input.value = precision > 0 ? next.toFixed(precision) : String(Math.round(next));
      input.dataset.lastValid = input.value;
      const nextCaret = Math.min(caret, input.value.length);
      input.setSelectionRange(nextCaret, nextCaret);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

prepareNumericInputs();

function numberValue(selector: string): number {
  return Number(requireElement<HTMLInputElement>(selector).value);
}

function setValue(selector: string, value: number | string): void {
  const input = requireElement<HTMLInputElement | HTMLSelectElement>(selector);
  input.value = String(value);
  if (input instanceof HTMLSelectElement) syncSegmentedSelect(input);
  if (input instanceof HTMLInputElement && input.dataset.lastValid !== undefined) {
    if (input.dataset.numericInteger === 'true') input.value = String(clampUi(Number(value), input));
    input.dataset.lastValid = input.value;
    numericSliders.get(input)?.sync();
  }
}

function syncSegmentedSelect(select: HTMLSelectElement): void {
  const group = select.parentElement?.querySelector<HTMLElement>('[role="radiogroup"]');
  const buttons = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
  const hasChoice = buttons.some(button => button.dataset.value === select.value);
  buttons.forEach((button, index) => {
    const checked = button.dataset.value === select.value;
    button.setAttribute('aria-checked', String(checked));
    button.tabIndex = checked || (!hasChoice && index === 0) ? 0 : -1;
  });
}

function buildSegmentedSelects(): void {
  document.querySelectorAll<HTMLSelectElement>('.choice-field select').forEach(select => {
    const group = document.createElement('div');
    group.className = 'segmented-choice'; group.setAttribute('role', 'radiogroup');
    group.style.setProperty('--segments', String(select.options.length));
    const legend = select.closest('fieldset')?.querySelector('legend')?.textContent?.trim() ?? '';
    group.setAttribute('aria-label', `${legend} ${select.parentElement?.querySelector('span')?.textContent ?? ''}`);
    for (const option of select.options) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.audioControl = ''; button.dataset.value = option.value;
      button.setAttribute('role', 'radio'); button.textContent = option.textContent;
      button.disabled = select.disabled;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        select.value = option.value; syncSegmentedSelect(select);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      button.addEventListener('keydown', event => {
        const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
        const at = buttons.indexOf(button);
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % buttons.length
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at + buttons.length - 1) % buttons.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); buttons[next]!.click(); buttons[next]!.focus();
      });
      group.append(button);
    }
    select.after(group); syncSegmentedSelect(select);
  });
}

buildSegmentedSelects();

const triggerButton = requireElement<HTMLButtonElement>('#trigger');
const playAllButton = requireElement<HTMLButtonElement>('#play-all');
const fullscreenToggle = requireElement<HTMLButtonElement>('#fullscreen-toggle');
const displayErrorElement = requireElement<HTMLElement>('#display-error');
const statusElement = requireElement<HTMLButtonElement>('#status');
const audioErrorElement = requireElement<HTMLElement>('#audio-error');
const stateDot = requireElement<HTMLElement>('#state-dot');
const sampleRateElement = requireElement<HTMLElement>('#sample-rate');
const activePathElement = requireElement<HTMLElement>('#active-path');
const modReadout = requireElement<HTMLElement>('#mod-readout');
const gateLamp = requireElement<HTMLElement>('#gate-lamp');
const gateLampPanel = requireElement<HTMLElement>('#gate-lamp-panel');
const osc1DetuneReadout = requireElement<HTMLElement>('#osc1-detune-readout');
const osc2DetuneReadout = requireElement<HTMLElement>('#osc2-detune-readout');
const detuneCentReadout = requireElement<HTMLElement>('#detune-cent-readout');
const patchStatus = requireElement<HTMLElement>('#patch-status');

const sequencePanelButton = requireElement<HTMLButtonElement>('#sequence-panel');
const sourceAutoButton = requireElement<HTMLButtonElement>('#source-auto');
const pitchUserButtons = USER_PATTERN_IDS.map((_, index) => requireElement<HTMLButtonElement>(`#pitch-user-${index + 1}`));
const gateUserButtons = USER_PATTERN_IDS.map((_, index) => requireElement<HTMLButtonElement>(`#source-user-${index + 1}`));
const recordedGateButton = requireElement<HTMLButtonElement>('#source-recorded');
const songButton = requireElement<HTMLButtonElement>('#song-toggle');
const songTimingSelect = requireElement<HTMLSelectElement>('#song-timing');
const songBarsGroup = requireElement<HTMLFieldSetElement>('#song-bars-group');
const songBpmInput = requireElement<HTMLInputElement>('#song-bpm');
const recordBpmInput = requireElement<HTMLInputElement>('#record-bpm');
const recordBpmLabel = requireElement<HTMLLabelElement>('.record-bpm-label');
const recordLengthMode = requireElement<HTMLSelectElement>('#record-length-mode');
const songSpeedInput = requireElement<HTMLInputElement>('#song-speed');
const songSpeedSlider = requireElement<HTMLInputElement>('#song-speed-slider');
const songUserSelect = requireElement<HTMLSelectElement>('#song-user');
const songBarsInput = requireElement<HTMLInputElement>('#song-bars');
const songDuration = requireElement<HTMLOutputElement>('#song-duration');
const songClock = requireElement<HTMLOutputElement>('#song-clock');

function showDisplayError(message: string): void {
  displayErrorElement.textContent = message;
  displayErrorElement.hidden = false;
}

function syncFullscreenToggle(): void {
  const available = document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
  const active = document.fullscreenElement !== null;
  fullscreenToggle.hidden = !available;
  fullscreenToggle.setAttribute('aria-pressed', String(active));
  fullscreenToggle.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  fullscreenToggle.title = active ? 'Exit fullscreen' : 'Fullscreen';
  if (active) displayErrorElement.hidden = true;
}

fullscreenToggle.addEventListener('click', async () => {
  displayErrorElement.hidden = true;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    showDisplayError('Fullscreen could not start. Try again from Chrome.');
  } finally {
    syncFullscreenToggle();
  }
});
document.addEventListener('fullscreenchange', syncFullscreenToggle);
document.addEventListener('fullscreenerror', () => showDisplayError('Fullscreen is unavailable.'));
syncFullscreenToggle();

let engine: AudioEngine | null = null;
let loadingSession = false;
let resumePromise: Promise<void> | null = null;
function runAudioStartAttempt(): Promise<void> {
  if (!engine) return Promise.reject(new Error('Audio engine is unavailable.'));
  return engine.start().then(() => {
    if (engine?.context.state !== 'running') throw new Error('AudioContext did not resume.');
    audioErrorElement.hidden = true;
    audioErrorElement.textContent = '';
    refreshStatus();
  }).catch(error => {
    patchStatus.textContent = `Audio could not start: ${error instanceof Error ? error.message : String(error)}. Try a Gate or Play control again.`;
    audioErrorElement.textContent = 'Audio could not start. Tap Audio ready or try GATE or Play again.';
    audioErrorElement.hidden = false;
    refreshStatus();
    throw error;
  });
}
function ensureAudioRunning(forceAttempt = false): Promise<void> {
  if (!engine) return Promise.reject(new Error('Audio engine is unavailable.'));
  if (engine.context.state === 'running') return Promise.resolve();
  // Touch/pen activation is granted on pointerup, not pointerdown. A second
  // resume() call must therefore be allowed while the pointerdown call waits.
  if (forceAttempt) return runAudioStartAttempt();
  if (!resumePromise) {
    let pending: Promise<void>;
    pending = runAudioStartAttempt().finally(() => {
      if (resumePromise === pending) resumePromise = null;
    });
    resumePromise = pending;
  }
  return resumePromise;
}
statusElement.addEventListener('click', () => { void ensureAudioRunning(true).catch(() => {}); });
const transport = new SequenceTransport(() => engine, ensureAudioRunning,
  () => { mixer.refresh(); recorder.refresh(); numericSliders.forEach(slider => slider.sync()); syncTransportControls(); },
  message => { patchStatus.textContent = message; }, id => mixer.manual.forgetSource(id), () => songTransport.stop());
const songTransport = new SongTransport(() => engine, ensureAudioRunning, syncTransportControls, () => transport.stopAll());
const mixer = new MixerPanel(requireElement('#mixer-slots'), () => engine, ensureAudioRunning, syncSelectedSource,
  message => { patchStatus.textContent = message; }, saveTimbre,
  id => { songTransport.stop(); transport.beforeReplace(id); recorder.releaseSource(id); if (recorder.lockedId() === id) recorder.cancel(); }, () => transport);
const recorder = new TriggerRecorder(() => engine, () => mixer.selectedId, ensureAudioRunning,
  id => {
    mixer.manual.forgetSource(id);
    engine?.cancelScheduledGates(id);
    mixer.refresh();
  }, (id, lane) => {
    if (id) songTransport.stop();
    transport.setRecordingTarget(id, lane);
    mixer.protectSource(id);
    if (id) applyRecordingLock();
    else setAudioControlsEnabled(engine !== null && !loadingSession);
  }, transport, () => { if (songTransport.isPlaying()) songTransport.stop(); }, syncSongSettings);
function selectedChannel() { return engine?.getChannel(mixer.selectedId); }
let gateState = false;
let lastSongPreviewAt = 0;

function setGateIndicator(on: boolean): void {
  gateState = on;
  gateLamp.classList.toggle('on', on);
  gateLampPanel.classList.toggle('on', on);
  gateLampPanel.setAttribute('aria-label', on ? 'Gate on' : 'Gate off');
}

function animateGate(): void {
  if (engine) setGateIndicator(mixer.animate(engine.context.currentTime + 0.002));
  const floor = selectedChannel()?.isPitchFloorLimitedNow() ?? false;
  requireElement<HTMLOutputElement>('#penv-floor-status').hidden = !floor;
  recorder.refreshClock();
  if (performance.now() - lastSongPreviewAt > 500) { syncSongPreview(); lastSongPreviewAt = performance.now(); }
  const song = songTransport.position();
  if (song) {
    songClock.textContent = song.bar === undefined
      ? `User ${song.user} · ${songTime(song.userElapsedSec)} / ${songTime(song.userDurationSec)} · Total ${songTime(song.elapsedSec)}`
      : `User ${song.user} · Bar ${song.bar} · Beat ${song.beat} · ${songTime(song.elapsedSec)}`;
  } else songClock.textContent = 'Song stopped';
  syncTransportControls();
  window.requestAnimationFrame(animateGate);
}
function syncTransportControls(): void {
  const id = mixer.selectedId;
  const running = transport.isPlaying(id);
  sequencePanelButton.textContent = running ? '■ Stop' : '▶ Play';
  sequencePanelButton.setAttribute('aria-pressed', String(running));
  const source = transport.source(id);
  sourceAutoButton.setAttribute('aria-pressed', String(source.gateMode === 'auto'));
  recordedGateButton.setAttribute('aria-pressed', String(source.gateMode === 'user'));
  gateUserButtons.forEach((button, index) => {
    const patternId = `user-${index + 1}` as typeof source.gateUserId;
    const gate = engine?.getChannel(id) ? engine.getGateRecording(id, patternId) : null;
    button.setAttribute('aria-pressed', String(source.gateUserId === patternId));
    button.querySelector('small')!.textContent = gate ? engine!.getGateMuted(id, patternId) ? '0' : '1' : 'Null';
  });
  pitchUserButtons.forEach((button, index) => {
    const patternId = `user-${index + 1}` as typeof source.pitchUserId;
    const pitch = engine?.getChannel(id) ? engine.getPitchRecording(id, patternId) : null;
    button.setAttribute('aria-pressed', String(source.pitchUserId === patternId));
    button.querySelector('small')!.textContent = pitch ? engine!.getPitchMuted(id, patternId) ? '0' : '1' : 'Null';
  });
  const any = transport.anyPlaying();
  playAllButton.textContent = any ? 'Stop All' : 'Play All';
  playAllButton.setAttribute('aria-pressed', String(any));
  songButton.textContent = songTransport.isPlaying() ? '■ Stop Song' : '▶ Play Song';
  songButton.setAttribute('aria-pressed', String(songTransport.isPlaying()));
}
window.requestAnimationFrame(animateGate);

function refreshStatus(): void {
  if (!engine) {
    statusElement.textContent = 'Audio: loading';
    statusElement.disabled = true;
    sampleRateElement.textContent = 'sampleRate: -- Hz';
    stateDot.classList.remove('running');
    return;
  }

  statusElement.textContent = engine.context.state === 'suspended'
    ? 'Audio ready · Tap'
    : engine.context.state === 'running'
      ? 'Audio running'
      : `Audio ${engine.context.state}`;
  statusElement.disabled = engine.context.state === 'running' || engine.context.state === 'closed';
  sampleRateElement.textContent = `sampleRate: ${engine.context.sampleRate} Hz`;
  stateDot.classList.toggle('running', engine.context.state === 'running');
  document.body.classList.toggle('audio-running', engine.context.state === 'running');
}

function setAudioControlsEnabled(enabled: boolean): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-audio-control]')
    .forEach((element) => { element.disabled = !enabled; });
  const sourceEnabled = enabled && !!selectedChannel();
  triggerButton.disabled = !sourceEnabled;
  const anyVoice = enabled && !!engine?.getChannelIds().some(id => engine?.getChannel(id));
  playAllButton.disabled = !anyVoice;
  songButton.disabled = !anyVoice || recorder.isBusy();
  sequencePanelButton.disabled = !sourceEnabled;
  sourceAutoButton.disabled = !sourceEnabled;
  gateUserButtons.forEach(button => { button.disabled = !sourceEnabled; });
  recordedGateButton.disabled = !sourceEnabled;
  pitchUserButtons.forEach(button => { button.disabled = !sourceEnabled; });
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    '.source-group [data-audio-control], [data-panel="sources"] [data-audio-control], [data-panel="modulation"] [data-audio-control], [data-panel="filters"] [data-audio-control], [data-panel="amp"] [data-audio-control], [data-panel="burst"] [data-audio-control], [data-panel="triggering"] [data-audio-control], [data-panel="output"] [data-audio-control], [data-effect-slot="fx1"] [data-audio-control]'
  ).forEach(control => { control.disabled = !sourceEnabled; });
  mixer.setEnabled(enabled);
  syncTransportControls();
  updateAllEffectParamVisibility();
  syncModAvailability();
  refreshAutoTriggerControls();
  refreshBurstControls();
  applyRecordingLock();
  syncSongSettings();
  if (!enabled) { recordBpmInput.disabled = true; songBarsGroup.disabled = true; }
}

function applyRecordingLock(): void {
  if (!recorder.isBusy()) return;
  triggerButton.disabled = true;
  sequencePanelButton.disabled = true;
  sourceAutoButton.disabled = true;
  gateUserButtons.forEach(button => { button.disabled = true; });
  songButton.disabled = true;
  recordBpmInput.disabled = true;
  songBarsGroup.disabled = true;
  recordedGateButton.disabled = true;
  pitchUserButtons.forEach(button => { button.disabled = true; });
}

function syncModAvailability(): void {
  const routed = requireElement<HTMLSelectElement>('#filter2-route').value === 'mod';
  const editable = !!engine && !!selectedChannel() && !loadingSession && routed;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
    '.mod-editor [data-audio-control], [data-block-toggle="mod"]'
  ).forEach(control => { control.disabled = !editable; });
}

let functionEditor: FunctionEditor | undefined;
let commonEditor: CommonSpaceEditor | undefined;
function refreshEditingNodes(): void {
  const panelName = document.querySelector<HTMLElement>('[data-panel].active:not(.editor-card):not(.space-card)')?.dataset.panel;
  document.querySelectorAll<HTMLButtonElement>('[data-panel-target]:not([data-editor-target]):not([data-common-target])').forEach((button) => {
    const active = button.dataset.panelTarget === panelName && (!button.dataset.bus || button.dataset.bus === selectedBus());
    button.classList.toggle('active', active);
  });
  functionEditor?.refreshNodes();
  commonEditor?.refreshNodes();
  if (functionEditor && !functionEditor.root.hidden) {
    const cards = [...document.querySelectorAll<HTMLElement>('.editor-card.active')].map(card => card.dataset.editorCard!.toUpperCase());
    activePathElement.textContent = `Viewing: ${cards.join(' / ') || 'Select a block'}`;
  }
}
function showPanel(panelName: string, cardId?: EditorCardId, focus = false, commonId?: CommonCardId, activate = false): void {
  const dedicated = panelName === 'patch';
  const common = panelName === 'space-effects' || panelName === 'space-output';
  document.querySelectorAll<HTMLElement>('[data-panel]:not(.editor-card):not(.space-card)').forEach(panel => {
    panel.classList.toggle('active', dedicated && panel.dataset.panel === panelName);
  });
  if (dedicated || common) functionEditor?.hide();
  else if (activate && cardId) functionEditor?.activate(cardId, focus);
  else functionEditor?.show(cardId, focus);
  if (common && activate && commonId) commonEditor?.activate(commonId, focus);
  else if (common) commonEditor?.show(commonId, focus);
  else commonEditor?.hide();
  refreshEditingNodes();
  const labels: Record<string, string> = { 'space-effects': 'COMMON SPACE FX / GAIN', 'space-output': 'COMMON SPACE OUTPUT', patch: 'FILES' };
  const cards = [...document.querySelectorAll<HTMLElement>('.editor-card.active')].map(card => card.dataset.editorCard!.toUpperCase());
  activePathElement.textContent = `Viewing: ${dedicated ? labels[panelName] : common ? 'COMMON SPACE · ' + commonEditor?.viewingLabel : cards.join(' / ') || 'Select a block'}`;
  if (dedicated && focus) {
    const heading = requireElement<HTMLElement>('.function-panel.active:not(.editor-card):not(.space-card) .panel-heading');
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-panel-target]').forEach(button => {
  button.addEventListener('click', event => {
    if (button.dataset.bus) {
      setSelectedBus(button.dataset.bus as BusAssignment);
      refreshEffectControls(); refreshBlockSwitches();
    }
    if (button.dataset.panelTarget) showPanel(button.dataset.panelTarget, button.dataset.editorTarget as EditorCardId | undefined, event.detail === 0, button.dataset.commonTarget as CommonCardId | undefined, true);
  });
});
const labBody = requireElement<HTMLElement>('.lab-body');
const mixerPanel = requireElement<HTMLElement>('.mixer-panel');
const mixerDivider = requireElement<HTMLElement>('#mixer-divider');
const MIXER_DEFAULT_WIDTH = 248;
const MIXER_STEP = 8;
let mixerDragOffset = 0;
function setMixerWidth(width: number): void {
  const next = Math.max(0, Math.min(MIXER_DEFAULT_WIDTH, width));
  const rounded = Math.round(next);
  labBody.style.setProperty('--mixer-width', `${rounded}px`);
  labBody.dataset.mixerCollapsed = String(rounded === 0);
  mixerPanel.inert = rounded === 0;
  mixerPanel.setAttribute('aria-hidden', String(rounded === 0));
  mixerDivider.setAttribute('aria-valuenow', String(rounded));
  window.dispatchEvent(new Event('resize'));
}
mixerDivider.addEventListener('pointerdown', event => {
  const dividerRect = mixerDivider.getBoundingClientRect();
  mixerDragOffset = event.clientX - dividerRect.left;
  mixerDivider.setPointerCapture(event.pointerId);
  document.body.classList.add('mixer-resizing');
  document.getSelection()?.removeAllRanges();
  event.preventDefault();
});
mixerDivider.addEventListener('pointermove', event => {
  if (!mixerDivider.hasPointerCapture(event.pointerId)) return;
  const bodyRect = labBody.getBoundingClientRect();
  setMixerWidth(event.clientX - bodyRect.left - mixerDragOffset);
});
const endMixerResize = (): void => { document.body.classList.remove('mixer-resizing'); };
mixerDivider.addEventListener('pointerup', endMixerResize);
mixerDivider.addEventListener('pointercancel', endMixerResize);
mixerDivider.addEventListener('lostpointercapture', endMixerResize);
mixerDivider.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = Number(mixerDivider.getAttribute('aria-valuenow'));
  const width = event.key === 'Home' ? MIXER_DEFAULT_WIDTH
    : event.key === 'End' ? 0
      : current + (event.key === 'ArrowRight' ? MIXER_STEP : -MIXER_STEP);
  setMixerWidth(width);
});

const editorColumn = requireElement<HTMLElement>('.editor-column');
const panelDivider = requireElement<HTMLElement>('#panel-divider');
function setPanelShare(percent: number): void {
  const share = Math.max(0, Math.min(75, percent));
  editorColumn.style.setProperty('--diagram-share', `${share}fr`);
  editorColumn.style.setProperty('--edit-share', `${100 - share}fr`);
  editorColumn.dataset.diagramCollapsed = String(share === 0);
  const diagram = requireElement<HTMLElement>('.signal-map');
  diagram.inert = share === 0;
  diagram.setAttribute('aria-hidden', String(share === 0));
  panelDivider.setAttribute('aria-valuenow', String(Math.round(share)));
  window.dispatchEvent(new Event('resize'));
}
panelDivider.addEventListener('pointerdown', event => {
  panelDivider.setPointerCapture(event.pointerId);
  document.body.classList.add('panel-resizing');
  document.getSelection()?.removeAllRanges();
  event.preventDefault();
});
panelDivider.addEventListener('pointermove', event => {
  if (!panelDivider.hasPointerCapture(event.pointerId)) return;
  const rect = editorColumn.getBoundingClientRect();
  setPanelShare((event.clientY - rect.top - 4) / (rect.height - 8) * 100);
});
const endPanelResize = (): void => { document.body.classList.remove('panel-resizing'); };
panelDivider.addEventListener('pointerup', endPanelResize);
panelDivider.addEventListener('pointercancel', endPanelResize);
panelDivider.addEventListener('lostpointercapture', endPanelResize);
document.addEventListener('selectstart', event => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('input[type="text"], textarea, [contenteditable="true"]')) event.preventDefault();
});
panelDivider.addEventListener('keydown', event => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  setPanelShare(event.key === 'Home' ? 50 : event.key === 'End' ? 0 : Number(panelDivider.getAttribute('aria-valuenow')) + (event.key === 'ArrowDown' ? 2 : -2));
});

function applyAutoTrigger(): void {
  const channel = selectedChannel();
  if (!channel) return;
  channel.setAutoTrigger({ tonSec: numberValue('#ton') / 1000, repeatSec: numberValue('#trepeat') / 1000 });
  refreshAutoTriggerControls();
}

function refreshAutoTriggerControls(): void {
  const settings = selectedChannel()?.getSettings();
  const ton = requireElement<HTMLInputElement>('#ton');
  requireElement<HTMLElement>('[data-numeric-control="ton"]').hidden = false;
  ton.disabled = !settings || loadingSession || recorder.isBusy();
  numericSliders.get(ton)?.sync();
  const warning = requireElement<HTMLElement>('#auto-timing-warning');
  warning.hidden = !settings || settings.autoTrigger.tonSec < settings.autoTrigger.repeatSec;
  if (settings) setValue('#trepeat', Math.round(settings.autoTrigger.repeatSec * 1000));
}

function burstSettingsFromUi(enabled: boolean): BurstSettings {
  return {
    enabled,
    pulseCountMin: numberValue('#burst-count-min'),
    pulseCountMax: numberValue('#burst-count-max'),
    pulseIntervalSec: numberValue('#burst-pulse-interval') / 1000,
    pulseIntervalJitter: numberValue('#burst-pulse-jitter') / 100,
    groupPeriodSec: numberValue('#burst-group-period') / 1000,
    groupPeriodJitter: numberValue('#burst-group-jitter') / 100
  };
}

function applyBurstSettings(changed?: 'min' | 'max'): void {
  const channel = selectedChannel(); if (!channel) return;
  let min = numberValue('#burst-count-min'), max = numberValue('#burst-count-max');
  if (min > max) {
    if (changed === 'max') { min = max; setValue('#burst-count-min', min); }
    else { max = min; setValue('#burst-count-max', max); }
  }
  const enabled = channel.getSettings().burst.enabled;
  channel.setBurstSettings({ ...burstSettingsFromUi(enabled), pulseCountMin: min, pulseCountMax: max });
  refreshBurstControls(); refreshAutoTriggerControls();
}

function formatBurstMs(value: number): string {
  return value >= 1000 ? `${Number((value / 1000).toFixed(2))} s` : `${Number(value.toFixed(1))} ms`;
}

function refreshBurstTimingGuides(): void {
  const settings = selectedChannel()?.getSettings();
  const summary = requireElement<HTMLElement>('#burst-timing-summary');
  const warnings = requireElement<HTMLElement>('#burst-timing-warnings');
  const intervalSlider = numericSliders.get(requireElement<HTMLInputElement>('#burst-pulse-interval'));
  const periodSlider = numericSliders.get(requireElement<HTMLInputElement>('#burst-group-period'));
  if (!settings) {
    intervalSlider?.setGuide(null); periodSlider?.setGuide(null);
    summary.textContent = 'AEnv T: -- · Full-group guide: --';
    warnings.textContent = ''; warnings.hidden = true;
    return;
  }

  const envelopeMs = (settings.ampEnvelope.attackSec + settings.ampEnvelope.decaySec + settings.ampEnvelope.releaseSec) * 1000;
  const intervalMs = settings.burst.pulseIntervalSec * 1000;
  const shortestIntervalMs = intervalMs * (1 - settings.burst.pulseIntervalJitter);
  const latestLastPulseMs = (settings.burst.pulseCountMax - 1) * intervalMs * (1 + settings.burst.pulseIntervalJitter);
  const fullGroupMs = latestLastPulseMs + envelopeMs;
  const earliestPeriodMs = settings.burst.groupPeriodSec * 1000 * (1 - settings.burst.groupPeriodJitter);
  const schedulerFloorMs = latestLastPulseMs + LIMITS.triggerOffSec.min * 1000;

  intervalSlider?.setGuide(envelopeMs, `AEnv T = ${formatBurstMs(envelopeMs)}`);
  periodSlider?.setGuide(fullGroupMs, `Full-group guide = ${formatBurstMs(fullGroupMs)}`);
  summary.textContent = `AEnv T: ${formatBurstMs(envelopeMs)} · Full-group guide: ${formatBurstMs(fullGroupMs)}`;

  const messages: string[] = [];
  if (shortestIntervalMs < envelopeMs) {
    messages.push(`Retrigger overlap: shortest interval ${formatBurstMs(shortestIntervalMs)} < AEnv T ${formatBurstMs(envelopeMs)}.`);
  }
  if (earliestPeriodMs < schedulerFloorMs) {
    messages.push(`Effective period may be delayed: earliest period ${formatBurstMs(earliestPeriodMs)} < scheduler floor ${formatBurstMs(schedulerFloorMs)}.`);
  }
  if (earliestPeriodMs < fullGroupMs) {
    messages.push(`Group overlap: earliest period ${formatBurstMs(earliestPeriodMs)} < full-group guide ${formatBurstMs(fullGroupMs)}.`);
  }
  warnings.textContent = messages.join(' '); warnings.hidden = messages.length === 0;
}

function refreshBurstControls(): void {
  const settings = selectedChannel()?.getSettings();
  const oneShot = settings?.ampEnvelope.mode === 'one-shot';
  const enabled = !!settings?.burst.enabled && !!oneShot;
  for (const selector of ['#burst-enabled', '#burst-block-enabled']) {
    const toggle = requireElement<HTMLButtonElement>(selector);
    toggle.disabled = !settings || loadingSession || recorder.isBusy();
    toggle.setAttribute('aria-pressed', String(enabled)); toggle.textContent = enabled ? 'ON' : 'OFF';
  }
  requireElement('#flow-burst').classList.toggle('enabled', enabled);
  requireElement('#flow-burst').classList.toggle('bypassed', !enabled);
  document.querySelectorAll<HTMLInputElement>('[data-panel="burst"] input').forEach(input => {
    input.disabled = !enabled || loadingSession || recorder.isBusy(); numericSliders.get(input)?.sync();
  });
  refreshBurstTimingGuides();
}

function setBurstEnabled(enabled: boolean): void {
  const channel = selectedChannel(); if (!channel) return;
  const amplitude = channel.getSettings().ampEnvelope;
  if (enabled && amplitude.mode !== 'one-shot') {
    channel.setAmplitudeEnvelope({ ...amplitude, mode: 'one-shot' });
    setValue('#aenv-mode', 'one-shot');
  }
  channel.setBurstSettings(burstSettingsFromUi(enabled));
  refreshBurstControls(); refreshAutoTriggerControls(); signalMap.refresh();
}

function applyAmplitudeEnvelope(curve?: EnvelopeCurve, mode?: 'gate' | 'one-shot', timing?: ReleaseTiming): void {
  const channel = selectedChannel();
  if (!channel) return;
  const next = amplitudeEditor.read(channel.getSettings().ampEnvelope, curve, mode, timing);
  channel.setAmplitudeEnvelope(next);
  amplitudeEditor.sync(next, setValue);
  refreshBurstControls();
  if (mode) { refreshAutoTriggerControls(); signalMap.refresh(); }
}

function applyPitchEnvelope(): void {
  const curve = requireElement<HTMLSelectElement>('#penv-curve').value as 'linear' | 'logarithmic';
  selectedChannel()?.setPitchEnvelope({
    mode: requireElement<HTMLSelectElement>('#penv-mode').value as 'gate' | 'one-shot',
    curve,
    start: numberValue('#penv-start') / 100,
    attack: numberValue('#penv-attack-level') / 100,
    sustain: numberValue('#penv-sustain-level') / 100,
    release: numberValue('#penv-release-level') / 100,
    attackSec: numberValue('#penv-attack-time') / 1000,
    decaySec: numberValue('#penv-decay-time') / 1000,
    releaseSec: numberValue('#penv-release-time') / 1000,
    scale: numberValue('#penv-scale'),
    releaseTiming: requireElement<HTMLSelectElement>('#penv-release-timing').value as ReleaseTiming
  });
  syncPitchEnvelopeGuide(requireElement<HTMLElement>('#penv-shape-guide'), curve);
}

function updateModReadout(mode: ModMode): void {
  const cutoff = requireElement<HTMLSelectElement>('#filter2-route').value === 'filter1-cutoff';
  requireElement<HTMLElement>('#source-path-osc2').textContent = `OSC2 → FILTER2 → ${cutoff ? 'F1 CUTOFF' : 'MOD'}`;
  requireElement<HTMLElement>('#mod-path-label').textContent = `OSC2 → FILTER2 → ${cutoff ? 'F1 CUTOFF' : 'MOD'}`;
  if (cutoff) {
    modReadout.textContent = 'FILTER2 → F1 CUTOFF; MOD mode and depth retained';
    requireElement<HTMLElement>('.mod-depth-am').hidden = true;
    requireElement<HTMLElement>('.mod-depth-fm').hidden = true;
    return;
  }
  if (mode === 'am') modReadout.textContent = 'AM: y(t) = x1(t) × (offset + depth × z2(t))';
  if (mode === 'fm') modReadout.textContent = 'FM: OSC2 controls OSC1 detune in cent';
  requireElement<HTMLElement>('.mod-depth-am').hidden = mode !== 'am';
  requireElement<HTMLElement>('.mod-depth-fm').hidden = mode !== 'fm';
}

function formatSigned(value: number, digits = 3): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatFrequency(value: number): string {
  if (value >= 1000) return value.toFixed(2);
  if (value >= 100) return value.toFixed(3);
  return value.toFixed(4);
}

function refreshDetuneReadouts(): void {
  if (!selectedChannel()) {
    osc1DetuneReadout.textContent = 'Source detune: -- cent → -- Hz';
    osc2DetuneReadout.textContent = 'Source detune: -- cent → -- Hz';
    detuneCentReadout.textContent = 'ri: -- / detune: -- cent';
    return;
  }

  const cent = selectedChannel()!.getCurrentDetuneCent();
  const ri = selectedChannel()!.getDetuneNormalized();
  const osc1Hz = selectedChannel()!.getDetunedFrequencyHz(1);
  const osc2Hz = selectedChannel()!.getDetunedFrequencyHz(2);
  osc1DetuneReadout.textContent = osc1Hz === null
    ? `Source detune: N/A (White Noise)`
    : `Source detune: ${formatSigned(cent)} cent → ${formatFrequency(osc1Hz)} Hz`;
  osc2DetuneReadout.textContent = osc2Hz === null
    ? `Source detune: N/A (White Noise)`
    : `Source detune: ${formatSigned(cent)} cent → ${formatFrequency(osc2Hz)} Hz`;
  detuneCentReadout.textContent = `ri: ${formatSigned(ri, 5)} / detune: ${formatSigned(cent)} cent`;
}

mixer.manual.bind(triggerButton, () => mixer.selectedId);
playAllButton.addEventListener('click', () => { void transport.toggleAll(); });
songButton.addEventListener('click', () => {
  if (recorder.isBusy()) return;
  if (!songTransport.isPlaying() && !songTransport.preview().length) {
    patchStatus.textContent = 'Record or load a Gate USER pattern before playing Song.'; return;
  }
  void songTransport.toggle();
});
function songTime(seconds: number): string {
  const whole = Math.floor(Math.max(0, seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
function syncSongPreview(): void {
  const settings = engine?.getSongSettings(); if (!settings) return;
  const sections = songTransport.preview();
  const barsTime = settings.bars[Number(songUserSelect.value) - 1]! * 240 / (settings.bpm * settings.speed);
  const users = sections.map(item => item.user).join(', ');
  const duration = settings.timingMode === 'bars' ? `Bars USER ${songUserSelect.value}: ${barsTime.toFixed(2)} s`
    : `Seconds total: ${sections.length ? `${sections.reduce((sum, section) => sum + section.duration, 0).toFixed(2)} s` : 'empty'}`;
  songDuration.textContent = `${duration} · ${users ? `Song USER ${users}` : 'No Gate USER'}`;
}
function syncSongSettings(): void {
  const settings = engine?.getSongSettings(); if (!settings) return;
  setValue('#song-timing', settings.timingMode);
  songBpmInput.value = String(settings.bpm);
  recordBpmInput.value = String(settings.bpm);
  recordBpmLabel.hidden = recordLengthMode.value !== 'bars';
  recordBpmInput.disabled = recordLengthMode.value !== 'bars' || recorder.isBusy();
  songBarsGroup.disabled = settings.timingMode !== 'bars' || recorder.isBusy();
  songSpeedInput.value = String(settings.speed);
  songSpeedSlider.value = String(settings.speed);
  songBarsInput.value = String(settings.bars[Number(songUserSelect.value) - 1]);
  songBarsInput.setAttribute('aria-label', `Bars to fit the selected USER, 1 to ${maxSongBars(settings.bpm)}`);
  syncSongPreview();
}
recordLengthMode.addEventListener('change', syncSongSettings);
songUserSelect.addEventListener('change', syncSongSettings);
songTimingSelect.addEventListener('change', () => {
  if (!engine) return;
  songTransport.stop(); engine.setSongSettings({ ...engine.getSongSettings(), timingMode: songTimingSelect.value as 'original' | 'bars' });
  syncSongSettings(); recorder.refresh();
});
function applyBpm(value: string): void {
  if (!engine) return;
  const bpm = Number(value);
  if (Number.isInteger(bpm) && bpm >= P['song-bpm'].min && bpm <= P['song-bpm'].max) {
    if (engine.getSongSettings().bars.some(bars => bars > maxSongBars(bpm))) {
      patchStatus.textContent = `Reduce Fit to Bars to ${maxSongBars(bpm)} or fewer before setting ${bpm} BPM.`;
    } else { engine.setSongSettings({ ...engine.getSongSettings(), bpm }); songTransport.updateTiming(); recorder.refresh(); }
  } else patchStatus.textContent = 'BPM must be a whole number from 40 to 240.';
  syncSongSettings();
}
songBpmInput.addEventListener('change', () => { if (!songBpmInput.disabled) applyBpm(songBpmInput.value); });
recordBpmInput.addEventListener('change', () => { if (!recordBpmInput.disabled) applyBpm(recordBpmInput.value); });
function applySongSpeed(value: number): void {
  if (!engine || !Number.isFinite(value) || value < P['song-speed'].min || value > P['song-speed'].max) {
    patchStatus.textContent = 'Song Speed must be 0.25–4×.';
  } else {
    engine.setSongSettings({ ...engine.getSongSettings(), speed: value });
    songTransport.updateTiming();
  }
  syncSongSettings();
}
songSpeedInput.addEventListener('change', () => applySongSpeed(Number(songSpeedInput.value)));
songSpeedSlider.addEventListener('input', () => applySongSpeed(Number(songSpeedSlider.value)));
songBarsInput.addEventListener('change', () => {
  if (!engine) return;
  const bars = Number(songBarsInput.value);
  if (Number.isInteger(bars) && bars >= P['song-bars'].min && bars <= maxSongBars(engine.getSongSettings().bpm)) {
    songTransport.stop(); const settings = engine.getSongSettings();
    settings.bars[Number(songUserSelect.value) - 1] = bars; engine.setSongSettings(settings);
  } else patchStatus.textContent = `Fit to Bars must be a whole number from 1 to ${maxSongBars(engine.getSongSettings().bpm)}.`;
  syncSongSettings();
});
requireElement<HTMLButtonElement>('#copy-user').addEventListener('click', () => {
  const id = mixer.selectedId, from = requireElement<HTMLSelectElement>('#copy-from').value as UserPatternId;
  const to = requireElement<HTMLSelectElement>('#copy-to').value as UserPatternId;
  if (!engine?.getChannel(id) || recorder.isBusy()) return;
  if (from === to) { patchStatus.textContent = 'Choose a different destination USER.'; return; }
  if (!window.confirm(`Overwrite Timbre ${id} ${to} with ${from}? Gate, Pitch, selections, mute and Pitch settings will be replaced.`)) return;
  songTransport.stop(); transport.stop(id); engine.copyUserPattern(id, from, to);
  recorder.refresh(); syncSongPreview(); syncTransportControls(); patchStatus.textContent = `Copied Timbre ${id} ${from} → ${to}.`;
});
sourceAutoButton.addEventListener('click', () => transport.setSelection(mixer.selectedId, { gateMode: 'auto' }));
recordedGateButton.addEventListener('click', () => transport.setSelection(mixer.selectedId, { gateMode: 'user' }));
gateUserButtons.forEach((button, index) => button.addEventListener('click', () => transport.setSelection(mixer.selectedId,
  { gateUserId: USER_PATTERN_IDS[index]! })));
pitchUserButtons.forEach((button, index) => button.addEventListener('click', () => transport.setSelection(mixer.selectedId,
  { pitchUserId: USER_PATTERN_IDS[index]! })));

for (const id of ['osc1', 'osc2'] as const) {
  requireElement<HTMLSelectElement>(`#phase-mode-${id}`).addEventListener('change', event => {
    const mode = (event.currentTarget as HTMLSelectElement).value as 'sync' | 'free';
    selectedChannel()?.setPhaseMode(mode);
    setValue(`#phase-mode-${id === 'osc1' ? 'osc2' : 'osc1'}`, mode);
  });
}

requireElement<HTMLSelectElement>('#osc1-type').addEventListener('change', async (event) => {
  await selectedChannel()?.setOsc1Type((event.currentTarget as HTMLSelectElement).value as OscSourceType);
  refreshDetuneReadouts();
});
requireElement<HTMLInputElement>('#osc1-frequency').addEventListener('change', () => {
  selectedChannel()?.setOsc1Frequency(numberValue('#osc1-frequency'));
  refreshDetuneReadouts();
});
requireElement<HTMLSelectElement>('#osc2-type').addEventListener('change', async (event) => {
  await selectedChannel()?.setOsc2Type((event.currentTarget as HTMLSelectElement).value as OscSourceType);
  refreshDetuneReadouts();
});
requireElement<HTMLInputElement>('#osc2-frequency').addEventListener('change', () => {
  selectedChannel()?.setOsc2Frequency(numberValue('#osc2-frequency'));
  refreshDetuneReadouts();
});
requireElement<HTMLInputElement>('#osc1-duty').addEventListener('change', () => {
  selectedChannel()?.setOsc1DutyRatio(numberValue('#osc1-duty') / 100);
});
requireElement<HTMLInputElement>('#osc2-duty').addEventListener('change', () => {
  selectedChannel()?.setOsc2DutyRatio(numberValue('#osc2-duty') / 100);
});

for (const id of ['penv-start', 'penv-attack-level', 'penv-sustain-level', 'penv-release-level',
  'penv-attack-time', 'penv-decay-time', 'penv-release-time', 'penv-scale']) {
  requireElement<HTMLInputElement>(`#${id}`).addEventListener('change', applyPitchEnvelope);
}
requireElement<HTMLSelectElement>('#penv-release-timing').addEventListener('change', applyPitchEnvelope);
requireElement<HTMLSelectElement>('#penv-mode').addEventListener('change', applyPitchEnvelope);
requireElement<HTMLSelectElement>('#penv-curve').addEventListener('change', applyPitchEnvelope);

requireElement<HTMLSelectElement>('#mod-mode').addEventListener('change', (event) => {
  const mode = (event.currentTarget as HTMLSelectElement).value as ModMode;
  selectedChannel()?.setModMode(mode);
  updateModReadout(mode);
  refreshBlockSwitches();
});
requireElement<HTMLInputElement>('#am-depth').addEventListener('change', () => {
  selectedChannel()?.setAmDepth(numberValue('#am-depth') / 100);
});
requireElement<HTMLInputElement>('#am-offset').addEventListener('change', () => {
  selectedChannel()?.setAmOffset(numberValue('#am-offset'));
});
requireElement<HTMLInputElement>('#fm-depth').addEventListener('change', () => {
  selectedChannel()?.setFmDepthCent(numberValue('#fm-depth'));
});
requireElement<HTMLSelectElement>('#filter2-route').addEventListener('change', event => {
  const route = (event.currentTarget as HTMLSelectElement).value as Filter2Route;
  selectedChannel()?.setFilter2Route(route);
  requireElement<HTMLElement>('.cutoff-depth-control').hidden = route !== 'filter1-cutoff';
  updateModReadout(requireElement<HTMLSelectElement>('#mod-mode').value as ModMode);
  refreshBlockSwitches(); signalMap.refresh();
});
requireElement<HTMLInputElement>('#filter1-cutoff-depth').addEventListener('change', () => {
  selectedChannel()?.setFilter1CutoffDepthCent(numberValue('#filter1-cutoff-depth'));
});

function wireFilter(index: 1 | 2): void {
  const typeElement = requireElement<HTMLSelectElement>(`#filter${index}-type`);
  const orderElement = requireElement<HTMLSelectElement>(`#filter${index}-order`);
  const applyStructure = async (): Promise<void> => {
    const type = typeElement.value as FilterType;
    const order = Number(orderElement.value) as FilterOrder;
    if (index === 1) await selectedChannel()?.setFilter1Structure(type, order);
    else await selectedChannel()?.setFilter2Structure(type, order);
    refreshBlockSwitches();
  };
  typeElement.addEventListener('change', applyStructure);
  orderElement.addEventListener('change', applyStructure);

  requireElement<HTMLInputElement>(`#filter${index}-frequency`).addEventListener('change', () => {
    const hz = numberValue(`#filter${index}-frequency`);
    if (index === 1) selectedChannel()?.setFilter1Frequency(hz);
    else selectedChannel()?.setFilter2Frequency(hz);
  });
  requireElement<HTMLInputElement>(`#filter${index}-q`).addEventListener('change', () => {
    const q = numberValue(`#filter${index}-q`);
    if (index === 1) selectedChannel()?.setFilter1Q(q);
    else selectedChannel()?.setFilter2Q(q);
  });
}
wireFilter(1);
wireFilter(2);

amplitudeEditor.wire(applyAmplitudeEnvelope);
filterEnvelopeEditor.wire((curve, mode, timing) => {
  const channel = selectedChannel(); if (!channel) return;
  const next = { ...filterEnvelopeEditor.read(channel.getSettings().filterEnvelope, curve, mode, timing),
    amountCent: Math.max(channel.getSettings().filterEnvelope.amountWide ? -7200 : -4800,
      Math.min(channel.getSettings().filterEnvelope.amountWide ? 7200 : 4800, numberValue('#fenv-amount'))),
    amountWide: channel.getSettings().filterEnvelope.amountWide };
  channel.setFilterEnvelope(next);
  filterEnvelopeEditor.sync(next, setValue);
});
requireElement<HTMLButtonElement>('#fenv-amount-wide').addEventListener('click', () => {
  const channel = selectedChannel(); if (!channel) return;
  const current = channel.getSettings().filterEnvelope;
  const amountWide = !current.amountWide;
  const amountCent = amountWide ? current.amountCent : Math.max(-4800, Math.min(4800, current.amountCent));
  const input = requireElement<HTMLInputElement>('#fenv-amount');
  input.dataset.sliderMin = String(amountWide ? -7200 : -4800);
  input.dataset.sliderMax = String(amountWide ? 7200 : 4800);
  channel.setFilterEnvelope({ ...current, amountWide, amountCent });
  setValue('#fenv-amount', amountCent);
  requireElement<HTMLButtonElement>('#fenv-amount-wide').setAttribute('aria-pressed', String(amountWide));
});
for (const selector of ['#burst-enabled', '#burst-block-enabled']) {
  requireElement<HTMLButtonElement>(selector).addEventListener('click', () => {
    const channel = selectedChannel(); if (channel) setBurstEnabled(!channel.getSettings().burst.enabled);
  });
}
requireElement<HTMLInputElement>('#burst-count-min').addEventListener('change', () => applyBurstSettings('min'));
requireElement<HTMLInputElement>('#burst-count-max').addEventListener('change', () => applyBurstSettings('max'));
['#burst-pulse-interval', '#burst-pulse-jitter', '#burst-group-period', '#burst-group-jitter'].forEach(selector => {
  requireElement<HTMLInputElement>(selector).addEventListener('change', () => applyBurstSettings());
});
['#ton', '#trepeat'].forEach((selector) => {
  requireElement<HTMLInputElement>(selector).addEventListener('change', applyAutoTrigger);
});

document.querySelectorAll<HTMLButtonElement>('[data-bus-choice]').forEach(button => {
  button.addEventListener('click', () => {
    setSelectedBus(button.dataset.busChoice as BusAssignment);
    refreshEffectControls(); refreshBlockSwitches();
  });
});
requireElement<HTMLInputElement>('#detune-range').addEventListener('change', () => {
  selectedChannel()?.setDetuneRangeCent(numberValue('#detune-range'));
  refreshDetuneReadouts();
});
requireElement<HTMLButtonElement>('#randomize-detune').addEventListener('click', () => {
  selectedChannel()?.randomizeDetune();
  refreshDetuneReadouts();
});
requireElement<HTMLInputElement>('#near-gain').addEventListener('change', () => {
  engine?.setMixGainDb('near', numberValue('#near-gain'));
  requireElement('#near-gain-readout').textContent = `${numberValue('#near-gain').toFixed(1)} dB`;
});
requireElement<HTMLInputElement>('#far-gain').addEventListener('change', () => {
  engine?.setMixGainDb('far', numberValue('#far-gain'));
  requireElement('#far-gain-readout').textContent = `${numberValue('#far-gain').toFixed(1)} dB`;
});
requireElement<HTMLInputElement>('#master-gain').addEventListener('change', () => {
  engine?.setMasterGainDb(numberValue('#master-gain'));
  syncMasterDisplay();
});
function syncMasterDisplay(): void {
  const value = numberValue('#master-gain');
  requireElement('#master-gain-readout').textContent = `${value.toFixed(1)} dB`;
  requireElement('#flow-master').classList.toggle('muted', engine?.isMasterMuted() ?? false);
}

interface EffectUiSlot {
  slot: EffectSlotIndex;
  prefix: string;
  bus?: BusAssignment;
}

const effectUiSlots: EffectUiSlot[] = [
  { slot: 1, prefix: 'fx1' },
  { slot: 2, prefix: 'fx2', bus: 'near' },
  { slot: 3, prefix: 'fx3', bus: 'near' },
  { slot: 2, prefix: 'far-fx2', bus: 'far' },
  { slot: 3, prefix: 'far-fx3', bus: 'far' }
];

const effectInputs: { suffix: string; parameter: EffectParameter; scale: number }[] = [
  { suffix: 'dist-drive', parameter: 'distortionDriveDb', scale: 1 },
  { suffix: 'dist-wet', parameter: 'distortionWet', scale: 100 },
  { suffix: 'delay-time', parameter: 'delayTimeSec', scale: 1000 },
  { suffix: 'delay-feedback', parameter: 'delayFeedback', scale: 100 },
  { suffix: 'delay-wet', parameter: 'delayWet', scale: 100 },
  { suffix: 'chorus-rate', parameter: 'chorusRateHz', scale: 1 },
  { suffix: 'chorus-depth', parameter: 'chorusDepthSec', scale: 1000 },
  { suffix: 'chorus-wet', parameter: 'chorusWet', scale: 100 },
  { suffix: 'reverb-decay', parameter: 'reverbDecaySec', scale: 1 },
  { suffix: 'reverb-wet', parameter: 'reverbWet', scale: 100 }
];

let currentBus: BusAssignment = 'near';
function selectedBus(): BusAssignment { return currentBus; }
function setSelectedBus(bus: BusAssignment): void {
  currentBus = bus;
  document.querySelectorAll<HTMLButtonElement>('[data-bus-choice]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.busChoice === bus));
  });
}

function effectSettings(slot: EffectSlotIndex, bus?: BusAssignment): EffectSlotSettings {
  if (!engine || (slot === 1 && !selectedChannel())) return DEFAULT_EFFECT_SLOT_SETTINGS;
  return slot === 1 ? selectedChannel()!.getFx1Settings() : engine.getBusEffectSettings(bus!, slot);
}

function refreshEffectControls(only?: EffectUiSlot): void {
  const bus = selectedBus();
  setSelectedBus(bus);
  for (const uiSlot of only ? [only] : effectUiSlots) {
    const settings = effectSettings(uiSlot.slot, uiSlot.bus);
    setValue(`#${uiSlot.prefix}-type`, settings.type);
    for (const input of effectInputs) setValue(`#${uiSlot.prefix}-${input.suffix}`, settings[input.parameter] * input.scale);
    const label = document.querySelector(`[data-effect-slot="${uiSlot.prefix}"] [data-effect-label]`);
    if (label) label.textContent = uiSlot.slot === 1
      ? 'Timbre / FX1' : `${uiSlot.bus === 'near' ? 'Near' : 'Far'} / FX${uiSlot.slot}`;
  }
  updateAllEffectParamVisibility();
  refreshEditingNodes();
}

function updateEffectParamVisibility(uiSlot: EffectUiSlot): void {
  const select = requireElement<HTMLSelectElement>(`#${uiSlot.prefix}-type`);
  const fieldset = requireElement<HTMLElement>(`[data-effect-slot="${uiSlot.prefix}"]`);
  fieldset.querySelectorAll<HTMLElement>('[data-effect]').forEach((group) => {
    const active = group.dataset.effect === select.value;
    group.classList.toggle('active', active);
    group.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.disabled = !active || engine === null || loadingSession || (uiSlot.slot === 1 && !selectedChannel());
    });
  });
}

function updateAllEffectParamVisibility(): void {
  effectUiSlots.forEach(updateEffectParamVisibility);
}

function wireEffectSlot(uiSlot: EffectUiSlot): void {
  const { slot, prefix } = uiSlot;
  const type = requireElement<HTMLSelectElement>(`#${prefix}-type`);
  type.addEventListener('change', async () => {
    if (slot === 1) await selectedChannel()?.setFx1Type(type.value as EffectType);
    else await engine?.setBusEffectType(uiSlot.bus!, slot, type.value as EffectType);
    refreshEffectControls(uiSlot);
    refreshBlockSwitches();
    signalMap.refresh();
  });
  for (const input of effectInputs) {
    const selector = `#${prefix}-${input.suffix}`;
    requireElement<HTMLInputElement>(selector).addEventListener('change', () => {
      const value = numberValue(selector) / input.scale;
      if (slot === 1) selectedChannel()?.setFx1Parameter(input.parameter, value);
      else engine?.setBusEffectParameter(uiSlot.bus!, slot, input.parameter, value);
    });
  }
}
effectUiSlots.forEach(wireEffectSlot);
updateAllEffectParamVisibility();

function syncUiFromTimbre(timbre: TimbreDocument): void {
  const ch = timbre.settings;
  setValue('#osc1-type', ch.osc1.sourceType);
  setValue('#osc1-frequency', ch.osc1.baseFrequencyHz);
  setValue('#osc1-duty', Number((ch.osc1.dutyRatio * 100).toFixed(1)));
  setValue('#osc2-type', ch.osc2.sourceType);
  setValue('#osc2-frequency', ch.osc2.baseFrequencyHz);
  setValue('#osc2-duty', Number((ch.osc2.dutyRatio * 100).toFixed(1)));
  setValue('#phase-mode-osc1', ch.phaseMode);
  setValue('#phase-mode-osc2', ch.phaseMode);
  setValue('#penv-start', ch.pitchEnvelope.start * 100);
  setValue('#penv-attack-level', ch.pitchEnvelope.attack * 100);
  setValue('#penv-sustain-level', ch.pitchEnvelope.sustain * 100);
  setValue('#penv-release-level', ch.pitchEnvelope.release * 100);
  setValue('#penv-attack-time', ch.pitchEnvelope.attackSec * 1000);
  setValue('#penv-decay-time', ch.pitchEnvelope.decaySec * 1000);
  setValue('#penv-release-time', ch.pitchEnvelope.releaseSec * 1000);
  setValue('#penv-scale', ch.pitchEnvelope.scale);
  setValue('#penv-release-timing', ch.pitchEnvelope.releaseTiming);
  setValue('#penv-mode', ch.pitchEnvelope.mode);
  setValue('#penv-curve', ch.pitchEnvelope.curve);
  syncPitchEnvelopeGuide(requireElement<HTMLElement>('#penv-shape-guide'), ch.pitchEnvelope.curve);
  setValue('#mod-mode', ch.mod.mode);
  setValue('#am-depth', ch.mod.amDepth * 100);
  setValue('#am-offset', ch.mod.amOffset);
  setValue('#fm-depth', ch.mod.fmDepthCent);
  setValue('#filter1-type', ch.filter1.type);
  setValue('#filter1-order', ch.filter1.order);
  setValue('#filter1-frequency', ch.filter1.frequencyHz);
  setValue('#filter1-q', ch.filter1.q);
  setValue('#filter2-type', ch.filter2.type);
  setValue('#filter2-order', ch.filter2.order);
  setValue('#filter2-frequency', ch.filter2.frequencyHz);
  setValue('#filter2-q', ch.filter2.q);
  setValue('#filter2-route', ch.filter2Route);
  setValue('#filter1-cutoff-depth', ch.filter1CutoffDepthCent);
  requireElement<HTMLElement>('.cutoff-depth-control').hidden = ch.filter2Route !== 'filter1-cutoff';
  amplitudeEditor.sync(ch.ampEnvelope, setValue);
  filterEnvelopeEditor.sync(ch.filterEnvelope, setValue);
  const fenvAmount = requireElement<HTMLInputElement>('#fenv-amount');
  fenvAmount.dataset.sliderMin = String(ch.filterEnvelope.amountWide ? -7200 : -4800);
  fenvAmount.dataset.sliderMax = String(ch.filterEnvelope.amountWide ? 7200 : 4800);
  setValue('#fenv-amount', ch.filterEnvelope.amountCent);
  requireElement<HTMLButtonElement>('#fenv-amount-wide').setAttribute('aria-pressed', String(ch.filterEnvelope.amountWide));
  setValue('#burst-count-min', ch.burst.pulseCountMin);
  setValue('#burst-count-max', ch.burst.pulseCountMax);
  setValue('#burst-pulse-interval', ch.burst.pulseIntervalSec * 1000);
  setValue('#burst-pulse-jitter', ch.burst.pulseIntervalJitter * 100);
  setValue('#burst-group-period', ch.burst.groupPeriodSec * 1000);
  setValue('#burst-group-jitter', ch.burst.groupPeriodJitter * 100);
  refreshBurstControls();
  setValue('#ton', ch.autoTrigger.tonSec * 1000);
  refreshAutoTriggerControls();
  setValue('#detune-range', timbre.detuneRangeCent);

  refreshEffectControls();

  updateModReadout(ch.mod.mode);
  updateAllEffectParamVisibility();
  refreshDetuneReadouts();
  refreshBlockSwitches();
}

const exportPatchButton = requireElement<HTMLButtonElement>('#export-patch');
const importPatchButton = requireElement<HTMLButtonElement>('#import-patch');
const patchFileInput = requireElement<HTMLInputElement>('#patch-file');
const demoMenuButton = requireElement<HTMLButtonElement>('#demo-menu-button');
const demoMenu = requireElement<HTMLElement>('#demo-menu');

function downloadJson(document: { name: string }, suffix: string): void {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = `${document.name.replace(/[^a-zA-Z0-9_\-ぁ-んァ-ヶ一-龠]+/g, '_') || 'KOROGI'}_${suffix}.json`;
  anchor.click(); URL.revokeObjectURL(url);
}
function syncSelectedSource(): void {
  requireElement('#selected-source').textContent = `Editing · ${mixer.selectedId}${selectedChannel() ? '' : ' · Empty'}`;
  engine?.setDirectMonitorId(mixer.selectedId);
  if (engine && selectedChannel()) syncUiFromTimbre(engine.createTimbre(mixer.selectedId));
  else { refreshEffectControls(); refreshBlockSwitches(); refreshDetuneReadouts(); }
  setAudioControlsEnabled(engine !== null && !loadingSession);
  recorder.refresh();
  syncTransportControls();
  functionEditor?.restore(engine?.getChannel(mixer.selectedId) ? engine.getEditorLayout(mixer.selectedId) : DEFAULT_EDITOR_LAYOUT);
  refreshEditingNodes();
  signalMap.showSlot(mixer.selectedId);
}
function syncCommonMix(): void {
  if (!engine) return;
  setValue('#near-gain', engine.getBusSettings('near').gainDb);
  setValue('#far-gain', engine.getBusSettings('far').gainDb);
  setValue('#master-gain', engine.getMasterGainDb());
  const direct = engine.getMasterInputMode() === 'fx1-direct';
  requireElement('#master-input-readout').textContent = direct ? 'FX1 MON' : 'COMMON SPACE';
  requireElement('#fx1-monitor-toggle').setAttribute('aria-pressed', String(direct));
  for (const bus of ['near', 'far'] as const) {
    requireElement(`#${bus}-gain-readout`).textContent = `${engine.getBusSettings(bus).gainDb.toFixed(1)} dB`;
  }
  syncMasterDisplay();
  setValue('#crossfade', engine.getCrossfade() * 100);
  requireElement('#crossfade-readout').textContent = `${Math.round(engine.getCrossfade() * 100)}% Far`;
  requireElement('#master-mute').setAttribute('aria-pressed', String(engine.isMasterMuted()));
  signalMap.refresh();
}
exportPatchButton.addEventListener('click', () => {
  if (!engine) return;
  const session = engine.createSession(requireElement<HTMLInputElement>('#patch-name').value);
  downloadJson(session, 'session'); patchStatus.textContent = `Exported: ${session.name}`;
});
function saveTimbre(id: string): void {
  if (!engine?.getChannel(id)) return;
  const timbre = engine.createTimbre(id); downloadJson(timbre, 'timbre');
  patchStatus.textContent = `Exported timbre: ${timbre.name}`;
}
requireElement<HTMLInputElement>('#crossfade').addEventListener('change', () => { engine?.setCrossfade(numberValue('#crossfade') / 100); syncCommonMix(); });
requireElement<HTMLButtonElement>('#master-mute').addEventListener('click', () => { if (engine) engine.setMasterMuted(!engine.isMasterMuted()); syncCommonMix(); });
importPatchButton.addEventListener('click', () => patchFileInput.click());
async function loadSessionSource(source: string, loadingMessage: string, loadedPrefix: string, errorPrefix: string): Promise<void> {
  if (!engine || loadingSession) return;
  try {
    patchStatus.textContent = loadingMessage;
    const raw = JSON.parse(source) as { channels?: Array<{ timbre?: { formatVersion?: string } | null }> };
    const oldPitchEnvelope = raw.channels?.some(channel => channel.timbre && !['KOROGI-Lab/timbre-v10', 'KOROGI-Lab/timbre-v11', 'KOROGI-Lab/timbre-v12', 'KOROGI-Lab/timbre-v13', 'KOROGI-Lab/timbre-v14', 'KOROGI-Lab/timbre-v15', 'KOROGI-Lab/timbre-v16', 'KOROGI-Lab/timbre-v17'].includes(channel.timbre.formatVersion ?? '')) ?? false;
    const session = parseLabSession(source);
    songTransport.stop();
    transport.stopAll();
    recorder.cancel();
    loadingSession = true;
    mixer.setEnabled(false, false);
    // Disable gestures without releasing them until the candidate commits.
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-audio-control], .mixer-slot button, .mixer-slot input').forEach(control => { control.disabled = true; });
    await engine.applySession(session);
    mixer.manual.releaseAll(); mixer.refresh();
    setValue('#patch-name', session.name); syncCommonMix(); syncSelectedSource(); syncSongSettings();
    patchStatus.textContent = `${loadedPrefix}: ${session.name}${oldPitchEnvelope ? ' · Legacy PEnv Amount/Time was ignored; new PEnv is neutral.' : ''}`;
  } catch (error) { patchStatus.textContent = `${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`; }
  finally { loadingSession = false; patchFileInput.value = ''; setAudioControlsEnabled(true); }
}
patchFileInput.addEventListener('change', async () => {
  const file = patchFileInput.files?.[0]; if (!file || !engine || loadingSession) return;
  try {
    await loadSessionSource(await file.text(), `Loading: ${file.name} ...`, 'Loaded', 'Import failed');
  } catch (error) {
    patchStatus.textContent = `Import failed: ${error instanceof Error ? error.message : String(error)}`;
    patchFileInput.value = '';
  }
});

function setDemoMenuOpen(open: boolean, focusFirst = false): void {
  demoMenu.hidden = !open;
  demoMenuButton.setAttribute('aria-expanded', String(open));
  if (open && focusFirst) demoMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
}

demoMenuButton.addEventListener('click', () => setDemoMenuOpen(demoMenu.hidden));
demoMenuButton.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown') return;
  event.preventDefault();
  setDemoMenuOpen(true, true);
});
demoMenu.addEventListener('keydown', (event) => {
  const items = [...demoMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  let next = current;
  if (event.key === 'ArrowDown') next = (current + 1) % items.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'Escape') {
    event.preventDefault(); setDemoMenuOpen(false); demoMenuButton.focus(); return;
  } else return;
  event.preventDefault(); items[next]?.focus();
});
demoMenu.querySelectorAll<HTMLButtonElement>('[data-demo-session]').forEach((button) => {
  button.addEventListener('click', () => {
    const demo = DEMO_SESSIONS.find(candidate => candidate.id === button.dataset.demoSession);
    if (!demo) return;
    setDemoMenuOpen(false);
    void loadSessionSource(demo.source, `Loading demo: ${demo.name} ...`, 'Loaded demo', 'Demo load failed');
  });
});
document.addEventListener('pointerdown', (event) => {
  if (!(event.target instanceof Node) || demoMenu.hidden || requireElement('.demo-picker').contains(event.target)) return;
  setDemoMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || demoMenu.hidden) return;
  setDemoMenuOpen(false); demoMenuButton.focus();
});

type FlowBlock = ChannelBlock | 'mixGain' | 'fx1' | 'fx2' | 'fx3';

function makeBlockSwitch(block: FlowBlock, label: string, bus?: BusAssignment): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'flow-toggle';
  button.dataset.blockToggle = block;
  if (bus) button.dataset.bus = bus;
  button.dataset.audioControl = '';
  button.setAttribute('aria-label', `${label} ON/OFF`);
  button.addEventListener('click', () => {
    if (!engine) return;
    const targetBus = bus ?? selectedBus();
    const enabled = button.getAttribute('aria-pressed') !== 'true';
    if (block === 'mixGain') engine.setMixGainEnabled(targetBus, enabled);
    else if (block === 'fx1') selectedChannel()?.setFx1Enabled(enabled);
    else if (block === 'fx2' || block === 'fx3') engine.setBusEffectEnabled(targetBus, block === 'fx2' ? 2 : 3, enabled);
    else selectedChannel()?.setBlockEnabled(block as ChannelBlock, enabled);
    refreshBlockSwitches();
    signalMap.refresh();
  });
  return button;
}

function refreshBlockSwitches(): void {
  const bus = selectedBus();
  const blocks = selectedChannel()?.getSettings().blocksEnabled;
  document.querySelectorAll<HTMLButtonElement>('[data-block-toggle]').forEach((button) => {
    const block = button.dataset.blockToggle as FlowBlock;
    const targetBus = (button.dataset.bus as BusAssignment | undefined) ?? bus;
    const fx = block === 'fx1' ? selectedChannel()?.getFx1Settings() : block === 'fx2' || block === 'fx3' ? engine?.getBusEffectSettings(targetBus, block === 'fx2' ? 2 : 3) : undefined;
    const enabled = block === 'mixGain' ? engine?.isMixGainEnabled(targetBus) ?? true
      : block.startsWith('fx') ? fx?.enabled ?? true
      : blocks?.[block as ChannelBlock] ?? true;
    const unavailable = block === 'mod' && requireElement<HTMLSelectElement>('#filter2-route').value === 'filter1-cutoff';
    button.textContent = unavailable ? 'N/A' : enabled ? 'ON' : 'OFF';
    button.setAttribute('aria-pressed', String(enabled));
    button.title = unavailable ? 'FILTER2 is routed to F1 CUTOFF; MOD settings are retained'
      : block === 'aenv' ? 'OFF: unity bypass / continuous sound' : 'ON/OFF (settings retained)';
    const node = button.parentElement?.querySelector<HTMLButtonElement>('[data-flow-block]');
    if (node) {
      node.classList.toggle('enabled', enabled && !unavailable);
      node.classList.toggle('bypassed', !enabled || unavailable);
      node.title = unavailable ? 'MOD is outside the current FILTER2 route' : enabled ? 'ON' : 'OFF';
      if (block === 'fx1') node.textContent = 'FX1';
    }
  });
  if (selectedChannel() && !blocks?.mod && requireElement<HTMLSelectElement>('#filter2-route').value === 'mod') modReadout.textContent = 'MOD bypassed (mode and depth retained)';
  else updateModReadout(requireElement<HTMLSelectElement>('#mod-mode').value as ModMode);
  syncModAvailability();
}

document.querySelectorAll<HTMLButtonElement>('[data-flow-block]').forEach((node) => {
  const wrapper = document.createElement('span');
  wrapper.className = 'signal-block';
  wrapper.dataset.flowBlockWrapper = node.dataset.flowBlock;
  node.replaceWith(wrapper);
  wrapper.append(node);
  if (node.dataset.flowBlock === 'fx1') {
    const monitor = document.createElement('button');
    monitor.id = 'fx1-monitor-toggle';
    monitor.type = 'button';
    monitor.className = 'fx1-monitor-toggle';
    monitor.dataset.audioControl = '';
    monitor.textContent = 'MON';
    monitor.setAttribute('aria-label', 'Monitor selected Timbre FX1 directly at Master');
    monitor.setAttribute('aria-pressed', 'false');
    monitor.addEventListener('click', () => {
      if (!engine) return;
      engine.setMasterInputMode(engine.getMasterInputMode() === 'fx1-direct' ? 'common-space' : 'fx1-direct');
      syncCommonMix();
    });
    wrapper.append(monitor);
  }
  wrapper.append(makeBlockSwitch(node.dataset.flowBlock as FlowBlock, node.textContent ?? '', node.dataset.bus as BusAssignment | undefined));
});

const panelSwitches: Record<string, ChannelBlock> = {
  'OSC1 / Carrier': 'osc1', 'OSC2 / Modulator': 'osc2', PEnv: 'penv', 'MOD Mode / Depth': 'mod',
  'FILTER1 / Audio Path': 'filter1', 'FILTER2 / Modulation Path': 'filter2', 'AEnv / ADSR': 'aenv', 'FEnv / ADSR': 'fenv'
};
document.querySelectorAll<HTMLElement>('legend').forEach((legend) => {
  const label = legend.textContent?.trim() ?? '';
  const block = panelSwitches[label];
  if (block) legend.append(makeBlockSwitch(block, label));
});
for (const slot of effectUiSlots) {
  requireElement<HTMLElement>(`[data-effect-slot="${slot.prefix}"] legend`)
    .append(makeBlockSwitch(`fx${slot.slot}`, `FX${slot.slot}`, slot.bus));
}
for (const bus of ['near', 'far'] as const) {
  requireElement<HTMLInputElement>(`#${bus}-gain`).parentElement?.append(makeBlockSwitch('mixGain', `${bus} Gain`, bus));
}

document.querySelectorAll<HTMLInputElement>('input[data-numeric-min]').forEach((input) => {
  numericSliders.set(input, new NumericSliderControl(input));
});

functionEditor = new FunctionEditor(requireElement('.panel-deck'), layout => {
  if (engine?.getChannel(mixer.selectedId)) engine.setEditorLayout(mixer.selectedId, layout);
  activePathElement.textContent = 'Viewing: ' + (layout.flat().map(id => id.toUpperCase()).join(' / ') || 'Select a block');
}, () => recorder.releaseScreenTrigger());
commonEditor = new CommonSpaceEditor(requireElement('.panel-deck'), commonCards, () => {
  activePathElement.textContent = 'Viewing: COMMON SPACE · ' + commonEditor?.viewingLabel;
});
setSelectedBus('near');
setAudioControlsEnabled(false);
refreshBlockSwitches();
showPanel('sources');
updateModReadout('am');
refreshStatus();
refreshDetuneReadouts();
setGateIndicator(gateState);

const signalMap = new SignalMap(requireElement('.signal-canvas'), () => engine, mixer);
try {
  const context = new AudioContext();
  try { validateParameterRanges(P, context.sampleRate); }
  catch (error) { void context.close(); throw error; }
  engine = new AudioEngine(context, {
    formatVersion: 'KOROGI-Lab/session-v20', name: 'KOROGI Session', savedAt: '',
    channels: LAB_SLOT_IDS.map(id => ({ id, ...DEFAULT_CHANNEL_MIX, timbre: id === '1' ? defaultTimbre() : null })),
    near: defaultBus(), far: defaultBus(), crossfade: P.crossfade.defaultValue / 100, masterGainDb: P['master-gain'].defaultValue, masterMuted: false, song: defaultSongSettings()
  });
  engine.context.addEventListener('statechange', refreshStatus);
  mixer.refresh();
  setAudioControlsEnabled(true);
  syncCommonMix(); syncSelectedSource(); syncSongSettings();
  refreshStatus();
} catch (error) {
  patchStatus.textContent = `Audio engine is unavailable: ${error instanceof Error ? error.message : String(error)}`;
  audioErrorElement.textContent = `Initialization stopped: ${error instanceof Error ? error.message : String(error)}`;
  audioErrorElement.hidden = false;
  refreshStatus();
}
// Mixer refreshes cover level, mute, send, load, clear and source selection.
requireElement('#mixer-slots').addEventListener('input', () => signalMap.refresh());
requireElement('#mixer-slots').addEventListener('click', () => signalMap.refresh());
requireElement('#mixer-slots').addEventListener('change', () => signalMap.refresh());
document.addEventListener('change', () => signalMap.refresh());
