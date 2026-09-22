import {
  DEFAULT_CHANNEL_SETTINGS,
  VOICE_FX_INPUT_DB,
  LIMITS,
  PARAM_SMOOTH_SEC,
  STRUCTURE_FADE_SEC
} from '../constants';
import { AmplitudeEnvelope } from '../dsp/AmplitudeEnvelope';
import { FilterChain } from '../dsp/FilterChain';
import { PitchEnvelopeControl } from '../dsp/PitchEnvelopeControl';
import { SourceUnit } from '../dsp/SourceUnit';
import { clamp, dbToGain, smoothAudioParam } from '../dsp/params';
import { WhiteNoiseFactory } from '../dsp/WhiteNoiseFactory';
import { AutoTriggerScheduler } from '../scheduler/AutoTriggerScheduler';
import { BurstScheduler } from '../scheduler/BurstScheduler';
import { EffectSlot } from '../effects/EffectSlot';
import type {
  AmplitudeEnvelopeSettings,
  AutoTriggerSettings,
  BurstSettings,
  ChannelBlock,
  ChannelSettings,
  EffectParameter,
  EffectSlotSettings,
  EffectType,
  FilterOrder,
  Filter2Route,
  FilterType,
  GateScheduleEvent,
  ModMode,
  PitchEnvelopeSettings,
  OscSourceType
} from '../types';

type BaseGateEvent = { kind: 'on'; time: number; amp: AmplitudeEnvelopeSettings; pitch: PitchEnvelopeSettings }
  | { kind: 'off'; time: number };

function cloneDefaults(): ChannelSettings {
  return structuredClone(DEFAULT_CHANNEL_SETTINGS);
}

export class ChannelSynth {
  readonly output: GainNode;

  private readonly pEnv: PitchEnvelopeControl;
  private readonly amDepthGain: GainNode;
  private readonly fmDepthGain: GainNode;
  private readonly modRouteGain: GainNode;
  private readonly cutoffLimiter: WaveShaperNode;
  private readonly cutoffDepthGain: GainNode;
  private readonly amGain: GainNode;
  private readonly filter1: FilterChain;
  private readonly filter2: FilterChain;
  private readonly ampEnvelope: AmplitudeEnvelope;
  private readonly structureFade: GainNode;
  private readonly fxInputGain: GainNode;
  private readonly fx1: EffectSlot;
  private readonly osc1: SourceUnit;
  private readonly osc2: SourceUnit;
  private readonly scheduler: AutoTriggerScheduler;
  private readonly burstScheduler: BurstScheduler;
  private readonly gateListeners = new Set<(event: GateScheduleEvent) => void>();

  private settings: ChannelSettings;
  private detuneNormalized: number;
  private detuneRangeCent = 0;
  private manualGateActive = false;
  private disposed = false;

