import { describe, expect, it } from 'vitest';
import { LfsrNoiseBank } from './LfsrNoiseBank';

function fakeContext(sampleRate = 48_000): BaseAudioContext {
  return {
    sampleRate,
    createBuffer: (_channels: number, length: number, rate: number) => {
      const data = new Float32Array(length);
      return { length, sampleRate: rate, duration: length / rate, getChannelData: () => data } as unknown as AudioBuffer;
    }
  } as unknown as BaseAudioContext;
}

describe('LfsrNoiseBank', () => {
  it('shares one table per setting and never regenerates for repeated use', () => {
    const bank = new LfsrNoiseBank(fakeContext(), 1);
    const first = bank.acquire({ clockHz: 4_800, bits: 4 });
    for (let i = 0; i < 100; i += 1) bank.release(bank.acquire({ clockHz: 4_800, bits: 4 }).key);
    expect(bank.generatedCount).toBe(1);
    expect(bank.acquire({ clockHz: 4_800, bits: 4 }).buffer).toBe(first.buffer);
    bank.acquire({ clockHz: 4_800, bits: 5 });
    expect(bank.generatedCount).toBe(2);
  });

  it('frees a table when its last holder releases it', () => {
    const bank = new LfsrNoiseBank(fakeContext(), 1);
    const a = bank.acquire({ clockHz: 1_000, bits: 1 });
    const b = bank.acquire({ clockHz: 1_000, bits: 1 });
    bank.release(a.key);
    expect(bank.tableCount).toBe(1);
    bank.release(b.key);
    expect(bank.tableCount).toBe(0);
    bank.acquire({ clockHz: 1_000, bits: 1 });
    expect(bank.generatedCount).toBe(2);
  });

  it('bounds the clock by the context sample rate and rounds bits', () => {
    const bank = new LfsrNoiseBank(fakeContext(44_100), 1);
    expect(bank.normalize({ clockHz: 96_000, bits: 3.6 })).toMatchObject({ clockHz: 44_100, bits: 4 });
    expect(bank.normalize({ clockHz: 10, bits: 40 })).toMatchObject({ clockHz: 100, bits: 16 });
    expect(bank.acquire({ clockHz: 96_000, bits: 1 }).key).toBe(bank.acquire({ clockHz: 50_000, bits: 1 }).key);
  });
});
