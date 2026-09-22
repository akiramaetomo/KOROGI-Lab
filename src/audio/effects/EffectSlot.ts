import {
  DEFAULT_EFFECT_SLOT_SETTINGS,
  LIMITS,
  PARAM_SMOOTH_SEC,
  STRUCTURE_FADE_SEC
} from '../constants';
import { clamp, dbToGain, holdAudioParam, smoothAudioParam } from '../dsp/params';
import type { EffectParameter, EffectSlotSettings, EffectType } from '../types';

const CHORUS_BASE_DELAY_SEC = 0.015;

function cloneDefaultSettings(): EffectSlotSettings {
  return structuredClone(DEFAULT_EFFECT_SLOT_SETTINGS);
}

function stringSeed(text: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash || 1;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

/** One source or bus effect slot with stable input/output nodes. */
export class EffectSlot {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly sum: GainNode;
  private readonly structureFade: GainNode;

  private settings: EffectSlotSettings;
  private disposed = false;
  private typeRevision = 0;
  private wetPathNodes: AudioNode[] = [];
  private delayNode: DelayNode | null = null;
  private delayFeedbackGain: GainNode | null = null;
  private distortionNode: WaveShaperNode | null = null;
  private chorusLfo: OscillatorNode | null = null;
  private chorusDepthGain: GainNode | null = null;
  private reverbNode: ConvolverNode | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly slotId: string,
    initial: EffectSlotSettings = cloneDefaultSettings()
  ) {
    this.settings = this.sanitize(initial);

    this.input = context.createGain();
    this.output = context.createGain();
    this.dryGain = context.createGain();
    this.wetGain = context.createGain();
    this.sum = context.createGain();
    this.structureFade = context.createGain();

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.sum);
    this.wetGain.connect(this.sum);
    this.sum.connect(this.structureFade);
    this.structureFade.connect(this.output);

    this.structureFade.gain.value = 1;
    this.buildWetPath();
    this.applyWetMix(false);
  }

  getSettings(): EffectSlotSettings {
    return structuredClone(this.settings);
  }

  setEnabled(enabled: boolean): void {
    this.settings.enabled = enabled;
    this.applyWetMix(true);
  }

  setParameter(parameter: EffectParameter, value: number): void {
    switch (parameter) {
      case 'distortionDriveDb': this.setDistortionDriveDb(value); break;
      case 'distortionWet': this.setDistortionWet(value); break;
      case 'delayTimeSec': this.setDelayTimeSec(value); break;
      case 'delayFeedback': this.setDelayFeedback(value); break;
      case 'delayWet': this.setDelayWet(value); break;
      case 'chorusRateHz': this.setChorusRateHz(value); break;
      case 'chorusDepthSec': this.setChorusDepthSec(value); break;
      case 'chorusWet': this.setChorusWet(value); break;
      case 'reverbDecaySec': this.setReverbDecaySec(value); break;
      case 'reverbWet': this.setReverbWet(value); break;
    }
  }

  async setType(type: EffectType): Promise<void> {
    if (this.disposed) return;
    const revision = ++this.typeRevision;
    if (type === this.settings.type) {
      smoothAudioParam(this.structureFade.gain, 1, this.context.currentTime, STRUCTURE_FADE_SEC);
      return;
    }
    const now = this.context.currentTime;
    smoothAudioParam(this.structureFade.gain, 0, now, STRUCTURE_FADE_SEC);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, STRUCTURE_FADE_SEC * 1000 + 2));
    if (this.disposed || revision !== this.typeRevision) return;

    this.disconnectWetPath();
    this.settings.type = type;
    this.buildWetPath();
    this.applyWetMix(false);

    const resume = this.context.currentTime;
    this.structureFade.gain.cancelScheduledValues(resume);
    this.structureFade.gain.setValueAtTime(0, resume);
    this.structureFade.gain.linearRampToValueAtTime(1, resume + STRUCTURE_FADE_SEC);
  }

  setDistortionDriveDb(db: number): void {
    this.settings.distortionDriveDb = clamp(db, LIMITS.distortionDriveDb.min, LIMITS.distortionDriveDb.max);
    if (this.distortionNode) this.distortionNode.curve = this.createDistortionCurve();
  }

  setDistortionWet(wet: number): void {
    this.settings.distortionWet = clamp(wet, LIMITS.effectWet.min, LIMITS.effectWet.max);
    if (this.settings.type === 'distortion') this.applyWetMix(true);
  }

  setDelayTimeSec(sec: number): void {
    this.settings.delayTimeSec = clamp(sec, LIMITS.delaySec.min, LIMITS.delaySec.max);
    if (this.delayNode) {
      smoothAudioParam(this.delayNode.delayTime, this.settings.delayTimeSec, this.context.currentTime, PARAM_SMOOTH_SEC);
    }
  }

  setDelayFeedback(value: number): void {
    this.settings.delayFeedback = clamp(value, LIMITS.delayFeedback.min, LIMITS.delayFeedback.max);
    if (this.delayFeedbackGain) {
      smoothAudioParam(this.delayFeedbackGain.gain, this.settings.delayFeedback, this.context.currentTime, PARAM_SMOOTH_SEC);
    }
  }

  setDelayWet(wet: number): void {
    this.settings.delayWet = clamp(wet, LIMITS.effectWet.min, LIMITS.effectWet.max);
    if (this.settings.type === 'delay') this.applyWetMix(true);
  }

  setChorusRateHz(hz: number): void {
    this.settings.chorusRateHz = clamp(hz, LIMITS.chorusRateHz.min, LIMITS.chorusRateHz.max);
    if (this.chorusLfo) {
      smoothAudioParam(this.chorusLfo.frequency, this.settings.chorusRateHz, this.context.currentTime, PARAM_SMOOTH_SEC);
    }
  }

  setChorusDepthSec(sec: number): void {
    this.settings.chorusDepthSec = clamp(sec, LIMITS.chorusDepthSec.min, LIMITS.chorusDepthSec.max);
    if (this.chorusDepthGain) {
      smoothAudioParam(this.chorusDepthGain.gain, this.settings.chorusDepthSec, this.context.currentTime, PARAM_SMOOTH_SEC);
    }
  }

  setChorusWet(wet: number): void {
    this.settings.chorusWet = clamp(wet, LIMITS.effectWet.min, LIMITS.effectWet.max);
    if (this.settings.type === 'chorus') this.applyWetMix(true);
  }

  setReverbDecaySec(sec: number): void {
    this.settings.reverbDecaySec = clamp(sec, LIMITS.reverbDecaySec.min, LIMITS.reverbDecaySec.max);
    if (this.reverbNode) this.reverbNode.buffer = this.createImpulseResponse();
  }

  setReverbWet(wet: number): void {
    this.settings.reverbWet = clamp(wet, LIMITS.effectWet.min, LIMITS.effectWet.max);
    if (this.settings.type === 'reverb') this.applyWetMix(true);
  }

  async applySettings(next: EffectSlotSettings): Promise<void> {
    const sanitized = this.sanitize(next);
    await this.setType(sanitized.type);
    this.setDistortionDriveDb(sanitized.distortionDriveDb);
    this.setDistortionWet(sanitized.distortionWet);
    this.setDelayTimeSec(sanitized.delayTimeSec);
    this.setDelayFeedback(sanitized.delayFeedback);
    this.setDelayWet(sanitized.delayWet);
    this.setChorusRateHz(sanitized.chorusRateHz);
    this.setChorusDepthSec(sanitized.chorusDepthSec);
    this.setChorusWet(sanitized.chorusWet);
    this.setReverbDecaySec(sanitized.reverbDecaySec);
    this.setReverbWet(sanitized.reverbWet);
    this.setEnabled(sanitized.enabled);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.typeRevision += 1;
    this.disconnectWetPath();
    this.input.disconnect();
    this.dryGain.disconnect();
    this.wetGain.disconnect();
    this.sum.disconnect();
    this.structureFade.disconnect();
    this.output.disconnect();
  }

  private buildWetPath(): void {
    this.delayNode = null;
    this.delayFeedbackGain = null;
    this.distortionNode = null;
    this.chorusLfo = null;
    this.chorusDepthGain = null;
    this.reverbNode = null;

    if (this.settings.type === 'off') return;

    if (this.settings.type === 'distortion') {
      const shaper = this.context.createWaveShaper();
      shaper.oversample = '4x';
      shaper.curve = this.createDistortionCurve();
      this.input.connect(shaper);
      shaper.connect(this.wetGain);
      this.distortionNode = shaper;
      this.wetPathNodes = [shaper];
      return;
    }

    if (this.settings.type === 'delay') {
      const delay = this.context.createDelay(LIMITS.delaySec.max);
      const feedback = this.context.createGain();
      delay.delayTime.value = this.settings.delayTimeSec;
      feedback.gain.value = this.settings.delayFeedback;

      this.input.connect(delay);
      delay.connect(this.wetGain);
      delay.connect(feedback);
      feedback.connect(delay);

      this.delayNode = delay;
      this.delayFeedbackGain = feedback;
      this.wetPathNodes = [delay, feedback];
      return;
    }

    if (this.settings.type === 'chorus') {
      const delay = this.context.createDelay(CHORUS_BASE_DELAY_SEC + LIMITS.chorusDepthSec.max + 0.005);
      const lfo = this.context.createOscillator();
      const depth = this.context.createGain();
      delay.delayTime.value = CHORUS_BASE_DELAY_SEC;
      lfo.type = 'sine';
      lfo.frequency.value = this.settings.chorusRateHz;
      depth.gain.value = this.settings.chorusDepthSec;

      lfo.connect(depth);
      depth.connect(delay.delayTime);
      this.input.connect(delay);
      delay.connect(this.wetGain);
      lfo.start();

      this.chorusLfo = lfo;
      this.chorusDepthGain = depth;
      this.wetPathNodes = [delay, lfo, depth];
      return;
    }

    const convolver = this.context.createConvolver();
    convolver.normalize = true;
    convolver.buffer = this.createImpulseResponse();
    this.input.connect(convolver);
    convolver.connect(this.wetGain);
    this.reverbNode = convolver;
    this.wetPathNodes = [convolver];
  }

  private disconnectWetPath(): void {
    try {
      this.input.disconnect();
    } catch {
      // no-op
    }
    this.input.connect(this.dryGain);

    if (this.chorusLfo) {
      try {
        this.chorusLfo.stop();
      } catch {
        // already stopped
      }
    }

    for (const node of this.wetPathNodes) {
      try {
        node.disconnect();
      } catch {
        // no-op
      }
    }
    this.wetPathNodes = [];
    this.delayNode = null;
    this.delayFeedbackGain = null;
    this.distortionNode = null;
    this.chorusLfo = null;
    this.chorusDepthGain = null;
    this.reverbNode = null;
  }

  private applyWetMix(smooth: boolean): void {
    const wet = this.currentWet();
    const bypass = !this.settings.enabled || this.settings.type === 'off';
    const dry = bypass ? 1 : 1 - wet;
    const wetValue = bypass ? 0 : wet;
    const now = this.context.currentTime;

    if (smooth) {
      smoothAudioParam(this.dryGain.gain, dry, now, PARAM_SMOOTH_SEC);
      smoothAudioParam(this.wetGain.gain, wetValue, now, PARAM_SMOOTH_SEC);
    } else {
      holdAudioParam(this.dryGain.gain, now);
      holdAudioParam(this.wetGain.gain, now);
      this.dryGain.gain.setValueAtTime(dry, now);
      this.wetGain.gain.setValueAtTime(wetValue, now);
    }
  }

  private currentWet(): number {
    if (this.settings.type === 'distortion') return this.settings.distortionWet;
    if (this.settings.type === 'delay') return this.settings.delayWet;
    if (this.settings.type === 'chorus') return this.settings.chorusWet;
    if (this.settings.type === 'reverb') return this.settings.reverbWet;
    return 0;
  }

  private createDistortionCurve(): Float32Array<ArrayBuffer> {
    const size = 4096;
    const curve = new Float32Array(size);
    const drive = dbToGain(this.settings.distortionDriveDb);
    const norm = Math.tanh(drive) || 1;
    for (let i = 0; i < size; i += 1) {
      const x = (i / (size - 1)) * 2 - 1;
      curve[i] = Math.tanh(drive * x) / norm;
    }
    return curve;
  }

  private createImpulseResponse(): AudioBuffer {
    const t60 = this.settings.reverbDecaySec;
    const length = Math.max(1, Math.ceil(this.context.sampleRate * t60));
    const buffer = this.context.createBuffer(2, length, this.context.sampleRate);
    const random = xorshift32(stringSeed(`${this.slotId}:ir`));
    const decayCoefficient = Math.log(1000) / t60;

    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        const time = i / this.context.sampleRate;
        const envelope = Math.exp(-decayCoefficient * time);
        data[i] = (random() * 2 - 1) * envelope;
      }
    }
    return buffer;
  }

  private sanitize(value: EffectSlotSettings): EffectSlotSettings {
    return {
      enabled: value.enabled ?? true,
      type: value.type,
      distortionDriveDb: clamp(value.distortionDriveDb, LIMITS.distortionDriveDb.min, LIMITS.distortionDriveDb.max),
      distortionWet: clamp(value.distortionWet, LIMITS.effectWet.min, LIMITS.effectWet.max),
      delayTimeSec: clamp(value.delayTimeSec, LIMITS.delaySec.min, LIMITS.delaySec.max),
      delayFeedback: clamp(value.delayFeedback, LIMITS.delayFeedback.min, LIMITS.delayFeedback.max),
      delayWet: clamp(value.delayWet, LIMITS.effectWet.min, LIMITS.effectWet.max),
      chorusRateHz: clamp(value.chorusRateHz, LIMITS.chorusRateHz.min, LIMITS.chorusRateHz.max),
      chorusDepthSec: clamp(value.chorusDepthSec, LIMITS.chorusDepthSec.min, LIMITS.chorusDepthSec.max),
      chorusWet: clamp(value.chorusWet, LIMITS.effectWet.min, LIMITS.effectWet.max),
      reverbDecaySec: clamp(value.reverbDecaySec, LIMITS.reverbDecaySec.min, LIMITS.reverbDecaySec.max),
      reverbWet: clamp(value.reverbWet, LIMITS.effectWet.min, LIMITS.effectWet.max)
    };
  }
}