  constructor(
    private readonly context: AudioContext,
    noiseFactory: WhiteNoiseFactory,
    initial: ChannelSettings = cloneDefaults(),
    detuneNormalized = Math.random() * 2 - 1,
    sourceId = 'source'
  ) {
    this.settings = structuredClone(initial);
    this.settings.osc1.baseFrequencyHz = Math.round(clamp(this.settings.osc1.baseFrequencyHz, LIMITS.osc1Hz.min, LIMITS.osc1Hz.max));
    this.settings.osc2.baseFrequencyHz = clamp(this.settings.osc2.baseFrequencyHz, LIMITS.osc2Hz.min, LIMITS.osc2Hz.max);
    this.settings.osc1.dutyRatio = clamp(this.settings.osc1.dutyRatio, LIMITS.dutyRatio.min, LIMITS.dutyRatio.max);
    this.settings.osc2.dutyRatio = clamp(this.settings.osc2.dutyRatio, LIMITS.dutyRatio.min, LIMITS.dutyRatio.max);
    this.settings.blocksEnabled = { ...DEFAULT_CHANNEL_SETTINGS.blocksEnabled, ...initial.blocksEnabled };
    this.detuneNormalized = clamp(detuneNormalized, -1, 1);

    this.pEnv = new PitchEnvelopeControl(context);
    this.pEnv.setSettings(
      this.settings.pitchEnvelope.amount,
      this.settings.pitchEnvelope.transitionTimeSec
    );

    this.amDepthGain = context.createGain();
    this.amDepthGain.gain.value = 0;

    this.fmDepthGain = context.createGain();
    this.fmDepthGain.gain.value = 0;

    this.osc1 = new SourceUnit(
      context,
      noiseFactory,
      this.pEnv.output,
      this.settings.osc1.sourceType,
      this.settings.osc1.baseFrequencyHz,
      this.fmDepthGain,
      this.settings.osc1.dutyRatio
    );
    this.osc2 = new SourceUnit(
      context,
      noiseFactory,
      this.pEnv.output,
      this.settings.osc2.sourceType,
      this.settings.osc2.baseFrequencyHz,
      undefined,
      this.settings.osc2.dutyRatio
    );

    this.filter2 = new FilterChain(context, this.settings.filter2);
    this.osc2.output.connect(this.filter2.input);
    this.modRouteGain = context.createGain();
    this.modRouteGain.gain.value = this.settings.filter2Route === 'mod' ? 1 : 0;
    this.filter2.output.connect(this.modRouteGain);
    this.modRouteGain.connect(this.amDepthGain);
    this.modRouteGain.connect(this.fmDepthGain);
    // Resonant Filter2 can exceed unity; bound the control signal before cent scaling.
    this.cutoffLimiter = context.createWaveShaper();
    const curve = new Float32Array(4096);
    for (let i = 0; i < curve.length; i += 1) curve[i] = Math.tanh(3 * (2 * i / (curve.length - 1) - 1));
    this.cutoffLimiter.curve = curve;
    this.filter2.output.connect(this.cutoffLimiter);
    this.cutoffDepthGain = context.createGain();
    this.cutoffDepthGain.gain.value = this.settings.filter2Route === 'filter1-cutoff' ? this.settings.filter1CutoffDepthCent : 0;
    this.cutoffLimiter.connect(this.cutoffDepthGain);

    this.amGain = context.createGain();
    this.amGain.gain.value = 1;
    this.amDepthGain.connect(this.amGain.gain);
    this.osc1.output.connect(this.amGain);

    this.filter1 = new FilterChain(context, this.settings.filter1);
    this.amGain.connect(this.filter1.input);
    this.filter1.connectDetune(this.cutoffDepthGain);

    this.ampEnvelope = new AmplitudeEnvelope(context, this.settings.ampEnvelope);
    this.filter1.output.connect(this.ampEnvelope.node);

    this.structureFade = context.createGain();
    this.structureFade.gain.value = 1;
    this.ampEnvelope.node.connect(this.structureFade);

    this.fxInputGain = context.createGain();
    this.fxInputGain.gain.value = dbToGain(VOICE_FX_INPUT_DB);
    this.structureFade.connect(this.fxInputGain);

    this.fx1 = new EffectSlot(context, `${sourceId}-fx1`, this.settings.fx1);
    this.fxInputGain.connect(this.fx1.input);
    this.output = context.createGain();
    this.output.gain.value = 1;
    this.fx1.output.connect(this.output);

    this.burstScheduler = new BurstScheduler(context, {
      pulse: (time, displayOffTime) => this.scheduleBurstPulse(time, displayOffTime),
      cancelFrom: (time) => this.cancelBurstPulsesFrom(time)
    }, this.settings.burst);

    this.scheduler = new AutoTriggerScheduler(
      context,
      {
        gateOn: (time) => this.scheduleInputGateOn(time),
        gateOff: (time) => this.scheduleInputGateOff(time)
      },
      this.settings.autoTrigger
    );
    this.refreshAutoSchedulerMode();
    this.applyModMode(context.currentTime, false);
    this.applyGlobalDetune(context.currentTime);
    for (const block of Object.keys(this.settings.blocksEnabled) as ChannelBlock[]) {
      if (!this.settings.blocksEnabled[block]) this.setBlockEnabled(block, false);
    }
  }

  gateOn(time = this.context.currentTime): void {
    this.assertUsable();
    if (this.scheduler.isRunning()) {
      this.scheduler.stop(false);
      this.discardFutureBaseGates();
      this.emitGate({ kind: 'reset', time: this.context.currentTime });
    }
    this.manualGateActive = true;
    this.scheduleInputGateOn(time);
  }

