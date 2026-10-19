import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import type { OscPartial, OscSourceType } from '../types';
import { SINGLE_PARTIALS } from './multiOscillator';
import { clamp, smoothAudioParam } from './params';
import { WhiteNoiseFactory } from './WhiteNoiseFactory';

interface PeriodicSourceNodes {
  kind: 'periodic';
  generations: Set<PeriodicGeneration>;
  latest: PeriodicGeneration;
}

/** One phase epoch: every partial's oscillator starts together, each through its amplitude gain. */
interface PeriodicGeneration {
  oscillators: OscillatorNode[];
  amplitudes: GainNode[];
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
 * For periodic sources, each partial n (Single is one partial with ratio 1, amplitude 1):
 *   Oscillator_n.frequency = ratio_n * base frequency * max(0.1/base, 1 + scaled PEnv)
 *   Oscillator_n.detune = global detune + external cent signals
 *   output = sum of amplitude_n * Oscillator_n
 * Cent signals and PEnv therefore move every partial while keeping their ratios.
 *
 * PEnv's frequency-ratio trajectory is linear. The shaper only bounds the
 * nonpositive endpoint; it is an identity map elsewhere.
 */
export class SourceUnit {
  readonly output: GainNode;
  readonly pEnvScale: GainNode;
  private readonly pEnvFloor: WaveShaperNode;

  private baseFrequencyControl: ConstantSourceNode;
  /** Base * (1 + PEnv), shared by all partials and generations. */
  private readonly frequencyBus: GainNode;
  /** Per-partial frequency ratio, shared by all generations. */
  private ratioGains: GainNode[] = [];
  private partials: OscPartial[] = SINGLE_PARTIALS.map(item => ({ ...item }));
  private current: SourceNodes | null = null;
  private sourceType: OscSourceType;
  private baseFrequencyHz: number;
  private detuneCent = 0;
  private dutyRatio = 0.5;
  /** Pulse wave for the current duty, shared by every partial and generation. */
  private pulseWave: PeriodicWave | null = null;
  private readonly pendingPhaseResets: PendingPhaseReset[] = [];

