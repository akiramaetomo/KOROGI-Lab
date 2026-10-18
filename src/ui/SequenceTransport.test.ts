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
      gateOn: () => {}, gateOff: () => {}, cancelScheduledGates: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, setSequencePitch: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});
    await transport.playAll();
    context.currentTime = 1.88;
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.8);
    expect(transport.position('1', 'pitch')?.elapsed).toBeCloseTo(.3);
    expect(transport.position('2', 'gate')?.elapsed).toBeCloseTo(1.8);
    // 1 s, 1.5 s and 2 s loops drift apart: Play All warns.
    expect(transport.playAllMismatch()).toBe(true);
    transport.stopAll();
    expect(transport.playAllMismatch()).toBe(false);
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
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}
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
      cancelScheduledGates: () => {}, cancelScheduledGatesFrom: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}
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
      cancelScheduledGates: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});

    await transport.play('1');
    context.currentTime = 1.58;
    expect(transport.isPlaying('1')).toBe(true);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.5, 9);
    expect(gateOns).toEqual([]);
    transport.stop('1');
  });
  it('warns only when loop periods are not whole multiples of each other (within 1 ms)', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const warns = async (lengths: Record<'1' | '2', number>) => {
      const synths = { '1': {} as ChannelSynth, '2': {} as ChannelSynth };
      const engine = {
        context: { currentTime: 0, state: 'running' }, getChannelIds: () => ['1', '2'], getChannel: (id: '1' | '2') => synths[id],
        getSequenceSelection: () => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1 }),
        getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: 1 }),
        getGateMuted: () => false, getPitchMuted: () => false,
        getGateRecording: (id: '1' | '2') => ({ durationSec: lengths[id], selectionStartSec: 0, selectionEndSec: lengths[id], gates: [{ onSec: 0, offSec: .05 }] }),
        getPitchRecording: () => null,
        gateOn: () => {}, gateOff: () => {}, cancelScheduledGates: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}
      } as unknown as AudioEngine;
      const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});
      await transport.playAll();
      const result = transport.playAllMismatch();
      transport.stopAll();
      return result;
    };
    expect(await warns({ '1': 2, '2': .5 })).toBe(false);
    expect(await warns({ '1': 2, '2': .503 })).toBe(true);
    expect(await warns({ '1': 1.5, '2': .5 })).toBe(false);
    expect(await warns({ '1': 2, '2': 2.0005 })).toBe(false);
    expect(await warns({ '1': 2, '2': 3 })).toBe(true);
  });
  it('does not warn when every playing timbre loops with the same real period', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const synths = { '1': {} as ChannelSynth, '2': {} as ChannelSynth };
    const engine = {
      context, getChannelIds: () => ['1', '2'], getChannel: (id: '1' | '2') => synths[id],
      // Timbre 2 loops 2 s at Play Speed 2, the same 1 s real period as Timbre 1.
      getSequenceSelection: (id: string) => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: id === '2' ? 2 : 1 }),
      getSequenceSettings: (id: string) => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: id === '2' ? 2 : 1 }),
      getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (id: string) => ({ durationSec: id === '1' ? 1 : 2, selectionStartSec: 0,
        selectionEndSec: id === '1' ? 1 : 2, gates: [{ onSec: 0, offSec: .2 }] }),
      getPitchRecording: () => null,
      gateOn: () => {}, gateOff: () => {}, cancelScheduledGates: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});
    await transport.playAll();
    expect(transport.playingPeriods().map(item => item.seconds)).toEqual([1, 1]);
    expect(transport.playAllMismatch()).toBe(false);
    transport.stopAll();
  });
  it('keeps the loop clock through lane Mute, sends no muted Gate ON and resumes at the current phase', async () => {
    const ticks: Array<() => void> = [];
    vi.stubGlobal('window', { setInterval: (tick: () => void) => { ticks.push(tick); return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const synth = { isAutoTriggerRunning: () => false } as ChannelSynth;
    const muted = { gate: true, pitch: true };
    const gateOns: number[] = [], gateOffs: number[] = [], cancels: number[] = [];
    const pitchMute: boolean[] = [];
    const engine = {
      context, getChannelIds: () => ['1'], getChannel: (id: string) => id === '1' ? synth : undefined,
      getSequenceSelection: () => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1 }),
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: 1 }),
      getGateMuted: () => muted.gate, getPitchMuted: () => muted.pitch,
      getGateRecording: () => ({ durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: 0, offSec: .5 }] }),
      getPitchRecording: () => ({ durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1, valueNormalized: 1 }] }),
      gateOn: (_id: string, time: number) => gateOns.push(time), gateOff: (_id: string, time: number) => gateOffs.push(time),
      cancelScheduledGates: () => {}, cancelScheduledGatesFrom: (_id: string, time: number) => cancels.push(time),
      setSequencePitch: () => {}, resetSequencePitch: () => {},
      setSequencePitchMuted: (_id: string, value: boolean) => pitchMute.push(value)
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {}, () => {});

    // Both lanes muted still play: the clock runs silently instead of reporting no Sequence data.
    await transport.play('1');
    expect(transport.isPlaying('1')).toBe(true);
    expect(pitchMute).toEqual([true]);
    context.currentTime = 1.3; ticks.forEach(tick => tick());
    expect(gateOns).toEqual([]);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.22, 9);
    expect(transport.position('1', 'pitch')?.elapsed).toBeCloseTo(.22, 9);

    // Unmute inside a Gate: ON now, phase unchanged.
    muted.gate = false; muted.pitch = false;
    transport.laneMutedChanged('1', 'gate'); transport.laneMutedChanged('1', 'pitch');
    expect(gateOns).toEqual([1.3]);
    expect(pitchMute).toEqual([true, false]);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.22, 9);

    // Mute again: the held Gate is released now and the clock keeps going.
    context.currentTime = 1.4; muted.gate = true;
    transport.laneMutedChanged('1', 'gate');
    expect(cancels).toEqual([1.4]); expect(gateOffs.at(-1)).toBe(1.4);
    context.currentTime = 2.2; ticks.forEach(tick => tick());
    expect(gateOns).toEqual([1.3]);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.12, 9);
    transport.stop('1');
    expect(pitchMute.at(-1)).toBe(false);
  });
  it('keeps backing timbres on the recording loop and leaves the recording monitor to the recorder', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const synths = { '1': {} as ChannelSynth, '2': {} as ChannelSynth };
    const engine = {
      context, getChannelIds: () => ['1', '2'], getChannel: (id: '1' | '2') => synths[id],
      getSequenceSelection: () => ({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1', recordSpeed: 1, playSpeed: 1 }),
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: 1 }),
      getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: () => ({ durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates: [{ onSec: 0, offSec: .1 }] }),
      getPitchRecording: () => null,
      gateOn: () => {}, gateOff: () => {}, cancelScheduledGates: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});
    await transport.play('2');
    context.currentTime = .7;
    // Recording Timbre 1 starts at 1.0 s: the playing Timbre 2 restarts with it.
    transport.setRecordingTarget('1', 'both');
    transport.restartOthersAt(1);
    transport.playRetained('1', { gate: 1, pitch: 1 }, 1, true, true, 1);
    context.currentTime = 1.5;
    expect(transport.position('2', 'gate')?.elapsed).toBeCloseTo(.5);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.5);
    // Play All / Stop All act on the other timbres only; a press mid-bar waits for the next bar.
    transport.setStartAligner(earliest => Math.ceil(earliest - 1) + 1);
    expect(transport.anyPlaying()).toBe(true);
    transport.stopAll();
    expect(transport.anyPlaying()).toBe(false);
    expect(transport.isPlaying('1')).toBe(true);
    await transport.playAll();
    expect(transport.isPlaying('1')).toBe(true);
    context.currentTime = 2.25;
    expect(transport.position('2', 'gate')?.elapsed).toBeCloseTo(.25);
    transport.setRecordingTarget(null);
    expect(transport.isPlaying('1')).toBe(false);
    transport.stopAll();
  });
});