  gateOff(time = this.context.currentTime): void {
    this.assertUsable();
    // A pointer/key release from a superseded Manual Gate must not terminate
    // an Auto Play note that has since taken ownership of the envelope.
    if (!this.manualGateActive) return;
    this.manualGateActive = false;
    this.scheduleInputGateOff(time);
  }

  /** Stop a recorded pattern, including gates already submitted in lookahead. */
  cancelScheduledGates(): void {
    const now = this.context.currentTime;
    this.scheduler.stop(false);
    if (this.burstActive()) {
      this.manualGateActive = false;
      this.baseGateEvents = [{ kind: 'off', time: now }];
      if (!this.triggerHeld) this.burstScheduler.gateOff(now);
      return;
    }
    this.cancelPhaseResetsFrom(now);
    this.manualGateActive = false;
    this.baseGateEvents = [{ kind: 'off', time: now }];
    this.ampEnvelope.preserveCurrent(now);
    if (!this.triggerHeld) this.ampEnvelope.gateOff(now);
    this.pEnv.reset(now);
    this.emitGate({ kind: 'reset', time: now });
    if (this.triggerHeld) this.emitGate({ kind: 'on', time: now });
  }

  /** Replace only events at or after a future loop boundary. */
  cancelScheduledGatesFrom(time: number): void {
    const boundary = Math.max(time, this.context.currentTime);
    if (this.burstActive()) {
      this.baseGateEvents = this.baseGateEvents.filter(event => event.time < boundary);
      this.rememberBaseGate({ kind: 'off', time: boundary });
      if (!this.triggerHeld) this.burstScheduler.gateOff(boundary);
      this.burstScheduler.cancelFrom(boundary);
      return;
    }
    this.cancelPhaseResetsFrom(boundary);
    this.baseGateEvents = this.baseGateEvents.filter(event => event.time < boundary);
    this.ampEnvelope.preserveCurrent(boundary);
    this.pEnv.reset(boundary);
    this.emitGate({ kind: 'cancel', time: boundary });
    this.scheduleGateOff(boundary);
  }

  /** The TRIGGER panel's held Gate overlays Auto or recorded playback. */
  triggerGateOn(): void {
    this.assertUsable();
    if (this.triggerHeld) return;
    const now = this.context.currentTime;
    if (this.burstActive()) {
      const baseOn = this.baseGateIsOn(now);
      this.triggerHeld = true;
      if (!baseOn) this.burstScheduler.gateOn(now);
      return;
    }
    this.triggerHeld = true;
    const future = this.futureBaseGates(now);
    this.emitGate({ kind: 'reset', time: now });
    this.syncPhaseIfSilent(now);
    this.performGateOn(now);
    for (const event of future) {
      if (event.kind === 'on') this.performGateOn(event.time, event.amp, event.pitch);
    }
  }

  triggerGateOff(): void {
    this.assertUsable();
    if (!this.triggerHeld) return;
    const now = this.context.currentTime;
    if (this.burstActive()) {
      this.triggerHeld = false;
      if (!this.baseGateIsOn(now)) this.burstScheduler.gateOff(now);
      return;
    }
    this.triggerHeld = false;
    const future = this.futureBaseGates(now);
    const baseOn = this.baseGateIsOn(now);
    if (baseOn) this.ampEnvelope.preserveCurrent(now);
    else this.ampEnvelope.gateOff(now);
    this.emitGate({ kind: 'reset', time: now });
    if (baseOn) this.emitGate({ kind: 'on', time: now });
    for (const event of future) {
      if (event.kind === 'on') this.performGateOn(event.time, event.amp, event.pitch);
      else this.performGateOff(event.time);
    }
  }

  private baseGateEvents: BaseGateEvent[] = [];
  private triggerHeld = false;

  private futureBaseGates(now: number): BaseGateEvent[] {
    return this.baseGateEvents.filter(event => event.time > now).sort((a, b) => a.time - b.time || (a.kind === 'off' ? -1 : 1));
  }

  private baseGateIsOn(now: number): boolean {
    return [...this.baseGateEvents].filter(event => event.time <= now).sort((a, b) => a.time - b.time || (a.kind === 'off' ? -1 : 1)).at(-1)?.kind === 'on';
  }

