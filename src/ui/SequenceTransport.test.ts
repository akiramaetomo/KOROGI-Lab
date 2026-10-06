import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';
import type { SequenceSettings } from '../audio/types';
import { SequenceTransport } from './SequenceTransport';

afterEach(() => vi.unstubAllGlobals());

describe('SequenceTransport timing', () => {
  it('keeps each timbre and each lane on its own loop period after Play All', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const synths = { '1': {} as ChannelSynth, '2': {} as ChannelSynth };
    const engine = {
      context, getChannelIds: () => ['1', '2'], getChannel: (id: '1' | '2') => synths[id],
      getSequenceSelection: () => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1 }),
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: 1 }),
      getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (id: string) => ({ durationSec: id === '1' ? 1 : 2, selectionStartSec: 0,
        selectionEndSec: id === '1' ? 1 : 2, gates: [{ onSec: 0, offSec: .2 }] }),
      getPitchRecording: () => ({ durationSec: 1.5, selectionStartSec: 0, selectionEndSec: 1.5,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1.5, valueNormalized: 0 }] }),
      gateOn: () => {}, gateOff: () => {}, cancelScheduledGates: () => {}, resetSequencePitch: () => {}, setSequencePitch: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});
    await transport.playAll();
    context.currentTime = 1.88;
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.8);
    expect(transport.position('1', 'pitch')?.elapsed).toBeCloseTo(.3);
    expect(transport.position('2', 'gate')?.elapsed).toBeCloseTo(1.8);
    transport.stopAll();
  });
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
  it('keeps looping a Gate selection that contains no Gates', async () => {
    const ticks: Array<() => void> = [];
    vi.stubGlobal('window', { setInterval: (tick: () => void) => { ticks.push(tick); return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const synth = { isAutoTriggerRunning: () => false } as ChannelSynth;
    const gateOns: number[] = [];
    let recording = { durationSec: 4, selectionStartSec: 0, selectionEndSec: 2, gates: [{ onSec: .5, offSec: .7 }] };
    const engine = {
      context, getChannelIds: () => ['1'], getChannel: (id: string) => id === '1' ? synth : undefined,
      getSequenceSelection: () => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1 }),
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: 1 }),
      getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: () => recording, getPitchRecording: () => null,
      gateOn: (_id: string, time: number) => gateOns.push(time), gateOff: () => {},
      cancelScheduledGates: () => {}, cancelScheduledGatesFrom: () => {}, resetSequencePitch: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});

    await transport.play('1');
    context.currentTime = 1;
    recording = { ...recording, selectionStartSec: 2.5, selectionEndSec: 3.5 };
    transport.gateRecordingChanged('1', 'user-1');
    const onsBefore = gateOns.length;
    context.currentTime = 1.9;
    ticks.forEach(tick => tick());
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(1.82, 9);
    context.currentTime = 2.38;
    ticks.forEach(tick => tick());
    expect(transport.isPlaying('1')).toBe(true);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.3, 9);
    expect(transport.position('1', 'gate')?.start).toBe(2.5);
    context.currentTime = 3.18;
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.1, 9);
    expect(gateOns.length).toBe(onsBefore);
    transport.stop('1');
  });
  it('starts Play on a Gate selection that contains no Gates', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const synth = { isAutoTriggerRunning: () => false } as ChannelSynth;
    const gateOns: number[] = [];
    const engine = {
      context, getChannelIds: () => ['1'], getChannel: (id: string) => id === '1' ? synth : undefined,
      getSequenceSelection: () => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1 }),
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: 1 }),
      getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: () => ({ durationSec: 4, selectionStartSec: 1, selectionEndSec: 2, gates: [{ onSec: 3, offSec: 3.5 }] }),
      getPitchRecording: () => null,
      gateOn: (_id: string, time: number) => gateOns.push(time), gateOff: () => {},
      cancelScheduledGates: () => {}, resetSequencePitch: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});

    await transport.play('1');
    context.currentTime = 1.58;
    expect(transport.isPlaying('1')).toBe(true);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.5, 9);
    expect(gateOns).toEqual([]);
    transport.stop('1');
  });
});
