import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { SequenceSettings } from '../audio/types';
import { SequenceTransport } from './SequenceTransport';

afterEach(() => vi.unstubAllGlobals());

describe('SequenceTransport timing', () => {
  it('retains independent User Gate and Pitch phases across a live Play Speed change', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const synth = { isAutoTriggerRunning: () => false } as ChannelSynth;
    let settings: SequenceSettings = { pitchScaleCent: 200, filterAmountCent: -4800, filterAmountWide: false, pitchMode: { kind: 'smooth' }, recordSpeed: 1, playSpeed: 1 };
    const calls = { gateOns: [] as number[], gateCancels: [] as number[], pitchHolds: [] as number[], pitches: [] as Array<{ cents: number; filterCent: number; time: number; transition: number }> };
    const engine = {
      context,
      getChannel: (id: string) => id === '1' ? synth : undefined,
      getChannelIds: () => ['1'],
      getSequenceSelection: () => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: settings.playSpeed } as const),
      getSequenceSettings: () => structuredClone(settings),
      getGateMuted: () => false,
      getPitchMuted: () => false,
      getGateRecording: () => ({ durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
        gates: [{ onSec: 0, offSec: .5 }] }),
      getPitchRecording: () => ({ durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: .5, valueNormalized: 1 }, { timeSec: 1, valueNormalized: 0 }] }),
      gateOn: (_id: string, time: number) => calls.gateOns.push(time),
      gateOff: () => {},
      cancelScheduledGatesFrom: (_id: string, time: number) => calls.gateCancels.push(time),
      cancelScheduledGates: () => {},
      setSequencePitch: (_id: string, normalized: number, scale: number, filterAmount: number, time: number, transition: number) => calls.pitches.push({ cents: normalized * scale, filterCent: normalized * filterAmount, time, transition }),
      holdSequencePitch: (_id: string, time: number) => { calls.pitchHolds.push(time); return 80; },
      resetSequencePitch: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});

    await transport.play('1');
    context.currentTime = .28;
    settings = { ...settings, playSpeed: 2 };
    transport.sequenceSettingsChanged('1');

    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.2, 9);
    expect(transport.position('1', 'pitch')?.elapsed).toBeCloseTo(.2, 9);
    expect(calls.gateCancels).toEqual([.28]);
    expect(calls.gateOns.at(-1)).toBe(.28);
    expect(calls.pitchHolds).toEqual([.28]);
    const current = calls.pitches.find(item => item.time === .28 && item.transition === 0)!;
    expect(current.cents).toBeCloseTo(80, 9);
    expect(current.filterCent).toBeCloseTo(-1920, 9);

    context.currentTime = .38;
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.4, 9);
    expect(transport.position('1', 'pitch')?.elapsed).toBeCloseTo(.4, 9);
    transport.stop('1');
  });
});