  private rememberBaseGate(event: BaseGateEvent): void {
    const now = this.context.currentTime;
    const past = [...this.baseGateEvents].filter(event => event.time <= now).sort((a, b) => a.time - b.time || (a.kind === 'off' ? -1 : 1)).at(-1);
    this.baseGateEvents = [...(past ? [past] : []), ...this.baseGateEvents.filter(event => event.time > now), event];
  }

  private discardFutureBaseGates(): void {
    const now = this.context.currentTime;
    this.baseGateEvents = this.baseGateEvents.filter(event => event.time <= now);
    if (!this.burstActive()) this.cancelPhaseResetsFrom(now);
  }

  private burstActive(): boolean {
    return this.settings.burst.enabled && this.settings.ampEnvelope.mode === 'one-shot';
  }

  private scheduleInputGateOn(time: number): void {
    if (!this.burstActive()) { this.scheduleGateOn(time); return; }
    const wasOn = this.baseGateIsOn(Math.max(this.context.currentTime, time - 1e-9));
    const event: BaseGateEvent = { kind: 'on', time, amp: { ...this.settings.ampEnvelope }, pitch: { ...this.settings.pitchEnvelope } };
    this.rememberBaseGate(event);
    if (!wasOn && !this.triggerHeld) this.burstScheduler.gateOn(time);
  }

  private scheduleInputGateOff(time: number): void {
    if (!this.burstActive()) { this.scheduleGateOff(time); return; }
    this.rememberBaseGate({ kind: 'off', time });
    if (!this.triggerHeld) this.burstScheduler.gateOff(time);
  }

  private scheduleBurstPulse(time: number, displayOffTime: number): void {
    const amp = { ...this.settings.ampEnvelope };
    const pitch = { ...this.settings.pitchEnvelope };
    this.syncPhaseIfSilent(time);
    this.performGateOn(time, amp, pitch);
    this.emitGate({ kind: 'off', time: displayOffTime });
  }

  private cancelBurstPulsesFrom(time: number): void {
    const boundary = Math.max(time, this.context.currentTime);
    this.cancelPhaseResetsFrom(boundary);
    this.ampEnvelope.preserveCurrent(boundary);
    this.pEnv.reset(boundary);
    this.emitGate({ kind: 'cancel', time: boundary });
  }

  private scheduleGateOn(time: number): void {
    const event: BaseGateEvent = { kind: 'on', time, amp: { ...this.settings.ampEnvelope }, pitch: { ...this.settings.pitchEnvelope } };
    this.rememberBaseGate(event);
    this.syncPhaseIfSilent(time);
    this.performGateOn(time, event.amp, event.pitch);
  }

  private syncPhaseIfSilent(time: number): void {
    if (this.settings.phaseMode !== 'sync' || !this.ampEnvelope.isSilentAt(time)) return;
    this.osc1.syncPhaseAt(time); this.osc2.syncPhaseAt(time);
  }

  private cancelPhaseResetsFrom(time: number): void {
    this.osc1.cancelPhaseResetsFrom(time); this.osc2.cancelPhaseResetsFrom(time);
  }

  private performGateOn(time: number, amp = this.settings.ampEnvelope, pitch = this.settings.pitchEnvelope): void {
    const { amount } = this.pEnv.gateOn(time, pitch);
    this.osc1.setActivePitchAmount(amount, time);
    this.osc2.setActivePitchAmount(amount, time);
    this.ampEnvelope.gateOn(time, amp);
    this.emitGate({ kind: 'on', time });
  }

  private scheduleGateOff(time: number): void {
    this.rememberBaseGate({ kind: 'off', time });
    if (!this.triggerHeld) this.performGateOff(time);
  }

  private performGateOff(time: number): void {
    this.ampEnvelope.gateOff(time);
    this.emitGate({ kind: 'off', time });
  }

  trigger(durationSec = this.settings.autoTrigger.tonSec): void {
    const now = this.context.currentTime;
    if (this.scheduler.isRunning()) {
      this.scheduler.stop(false);
      this.emitGate({ kind: 'reset', time: now });
    }
    this.manualGateActive = false;
    this.scheduleInputGateOn(now);
    this.scheduleInputGateOff(now + clamp(durationSec, LIMITS.triggerSec.min, LIMITS.triggerSec.max));
  }

