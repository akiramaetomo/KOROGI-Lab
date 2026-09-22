import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import type { OscSourceType } from '../types';
import { clamp, smoothAudioParam } from './params';
import { WhiteNoiseFactory } from './WhiteNoiseFactory';

interface PeriodicSourceNodes {
  kind: 'periodic';
  generations: Set<PeriodicGeneration>;
  latest: PeriodicGeneration;
}

interface PeriodicGeneration {
  oscillator: OscillatorNode;
  gain: GainNode;
}

interface PendingPhaseReset {
  time: number;
  previous: PeriodicGeneration;
  next: PeriodicGeneration;
  cleanup: ReturnType<typeof setTimeout>;
}

interface NoiseSourceNodes {
  kind: 'noise';
  source: AudioBufferSourceNode;
}

type SourceNodes = PeriodicSourceNodes | NoiseSourceNodes;

/**
 * Stable source slot with a stable output node.
 * For periodic sources:
 *   Oscillator.frequency = base frequency
 *   Oscillator.detune = global detune + PEnv(cents) + optional FM(cents)
 *
 * CR-2026-09-16: PEnv is interpolated in logarithmic frequency space.
 * The user-facing peak remains a +/- percentage. The percentage is converted
 * to cents so the peak frequency stays exactly f0 * (1 + p).
 */
export class SourceUnit {
  readonly output: GainNode;
  readonly pEnvScale: GainNode;

  private baseFrequencyControl: ConstantSourceNode;
  private current: SourceNodes | null = null;
  private sourceType: OscSourceType;
  private baseFrequencyHz: number;
  private detuneCent = 0;
  private activePitchAmount = 0;
  private dutyRatio = 0.5;
  private readonly pendingPhaseResets: PendingPhaseReset[] = [];

  constructor(
    private readonly context: AudioContext,
    private readonly noiseFactory: WhiteNoiseFactory,
    pEnvShape: AudioNode,
    initialType: OscSourceType,
    initialBaseFrequencyHz: number,
    private readonly externalDetuneSignal?: AudioNode,
    initialDutyRatio = 0.5
  ) {
    this.output = context.createGain();
    this.output.gain.value = 1;

    this.baseFrequencyHz = this.limitFrequency(initialBaseFrequencyHz);
    this.baseFrequencyControl = this.createBaseFrequencyControl();

    this.pEnvScale = context.createGain();
    this.pEnvScale.gain.value = 0;
    pEnvShape.connect(this.pEnvScale);

    this.sourceType = initialType;
    this.dutyRatio = clamp(initialDutyRatio, LIMITS.dutyRatio.min, LIMITS.dutyRatio.max);
    this.buildSource(initialType);
  }

  get type(): OscSourceType {
    return this.sourceType;
  }

  get frequencyHz(): number {
    return this.baseFrequencyHz;
  }

  isPeriodic(): boolean {
    return this.current?.kind === 'periodic';
  }

  setType(type: OscSourceType): void {
    if (type === this.sourceType) return;
    this.destroyCurrentSource();
    this.sourceType = type;
    this.buildSource(type);
  }

  setEnabled(enabled: boolean): void {
    smoothAudioParam(this.output.gain, enabled ? 1 : 0, this.context.currentTime, PARAM_SMOOTH_SEC);
  }

  setDutyRatio(ratio: number): void {
    const next = clamp(ratio, LIMITS.dutyRatio.min, LIMITS.dutyRatio.max);
    if (next === this.dutyRatio) return;
    this.dutyRatio = next;
    if (this.sourceType === 'square' && this.current?.kind === 'periodic') {
      for (const generation of this.current.generations) this.applyPulseWave(generation.oscillator);
    }
  }

  setBaseFrequency(hz: number, now = this.context.currentTime): void {
    const next = this.limitFrequency(hz);
    this.baseFrequencyHz = next;
    smoothAudioParam(this.baseFrequencyControl.offset, next, now, PARAM_SMOOTH_SEC);
  }

  /** Recreate sources that were started while a realtime context was suspended. */
  restartAfterContextResume(): void {
    this.destroyCurrentSource();
    try { this.baseFrequencyControl.stop(); } catch { /* already stopped */ }
    this.baseFrequencyControl.disconnect();
    this.baseFrequencyControl = this.createBaseFrequencyControl();
    this.buildSource(this.sourceType);
  }

  setActivePitchAmount(amount: number, time: number): void {
    this.activePitchAmount = clamp(amount, LIMITS.pitchAmount.min, LIMITS.pitchAmount.max);
    const peakRatio = 1 + this.activePitchAmount;
    const peakCent = 1200 * Math.log2(peakRatio);
    this.pEnvScale.gain.cancelScheduledValues(time);
    this.pEnvScale.gain.setValueAtTime(peakCent, time);
  }

  setDetune(cents: number, now = this.context.currentTime): void {
    this.detuneCent = cents;
    if (this.current?.kind === 'periodic') {
      for (const generation of this.current.generations) smoothAudioParam(generation.oscillator.detune, cents, now, PARAM_SMOOTH_SEC);
    }
  }

