import { LIMITS } from '../constants';
import { DEFAULT_LFSR_SEED, generateLfsrTable, lfsrFrameCount, LFSR_TABLE_SEC } from './lfsrNoise';

export interface LfsrTableRequest { clockHz: number; bits: number; seed?: number }

interface Entry { buffer: AudioBuffer; refs: number }

/**
 * Shared LFSR tables for one AudioContext, keyed by clock, bits and seed.
 * A table is generated on first use and freed when no source holds it; Gates never generate.
 */
export class LfsrNoiseBank {
  private readonly entries = new Map<string, Entry>();
  /** Test and diagnostics surface: how many tables were generated and how long the last one took. */
  generatedCount = 0;
  lastGenerationMs = 0;

  constructor(private readonly context: BaseAudioContext, private readonly durationSec = LFSR_TABLE_SEC) {}

  /** Hold the table for `request`; pair every acquire with release(key). */
  acquire(request: LfsrTableRequest): { key: string; buffer: AudioBuffer } {
    const key = this.keyOf(request);
    let entry = this.entries.get(key);
    if (!entry) {
      const started = globalThis.performance?.now() ?? Date.now();
      const { clockHz, bits, seed } = this.normalize(request);
      const sampleRate = this.context.sampleRate;
      const buffer = this.context.createBuffer(1, lfsrFrameCount(sampleRate, this.durationSec), sampleRate);
      generateLfsrTable({ sampleRate, clockHz, bits, seed, durationSec: this.durationSec }, buffer.getChannelData(0));
      this.lastGenerationMs = (globalThis.performance?.now() ?? Date.now()) - started;
      this.generatedCount += 1;
      entry = { buffer, refs: 0 };
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    return { key, buffer: entry.buffer };
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) this.entries.delete(key);
  }

  get tableCount(): number {
    return this.entries.size;
  }

  /** Clock is bounded to its minimum .. sampleRate here, so a saved value above this context's rate still plays. */
  normalize(request: LfsrTableRequest): Required<LfsrTableRequest> {
    return {
      clockHz: Math.min(this.context.sampleRate, Math.max(LIMITS.lfsrClockHz.min, request.clockHz)),
      bits: Math.round(Math.min(LIMITS.lfsrBits.max, Math.max(LIMITS.lfsrBits.min, request.bits))),
      seed: request.seed ?? DEFAULT_LFSR_SEED
    };
  }

  private keyOf(request: LfsrTableRequest): string {
    const { clockHz, bits, seed } = this.normalize(request);
    return `${clockHz}|${bits}|${seed}`;
  }
}