  startAutoTrigger(startAt?: number): void {
    const now = this.context.currentTime;
    this.manualGateActive = false;
    this.discardFutureBaseGates();
    // Cancel held Manual Gate and any previously scheduled one-shot before
    // transferring ownership to Auto Play.
    this.scheduleInputGateOff(now);
    this.emitGate({ kind: 'reset', time: now });
    this.scheduler.start(startAt);
  }

  stopAutoTrigger(): void {
    if (!this.scheduler.isRunning()) return;
    const burst = this.burstActive();
    this.discardFutureBaseGates();
    this.scheduler.stop(true);
    if (!burst) this.ampEnvelope.preserveCurrent(this.context.currentTime);
    this.emitGate({ kind: 'reset', time: this.context.currentTime });
    if (this.triggerHeld) this.emitGate({ kind: 'on', time: this.context.currentTime });
  }

  isAutoTriggerRunning(): boolean {
    return this.scheduler.isRunning();
  }

  addGateScheduleListener(listener: (event: GateScheduleEvent) => void): () => void {
    this.gateListeners.add(listener);
    return () => this.gateListeners.delete(listener);
  }

  setAutoTrigger(settings: AutoTriggerSettings): void {
    this.settings.autoTrigger = { ...settings };
    this.scheduler.setSettings(settings);
  }

  setPhaseMode(mode: ChannelSettings['phaseMode']): void { this.settings.phaseMode = mode; }

  /** Keep the ChannelSynth identity while replacing WebKit-sensitive pre-resume source nodes. */
  restartSourcesAfterContextResume(): void {
    this.assertUsable();
    this.osc1.restartAfterContextResume();
    this.osc2.restartAfterContextResume();
    this.applyGlobalDetune(this.context.currentTime);
  }

  setPitchEnvelope(amount: number, transitionTimeSec: number): void {
    this.settings.pitchEnvelope = { amount, transitionTimeSec };
    this.pEnv.setSettings(amount, transitionTimeSec);
  }

  setAmplitudeEnvelope(settings: AmplitudeEnvelopeSettings): void {
    if (settings.mode !== 'one-shot' && this.settings.burst.enabled) {
      this.setBurstSettings({ ...this.settings.burst, enabled: false });
    }
    this.settings.ampEnvelope = { ...settings };
    this.ampEnvelope.setSettings(settings);
    this.refreshAutoSchedulerMode();
  }

  setBurstSettings(settings: BurstSettings): void {
    const wasActive = this.burstActive();
    const min = Math.round(clamp(settings.pulseCountMin, LIMITS.burstCount.min, LIMITS.burstCount.max));
    const next: BurstSettings = {
      enabled: !!settings.enabled && this.settings.ampEnvelope.mode === 'one-shot',
      pulseCountMin: min,
      pulseCountMax: Math.round(clamp(settings.pulseCountMax, min, LIMITS.burstCount.max)),
      pulseIntervalSec: clamp(settings.pulseIntervalSec, LIMITS.burstPulseIntervalSec.min, LIMITS.burstPulseIntervalSec.max),
      pulseIntervalJitter: clamp(settings.pulseIntervalJitter, LIMITS.burstJitter.min, LIMITS.burstJitter.max),
      groupPeriodSec: clamp(settings.groupPeriodSec, LIMITS.burstGroupPeriodSec.min, LIMITS.burstGroupPeriodSec.max),
      groupPeriodJitter: clamp(settings.groupPeriodJitter, LIMITS.burstJitter.min, LIMITS.burstJitter.max)
    };
    this.settings.burst = next;
    this.burstScheduler.setSettings(next);
    const active = this.burstActive();
    const now = this.context.currentTime;
    if (wasActive && !active) this.burstScheduler.gateOff(now);
    else if (!wasActive && active && (this.baseGateIsOn(now) || this.triggerHeld)) this.burstScheduler.gateOn(now);
    this.refreshAutoSchedulerMode();
  }

  private refreshAutoSchedulerMode(): void {
    this.scheduler?.setMode(this.burstActive() || this.settings.ampEnvelope.mode !== 'one-shot' ? 'gate' : 'one-shot');
  }