  /** Schedule a new periodic oscillator whose phase is zero at the exact Gate time. */
  syncPhaseAt(time: number): void {
    if (this.current?.kind !== 'periodic') return;
    time = Math.max(time, this.context.currentTime);
    const source = this.current;
    const previous = source.latest;
    const next = this.createPeriodicGeneration(time);
    source.generations.add(next);
    previous.gain.gain.setValueAtTime(1, time);
    previous.gain.gain.setValueAtTime(0, time);
    source.latest = next;
    const cleanup = globalThis.setTimeout(() => {
      this.removePending(next);
      this.destroyGeneration(previous);
    }, Math.max(0, (time - this.context.currentTime + .05) * 1000));
    this.pendingPhaseResets.push({ time, previous, next, cleanup });
  }

  /** Cancel phase resets paired with Gate events that have not started yet. */
  cancelPhaseResetsFrom(time: number): void {
    if (this.current?.kind !== 'periodic') return;
    const source = this.current;
    const cancelled = this.pendingPhaseResets.filter(item => item.time >= time).sort((a, b) => b.time - a.time);
    for (const item of cancelled) {
      globalThis.clearTimeout(item.cleanup);
      item.previous.gain.gain.cancelScheduledValues(item.time);
      item.previous.gain.gain.setValueAtTime(1, item.time);
      this.destroyGeneration(item.next);
      source.latest = item.previous;
      this.removePending(item.next);
    }
  }

  dispose(): void {
    this.destroyCurrentSource();
    try {
      this.baseFrequencyControl.stop();
    } catch {
      // already stopped
    }
    this.baseFrequencyControl.disconnect();
    this.pEnvScale.disconnect();
    this.output.disconnect();
  }

  private buildSource(type: OscSourceType): void {
    if (type === 'white-noise') {
      const source = this.noiseFactory.createLoopingSource();
      source.connect(this.output);
      source.start();
      this.current = { kind: 'noise', source };
      return;
    }

    const generation = this.createPeriodicGeneration(this.context.currentTime);
    this.current = { kind: 'periodic', generations: new Set([generation]), latest: generation };
  }

  private createBaseFrequencyControl(): ConstantSourceNode {
    const source = this.context.createConstantSource();
    source.offset.value = this.baseFrequencyHz;
    source.start();
    return source;
  }

  private createPeriodicGeneration(startTime: number): PeriodicGeneration {
    const oscillator = this.context.createOscillator();
    const type = this.sourceType;
    if (type === 'white-noise') throw new Error('White noise has no periodic phase.');
    oscillator.type = type;
    if (type === 'square') this.applyPulseWave(oscillator);
    oscillator.frequency.value = 0;
    oscillator.detune.value = this.detuneCent;
    const gain = this.context.createGain(); gain.gain.value = 1;
    this.baseFrequencyControl.connect(oscillator.frequency);
    this.pEnvScale.connect(oscillator.detune);
    this.externalDetuneSignal?.connect(oscillator.detune);
    oscillator.connect(gain); gain.connect(this.output);
    oscillator.start(startTime);
    return { oscillator, gain };
  }

  private applyPulseWave(oscillator: OscillatorNode): void {
    // Fourier series of +1 for fraction D of a cycle, -1 otherwise.
    // Remove DC (2D-1), retaining AC amplitude without peak normalization.
    // PeriodicWave provides browser band-limiting and keeps oscillator phase.
    const real = new Float32Array(2049);
    const imag = new Float32Array(2049);
    for (let harmonic = 1; harmonic < real.length; harmonic += 1) {
      const angle = 2 * Math.PI * harmonic * this.dutyRatio;
      real[harmonic] = 2 * Math.sin(angle) / (Math.PI * harmonic);
      imag[harmonic] = 2 * (1 - Math.cos(angle)) / (Math.PI * harmonic);
    }
    oscillator.setPeriodicWave(this.context.createPeriodicWave(real, imag, { disableNormalization: true }));
  }

  private destroyCurrentSource(): void {
    if (!this.current) return;

    if (this.current.kind === 'periodic') {
      for (const pending of this.pendingPhaseResets.splice(0)) globalThis.clearTimeout(pending.cleanup);
      for (const generation of [...this.current.generations]) this.destroyGeneration(generation);
    } else {
      this.current.source.disconnect();
      try {
        this.current.source.stop();
      } catch {
        // already stopped
      }
    }

    this.current = null;
  }

  private removePending(next: PeriodicGeneration): void {
    const index = this.pendingPhaseResets.findIndex(item => item.next === next);
    if (index >= 0) this.pendingPhaseResets.splice(index, 1);
  }

  private destroyGeneration(generation: PeriodicGeneration): void {
    if (this.current?.kind === 'periodic') this.current.generations.delete(generation);
    try { this.baseFrequencyControl.disconnect(generation.oscillator.frequency); } catch { /* absent */ }
    try { this.pEnvScale.disconnect(generation.oscillator.detune); } catch { /* absent */ }
    try { this.externalDetuneSignal?.disconnect(generation.oscillator.detune); } catch { /* absent */ }
    generation.oscillator.disconnect(); generation.gain.disconnect();
    try { generation.oscillator.stop(); } catch { /* already stopped */ }
  }

  private limitFrequency(hz: number): number {
    const nyquistSafe = this.context.sampleRate * 0.5 * 0.999;
    return clamp(hz, LIMITS.oscillatorHz.min, Math.min(LIMITS.oscillatorHz.max, nyquistSafe));
  }
}