  constructor(
    private readonly context: AudioContext,
    private readonly noiseFactory: WhiteNoiseFactory,
    pEnvShape: AudioNode,
    initialType: OscSourceType,
    initialBaseFrequencyHz: number,
    private readonly externalDetuneSignals: readonly AudioNode[] = [],
    initialDutyRatio = 0.5,
    initialPartials: readonly OscPartial[] = SINGLE_PARTIALS
  ) {
    this.output = context.createGain();
    this.output.gain.value = 1;

    this.frequencyBus = context.createGain();
    this.frequencyBus.gain.value = 1;
    this.baseFrequencyHz = this.limitFrequency(initialBaseFrequencyHz);
    this.baseFrequencyControl = this.createBaseFrequencyControl();

    this.pEnvScale = context.createGain();
    this.pEnvScale.gain.value = this.baseFrequencyHz;
    this.pEnvFloor = context.createWaveShaper();
    this.updatePitchFloor();
    pEnvShape.connect(this.pEnvFloor).connect(this.pEnvScale);
    this.pEnvScale.connect(this.frequencyBus);
    this.setRatioGains(initialPartials);

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

  get partialCount(): number {
    return this.partials.length;
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

  /**
   * Replace the partial set. A different count rebuilds the oscillators (callers fade it as a structural change);
   * the same count glides ratios and amplitudes without restarting phase.
   */
  setPartials(partials: readonly OscPartial[], now = this.context.currentTime): void {
    if (partials.length === 0) throw new Error('A source needs at least one partial.');
    if (partials.length !== this.partials.length) {
      this.destroyCurrentSource();
      this.setRatioGains(partials);
      this.buildSource(this.sourceType);
      return;
    }
    this.partials = partials.map(item => ({ ...item }));
    this.partials.forEach((partial, index) => smoothAudioParam(this.ratioGains[index]!.gain, partial.ratio, now, PARAM_SMOOTH_SEC));
    if (this.current?.kind !== 'periodic') return;
    for (const generation of this.current.generations) {
      generation.amplitudes.forEach((gain, index) => smoothAudioParam(gain.gain, this.partials[index]!.amplitude, now, PARAM_SMOOTH_SEC));
    }
  }

  setEnabled(enabled: boolean): void {
    smoothAudioParam(this.output.gain, enabled ? 1 : 0, this.context.currentTime, PARAM_SMOOTH_SEC);
  }

  setDutyRatio(ratio: number): void {
    const next = clamp(ratio, LIMITS.dutyRatio.min, LIMITS.dutyRatio.max);
    if (next === this.dutyRatio) return;
    this.dutyRatio = next;
    this.pulseWave = null;
    if (this.sourceType === 'square' && this.current?.kind === 'periodic') {
      for (const generation of this.current.generations) generation.oscillators.forEach(oscillator => this.applyPulseWave(oscillator));
    }
  }

  setBaseFrequency(hz: number, now = this.context.currentTime): void {
    const next = this.limitFrequency(hz);
    this.baseFrequencyHz = next;
    smoothAudioParam(this.baseFrequencyControl.offset, next, now, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.pEnvScale.gain, next, now, PARAM_SMOOTH_SEC);
    this.updatePitchFloor();
  }

  /** Recreate sources that were started while a realtime context was suspended. */
  restartAfterContextResume(): void {
    this.destroyCurrentSource();
    try { this.baseFrequencyControl.stop(); } catch { /* already stopped */ }
    this.baseFrequencyControl.disconnect();
    this.baseFrequencyControl = this.createBaseFrequencyControl();
    this.buildSource(this.sourceType);
  }

  setDetune(cents: number, now = this.context.currentTime): void {
    this.detuneCent = cents;
    if (this.current?.kind === 'periodic') {
      for (const generation of this.current.generations) {
        for (const oscillator of generation.oscillators) smoothAudioParam(oscillator.detune, cents, now, PARAM_SMOOTH_SEC);
      }
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
    this.pEnvFloor.disconnect();
    this.frequencyBus.disconnect();
    this.ratioGains.forEach(gain => gain.disconnect());
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
    source.connect(this.frequencyBus);
    source.start();
    return source;
  }

  private createPeriodicGeneration(startTime: number): PeriodicGeneration {
    const type = this.sourceType;
    if (type === 'white-noise') throw new Error('White noise has no periodic phase.');
    const gain = this.context.createGain(); gain.gain.value = 1;
    const oscillators: OscillatorNode[] = [];
    const amplitudes: GainNode[] = [];
    this.partials.forEach((partial, index) => {
      const oscillator = this.context.createOscillator();
      oscillator.type = type;
      if (type === 'square') this.applyPulseWave(oscillator);
      oscillator.frequency.value = 0;
      oscillator.detune.value = this.detuneCent;
      const amplitude = this.context.createGain(); amplitude.gain.value = partial.amplitude;
      this.ratioGains[index]!.connect(oscillator.frequency);
      this.externalDetuneSignals.forEach(signal => signal.connect(oscillator.detune));
      oscillator.connect(amplitude); amplitude.connect(gain);
      oscillators.push(oscillator); amplitudes.push(amplitude);
    });
    gain.connect(this.output);
    // All partials share one start time, so SYNC restarts every one at phase zero together.
    oscillators.forEach(oscillator => oscillator.start(startTime));
    return { oscillators, amplitudes, gain };
  }

  private setRatioGains(partials: readonly OscPartial[]): void {
    this.ratioGains.forEach(gain => gain.disconnect());
    this.partials = partials.map(item => ({ ...item }));
    this.ratioGains = this.partials.map(partial => {
      const gain = this.context.createGain();
      gain.gain.value = partial.ratio;
      this.frequencyBus.connect(gain);
      return gain;
    });
  }

  private applyPulseWave(oscillator: OscillatorNode): void {
    // Fourier series of +1 for fraction D of a cycle, -1 otherwise.
    // Remove DC (2D-1), retaining AC amplitude without peak normalization.
    // PeriodicWave provides browser band-limiting and keeps oscillator phase.
    if (this.pulseWave) { oscillator.setPeriodicWave(this.pulseWave); return; }
    const real = new Float32Array(2049);
    const imag = new Float32Array(2049);
    for (let harmonic = 1; harmonic < real.length; harmonic += 1) {
      const angle = 2 * Math.PI * harmonic * this.dutyRatio;
      real[harmonic] = 2 * Math.sin(angle) / (Math.PI * harmonic);
      imag[harmonic] = 2 * (1 - Math.cos(angle)) / (Math.PI * harmonic);
    }
    this.pulseWave = this.context.createPeriodicWave(real, imag, { disableNormalization: true });
    oscillator.setPeriodicWave(this.pulseWave);
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
    generation.oscillators.forEach((oscillator, index) => {
      try { this.ratioGains[index]?.disconnect(oscillator.frequency); } catch { /* absent */ }
      for (const signal of this.externalDetuneSignals) {
        try { signal.disconnect(oscillator.detune); } catch { /* absent */ }
      }
      oscillator.disconnect();
      try { oscillator.stop(); } catch { /* already stopped */ }
    });
    generation.amplitudes.forEach(gain => gain.disconnect());
    generation.gain.disconnect();
  }

  private limitFrequency(hz: number): number {
    const nyquistSafe = this.context.sampleRate * 0.5 * 0.999;
    return clamp(hz, LIMITS.oscillatorHz.min, Math.min(LIMITS.oscillatorHz.max, nyquistSafe));
  }

  private updatePitchFloor(): void {
    const floorDeviation = .1 / this.baseFrequencyHz - 1;
    const curve = new Float32Array(8193);
    for (let i = 0; i < curve.length; i += 1) {
      curve[i] = Math.max(floorDeviation, 2 * i / (curve.length - 1) - 1);
    }
    this.pEnvFloor.curve = curve;
  }
}