  setBlockEnabled(block: ChannelBlock, enabled: boolean): void {
    this.settings.blocksEnabled[block] = enabled;
    switch (block) {
      case 'osc1': this.osc1.setEnabled(enabled); break;
      case 'osc2': this.osc2.setEnabled(enabled); break;
      case 'penv': this.pEnv.setEnabled(enabled); break;
      case 'mod': this.applyModMode(this.context.currentTime, true); break;
      case 'filter1': this.filter1.setEnabled(enabled); break;
      case 'filter2': this.filter2.setEnabled(enabled); break;
      case 'aenv': this.ampEnvelope.setEnabled(enabled); break;
    }
  }

  setOsc1Frequency(hz: number): void {
    const frequency = Math.round(clamp(hz, LIMITS.osc1Hz.min, LIMITS.osc1Hz.max));
    this.settings.osc1.baseFrequencyHz = frequency;
    this.osc1.setBaseFrequency(frequency);
  }

  setOsc2Frequency(hz: number): void {
    const frequency = clamp(hz, LIMITS.osc2Hz.min, LIMITS.osc2Hz.max);
    this.settings.osc2.baseFrequencyHz = frequency;
    this.osc2.setBaseFrequency(frequency);
  }

  setOsc1DutyRatio(ratio: number): void {
    this.settings.osc1.dutyRatio = clamp(ratio, LIMITS.dutyRatio.min, LIMITS.dutyRatio.max);
    this.osc1.setDutyRatio(this.settings.osc1.dutyRatio);
  }

  setOsc2DutyRatio(ratio: number): void {
    this.settings.osc2.dutyRatio = clamp(ratio, LIMITS.dutyRatio.min, LIMITS.dutyRatio.max);
    this.osc2.setDutyRatio(this.settings.osc2.dutyRatio);
  }

  async setOsc1Type(type: OscSourceType): Promise<void> {
    if (type === this.settings.osc1.sourceType) return;
    await this.performStructuralChange(() => {
      this.settings.osc1.sourceType = type;
      this.osc1.setType(type);
      this.applyGlobalDetune(this.context.currentTime);
    });
  }

  async setOsc2Type(type: OscSourceType): Promise<void> {
    if (type === this.settings.osc2.sourceType) return;
    await this.performStructuralChange(() => {
      this.settings.osc2.sourceType = type;
      this.osc2.setType(type);
      this.applyGlobalDetune(this.context.currentTime);
    });
  }

  setModMode(mode: ModMode): void {
    this.settings.mod.mode = mode;
    this.applyModMode(this.context.currentTime, true);
  }

  setFilter2Route(route: Filter2Route): void {
    this.settings.filter2Route = route;
    const now = this.context.currentTime;
    smoothAudioParam(this.modRouteGain.gain, route === 'mod' ? 1 : 0, now, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.cutoffDepthGain.gain, route === 'filter1-cutoff' ? this.settings.filter1CutoffDepthCent : 0, now, PARAM_SMOOTH_SEC);
    this.applyModMode(now, true);
  }

  setFilter1CutoffDepthCent(depth: number): void {
    this.settings.filter1CutoffDepthCent = clamp(depth, LIMITS.filter1CutoffDepthCent.min, LIMITS.filter1CutoffDepthCent.max);
    if (this.settings.filter2Route === 'filter1-cutoff') {
      smoothAudioParam(this.cutoffDepthGain.gain, this.settings.filter1CutoffDepthCent, this.context.currentTime, PARAM_SMOOTH_SEC);
    }
  }

  setAmDepth(depth: number): void {
    this.settings.mod.amDepth = clamp(depth, LIMITS.amDepth.min, LIMITS.amDepth.max);
    if (this.settings.filter2Route === 'mod' && this.settings.mod.mode === 'am' && this.settings.blocksEnabled.mod) {
      smoothAudioParam(
        this.amDepthGain.gain,
        this.settings.mod.amDepth,
        this.context.currentTime,
        PARAM_SMOOTH_SEC
      );
    }
  }

  setAmOffset(offset: number): void {
    this.settings.mod.amOffset = clamp(offset, LIMITS.amOffset.min, LIMITS.amOffset.max);
    if (this.settings.filter2Route === 'mod' && this.settings.mod.mode === 'am' && this.settings.blocksEnabled.mod) {
      smoothAudioParam(this.amGain.gain, this.settings.mod.amOffset, this.context.currentTime, PARAM_SMOOTH_SEC);
    }
  }