describe('SequenceTransport Stretch', () => {
  type Gate = { durationSec: number; selectionStartSec: number; selectionEndSec: number; gates: Array<{ onSec: number; offSec: number }> };
  function setup(timbres: Record<string, { stretch: boolean; gateUserId?: string; gates: Record<string, Gate> }>, bars: number[], bpm = 120) {
    const timers = new Map<number, () => void>(); let nextTimer = 0;
    vi.stubGlobal('window', { setInterval: (tick: () => void) => { timers.set(++nextTimer, tick); return nextTimer; },
      clearInterval: (timer: number) => { timers.delete(timer); } });
    const context = { currentTime: 0, state: 'running' };
    const song = { bpm, speed: 1, frameBars: 4, timingMode: 'original' };
    const calls = { gateOns: [] as Array<[string, number]>, gateCancels: [] as Array<[string, number]>, songCancels: [] as Array<[string, number]> };
    const synth = { isAutoTriggerRunning: () => false } as ChannelSynth;
    const selection = (id: string) => ({ gateMode: 'user', gateUserId: timbres[id]!.gateUserId ?? 'user-1', pitchUserId: 'user-1',
      recordSpeed: 1, playSpeed: 1, stretch: timbres[id]!.stretch });
    const engine = {
      context, getChannelIds: () => Object.keys(timbres), getChannel: (id: string) => timbres[id] ? synth : undefined,
      getSongSettings: () => structuredClone(song),
      getSequenceSelection: selection,
      setSequenceSelection: (id: string, changes: Record<string, unknown>) => { Object.assign(timbres[id]!, changes); },
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0, filterAmountWide: false, recordSpeed: 1, playSpeed: 1 }),
      getGateMuted: () => false, getPitchMuted: () => false,
      // Every timbre here uses the same bars per Pattern number.
      getPatternBars: (_id: string, user: string) => bars[Number(user.slice(-1)) - 1]!,
      getGateRecording: (id: string, user: string) => timbres[id]!.gates[user] ?? null, getPitchRecording: () => null,
      gateOn: (id: string, time: number) => calls.gateOns.push([id, time]), gateOff: () => {},
      cancelScheduledGates: () => {}, cancelScheduledGatesFrom: (id: string, time: number) => calls.gateCancels.push([id, time]),
      cancelSongFuture: (id: string, time: number) => calls.songCancels.push([id, time]),
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, holdSequencePitch: () => 0
    } as unknown as AudioEngine;
    const transport = new SequenceTransport(() => engine, async () => {}, () => {}, () => {}, () => {});
    const advance = (time: number) => {
      while (context.currentTime < time - 1e-9) {
        context.currentTime = Math.min(time, context.currentTime + .015);
        [...timers.values()].forEach(tick => tick());
      }
    };
    return { transport, context, song, bars, calls, advance };
  }
  const gate = (length: number, gates: Array<{ onSec: number; offSec: number }>): Gate =>
    ({ durationSec: length, selectionStartSec: 0, selectionEndSec: length, gates });

  it('fits each selection to its Pattern bars and starts a later Stretch timbre on the next bar head', async () => {
    // 120 BPM: one bar is 2 s. Timbre 1 fits 1.5 s to 1 bar; Timbre 2 fits 3 s (Pattern 2) to 2 bars.
    const { transport, calls, advance } = setup({
      '1': { stretch: true, gates: { 'user-1': gate(1.5, [{ onSec: 0, offSec: .1 }]) } },
      '2': { stretch: true, gateUserId: 'user-2', gates: { 'user-2': gate(3, [{ onSec: 0, offSec: .1 }]) } }
    }, [1, 2, 1, 1, 1, 1, 1, 1]);
    await transport.play('1');
    advance(1.08);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.75, 9);
    await transport.play('2');
    advance(3.08);
    expect(calls.gateOns.filter(([id]) => id === '2').map(([, time]) => time)).toEqual([2.08]);
    expect(transport.position('2', 'gate')?.elapsed).toBeCloseTo(.75, 9);
    expect(transport.playingPeriods().map(item => item.seconds)).toEqual([2, 4]);
    // Whole bars on one grid do not drift.
    expect(transport.playAllMismatch()).toBe(false);
    transport.stopAll();
  });
  it('switches a Stretch Pattern at the next bar head without a doubled or early Gate', async () => {
    const { transport, calls, advance } = setup({
      '1': { stretch: true, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .5 }]), 'user-2': gate(.5, [{ onSec: .25, offSec: .3 }]) } }
    }, [1, 1, 1, 1, 1, 1, 1, 1]);
    await transport.play('1');
    advance(.5);
    transport.setSelection('1', { gateUserId: 'user-2' });
    // The old Pattern keeps playing to the bar head at 2.08 s; the new one starts there.
    expect(transport.position('1', 'gate')?.start).toBe(0);
    expect(transport.position('1', 'gate')?.period).toBe(1);
    advance(3.2);
    expect(calls.gateCancels).toEqual([['1', 2.08]]);
    expect(calls.gateOns.map(([, time]) => time)).toEqual([.08, 2.08 + .25 * 4]);
    expect(transport.position('1', 'gate')?.period).toBe(.5);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(1.12 / 4, 9);
    transport.stop('1');
  });
  it('hands a playing recording target to its monitor on the next bar head and leaves the backing running', async () => {
    // 120 BPM: one bar is 2 s. Timbre 1 has Gates at the bar head and mid-bar; both loop 1 bar from 0.08 s.
    const { transport, calls, advance } = setup({
      '1': { stretch: true, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .1 }, { onSec: .5, offSec: .6 }]) } },
      '2': { stretch: true, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .1 }]) } }
    }, [1, 1, 1, 1, 1, 1, 1, 1]);
    await transport.playAll();
    advance(.5);
    expect(transport.nextGridBar(.53)).toBeCloseTo(2.08, 9);
    transport.setRecordingTarget('1', 'gate');
    // The recorder starts on the bar head; the old playback keeps its mid-bar Gate until then.
    transport.playRetained('1', { gate: .5, pitch: .5 }, 1, true, false, 2.08);
    advance(4.2);
    const ons = (id: string) => calls.gateOns.filter(([item]) => item === id).map(([, time]) => time);
    expect(ons('1')).toEqual([.08, 1.08, 2.08, 3.08, 4.08]);
    expect(ons('2')).toEqual([.08, 2.08, 4.08]);
    expect(calls.gateCancels).toEqual([['1', 2.08]]);
    transport.setRecordingTarget(null);
    transport.stopAll();
  });
  it('has no bar grid to wait for when no other Stretch timbre plays', async () => {
    const { transport, advance } = setup({
      '1': { stretch: true, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .1 }]) } },
      '2': { stretch: false, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .1 }]) } }
    }, [1, 1, 1, 1, 1, 1, 1, 1]);
    await transport.playAll();
    advance(.5);
    expect(transport.nextGridBar(.53, '1')).toBeNull();
    expect(transport.nextGridBar(.53, '2')).toBeCloseTo(2.08, 9);
    transport.stopAll();
  });
  it('rescales the bar grid on a BPM change at the current position without re-sending ON', async () => {
    const { transport, song, calls, advance } = setup({
      '1': { stretch: true, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .8 }]) } }
    }, [1, 1, 1, 1, 1, 1, 1, 1]);
    await transport.play('1');
    advance(.58);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.25, 9);
    song.bpm = 60;
    transport.stretchTimingChanged();
    expect(calls.songCancels).toEqual([['1', .58]]);
    expect(calls.gateOns.map(([, time]) => time)).toEqual([.08]);
    advance(1.58);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.5, 9);
    transport.stop('1');
  });
  it('restarts a loop whose bar count changed on the next bar head', async () => {
    const { transport, bars, calls, advance } = setup({
      '1': { stretch: true, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .1 }]) } }
    }, [1, 1, 1, 1, 1, 1, 1, 1]);
    await transport.play('1');
    advance(.5);
    bars[0] = 2;
    transport.stretchTimingChanged();
    advance(2.5);
    expect(calls.gateCancels).toEqual([['1', 2.08]]);
    expect(transport.playingPeriods().map(item => item.seconds)).toEqual([4]);
    expect(transport.position('1', 'gate')?.elapsed).toBeCloseTo(.42 / 4, 9);
    transport.stop('1');
  });
  it('warns when a timbre at its own speed loops against the bar grid', async () => {
    const { transport, advance } = setup({
      '1': { stretch: true, gates: { 'user-1': gate(1, [{ onSec: 0, offSec: .1 }]) } },
      '2': { stretch: false, gates: { 'user-1': gate(1.5, [{ onSec: 0, offSec: .1 }]) } }
    }, [1, 1, 1, 1, 1, 1, 1, 1]);
    await transport.playAll();
    advance(.2);
    expect(transport.playAllMismatch()).toBe(true);
    transport.stopAll();
  });
});