  setFmDepthCent(depthCent: number): void {
    this.settings.mod.fmDepthCent = clamp(
      depthCent,
      LIMITS.fmDepthCent.min,
      LIMITS.fmDepthCent.max
    );
    if (this.settings.filter2Route === 'mod' && this.settings.mod.mode === 'fm' && this.osc1.isPeriodic() && this.settings.blocksEnabled.mod) {
      smoothAudioParam(
        this.fmDepthGain.gain,
        this.settings.mod.fmDepthCent,
        this.context.currentTime,
        PARAM_SMOOTH_SEC
      );
    }
  }

  async setFilter1Structure(type: FilterType, order: FilterOrder): Promise<void> {
    await this.performStructuralChange(() => {
      this.settings.filter1.type = type;
      this.settings.filter1.order = order;
      this.filter1.setType(type);
      this.filter1.setOrder(order);
    });
  }

  async setFilter2Structure(type: FilterType, order: FilterOrder): Promise<void> {
    await this.performStructuralChange(() => {
      this.settings.filter2.type = type;
      this.settings.filter2.order = order;
      this.filter2.setType(type);
      this.filter2.setOrder(order);
    });
  }

  setFilter1Frequency(hz: number): void {
    this.settings.filter1.frequencyHz = hz;
    this.filter1.setFrequency(hz);
  }

  setFilter2Frequency(hz: number): void {
    this.settings.filter2.frequencyHz = hz;
    this.filter2.setFrequency(hz);
  }

  setFilter1Q(q: number): void {
    this.settings.filter1.q = q;
    this.filter1.setQ(q);
  }

  setFilter2Q(q: number): void {
    this.settings.filter2.q = q;
    this.filter2.setQ(q);
  }

  getDetuneRangeCent(): number {
    return this.detuneRangeCent;
  }

  setDetuneRangeCent(rangeCent: number): void {
    this.detuneRangeCent = clamp(
      rangeCent,
      LIMITS.detuneRangeCent.min,
      LIMITS.detuneRangeCent.max
    );
    this.applyGlobalDetune(this.context.currentTime);
  }

  randomizeDetune(): void {
    this.detuneNormalized = Math.random() * 2 - 1;
    this.applyGlobalDetune(this.context.currentTime);
  }

  setDetuneNormalized(value: number): void {
    this.detuneNormalized = clamp(value, -1, 1);
    this.applyGlobalDetune(this.context.currentTime);
  }

  getDetuneNormalized(): number {
    return this.detuneNormalized;
  }

  getCurrentDetuneCent(): number {
    return this.detuneNormalized * this.detuneRangeCent;
  }

  getDetunedFrequencyHz(oscillator: 1 | 2): number | null {
    const oscSettings = oscillator === 1 ? this.settings.osc1 : this.settings.osc2;
    if (oscSettings.sourceType === 'white-noise') return null;
    return oscSettings.baseFrequencyHz * 2 ** (this.getCurrentDetuneCent() / 1200);
  }

  getSettings(): ChannelSettings {
    return { ...structuredClone(this.settings), fx1: this.getFx1Settings() };
  }

  getFx1Settings(): EffectSlotSettings {
    return this.fx1.getSettings();
  }

  setFx1Enabled(enabled: boolean): void {
    this.fx1.setEnabled(enabled);
  }

  async setFx1Type(type: EffectType): Promise<void> {
    await this.fx1.setType(type);
  }

  setFx1Parameter(parameter: EffectParameter, value: number): void {
    this.fx1.setParameter(parameter, value);
  }

  async applySettings(next: ChannelSettings): Promise<void> {
    this.stopAutoTrigger();
    await this.setOsc1Type(next.osc1.sourceType);
    await this.setOsc2Type(next.osc2.sourceType);
    this.setOsc1Frequency(next.osc1.baseFrequencyHz);
    this.setOsc2Frequency(next.osc2.baseFrequencyHz);
    this.setOsc1DutyRatio(next.osc1.dutyRatio);
    this.setOsc2DutyRatio(next.osc2.dutyRatio);
    this.setPhaseMode(next.phaseMode);
    this.setPitchEnvelope(next.pitchEnvelope.amount, next.pitchEnvelope.transitionTimeSec);
    this.setModMode(next.mod.mode);
    this.setAmDepth(next.mod.amDepth);
    this.setAmOffset(next.mod.amOffset);
    this.setFmDepthCent(next.mod.fmDepthCent);
    this.setFilter2Route(next.filter2Route);
    this.setFilter1CutoffDepthCent(next.filter1CutoffDepthCent);
    await this.setFilter1Structure(next.filter1.type, next.filter1.order);
    await this.setFilter2Structure(next.filter2.type, next.filter2.order);
    this.setFilter1Frequency(next.filter1.frequencyHz);
    this.setFilter2Frequency(next.filter2.frequencyHz);
    this.setFilter1Q(next.filter1.q);
    this.setFilter2Q(next.filter2.q);
    this.setAmplitudeEnvelope(next.ampEnvelope);
    this.setAutoTrigger(next.autoTrigger);
    this.setBurstSettings(next.burst);
    await this.fx1.applySettings(next.fx1);
    for (const block of Object.keys(DEFAULT_CHANNEL_SETTINGS.blocksEnabled) as ChannelBlock[]) {
      this.setBlockEnabled(block, next.blocksEnabled?.[block] ?? true);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.scheduler.stop(false);
    this.burstScheduler.cancelFrom(this.context.currentTime);
    this.burstScheduler.stop();
    this.ampEnvelope.silence();
    this.osc1.dispose();
    this.osc2.dispose();
    this.filter1.dispose();
    this.filter2.dispose();
    this.amDepthGain.disconnect();
    this.fmDepthGain.disconnect();
    this.modRouteGain.disconnect();
    this.cutoffLimiter.disconnect();
    this.cutoffDepthGain.disconnect();
    this.amGain.disconnect();
    this.ampEnvelope.node.disconnect();
    this.structureFade.disconnect();
    this.fxInputGain.disconnect();
    this.fx1.dispose();
    this.output.disconnect();
    this.pEnv.dispose();
    this.gateListeners.clear();
    this.disposed = true;
  }

  private applyModMode(now: number, smooth: boolean): void {
    const modActive = this.settings.filter2Route === 'mod' && this.settings.blocksEnabled.mod;
    const offset = modActive && this.settings.mod.mode === 'am' ? this.settings.mod.amOffset : 1;
    const am = modActive && this.settings.mod.mode === 'am' ? this.settings.mod.amDepth : 0;
    const fm =
      modActive && this.settings.mod.mode === 'fm' && this.osc1.isPeriodic()
        ? this.settings.mod.fmDepthCent
        : 0;

    if (smooth) {
      smoothAudioParam(this.amGain.gain, offset, now, PARAM_SMOOTH_SEC);
      smoothAudioParam(this.amDepthGain.gain, am, now, PARAM_SMOOTH_SEC);
      smoothAudioParam(this.fmDepthGain.gain, fm, now, PARAM_SMOOTH_SEC);
    } else {
      this.amGain.gain.value = offset;
      this.amDepthGain.gain.value = am;
      this.fmDepthGain.gain.value = fm;
    }
  }

  private applyGlobalDetune(now: number): void {
    const cents = this.getCurrentDetuneCent();
    this.osc1.setDetune(cents, now);
    this.osc2.setDetune(cents, now);
    this.applyModMode(now, true);
  }

  private emitGate(event: GateScheduleEvent): void {
    for (const listener of this.gateListeners) listener(event);
  }

  async performStructuralChange(mutator: () => void): Promise<void> {
    await this.performFadedChange(this.structureFade, mutator);
  }

  private async performFadedChange(fade: GainNode, mutator: () => void): Promise<void> {
    if (this.disposed) return;
    const start = this.context.currentTime;
    smoothAudioParam(fade.gain, 0, start, STRUCTURE_FADE_SEC);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, STRUCTURE_FADE_SEC * 1000 + 2));
    if (this.disposed) return;

    mutator();

    const resume = this.context.currentTime;
    fade.gain.cancelScheduledValues(resume);
    fade.gain.setValueAtTime(0, resume);
    fade.gain.linearRampToValueAtTime(1, resume + STRUCTURE_FADE_SEC);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('ChannelSynth has been disposed.');
  }
}
