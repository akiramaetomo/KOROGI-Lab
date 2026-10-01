import { describe, expect, it, vi } from 'vitest';
import { SongTransport } from './SongTransport';
import type { AudioEngine } from '../audio/core/AudioEngine';
import type { SongSettings, TriggerRecording } from '../audio/types';

describe('SongTransport', () => {
  it('fits independent Gate and Pitch selections to the Bars boundary', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const gates: Array<{ kind: string; time: number }> = [];
    const pitches: Array<{ value: number; time: number; transition: number }> = [];
    const engine = {
      context, getSongSettings: () => ({ bpm: 60, speed: 1, bars: [1, 1, 1, 1, 1, 1, 1, 1], timingMode: 'bars' }),
      getChannelIds: () => ['1'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: false } }) }), getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
        gates: [{ onSec: .5, offSec: 3.5 }] } : null,
      getPitchRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1, valueNormalized: 0 },
          { timeSec: 2, valueNormalized: 1 }, { timeSec: 3, valueNormalized: 0 }, { timeSec: 4, valueNormalized: 0 }] } : null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      gateOn: (_id: string, time: number) => gates.push({ kind: 'on', time }),
      gateOff: (_id: string, time: number) => gates.push({ kind: 'off', time }),
      setSequencePitch: (_id: string, value: number, _scale: number, _filter: number, time: number, transition: number) => pitches.push({ value, time, transition }),
      resetSequencePitch: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    await song.play(); context.currentTime = 4.1; tick();
    expect(gates.some(event => event.kind === 'on' && Math.abs(event.time - .08) < 1e-9)).toBe(true);
    expect(gates.some(event => event.kind === 'off' && Math.abs(event.time - 4.08) < 1e-9)).toBe(true);
    expect(gates.filter(event => event.kind === 'on')).toHaveLength(2);
    expect(pitches.some(event => event.value === 1 && Math.abs(event.time - .08) < 1e-9 && event.transition === 2)).toBe(true);
    song.stop(); vi.unstubAllGlobals();
  });
  it('fits each Timbre selection independently on one bar clock and skips empty USER slots', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const calls: Array<{ id: string; kind: string; time: number }> = [];
    const settings: SongSettings = { bpm: 120, speed: 1, bars: [1, 1, 1, 1, 1, 1, 1, 1], timingMode: 'bars' };
    const recordings: Record<string, TriggerRecording> = {
      '1': { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .2, offSec: .4 }] },
      '2': { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates: [{ onSec: .2, offSec: .4 }] }
    };
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1', '2'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (id: string, user: string) => user === 'user-1' ? recordings[id] : null,
      getPitchRecording: () => null,
      gateOn: (id: string, time: number) => calls.push({ id, kind: 'on', time }),
      gateOff: (id: string, time: number) => calls.push({ id, kind: 'off', time }),
      resetSequencePitch: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    await song.play();
    context.currentTime = 1; tick();
    expect(calls.filter(call => call.kind === 'on').map(call => ({ id: call.id, time: Number(call.time.toFixed(2)) }))).toEqual([
      { id: '2', time: .28 }, { id: '1', time: .48 }
    ]);
    context.currentTime = 2.2; tick();
    expect(song.position()).toMatchObject({ user: 1, bar: 1, beat: 1 });
    expect(calls.filter(call => call.kind === 'on')).toHaveLength(2);
    song.stop(); vi.unstubAllGlobals();
  });
  it('uses the longest Gate across Timbres, loops a shorter Pitch, and skips empty USERs', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const gates: Array<{ kind: string; time: number }> = [];
    const pitches: Array<{ value: number; time: number; transition: number }> = [];
    const engine = {
      context, getSongSettings: () => ({ bpm: 120, speed: 1, bars: [1, 1, 1, 1, 1, 1, 1, 1], timingMode: 'original' }),
      getChannelIds: () => ['1', '2'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (id: string, user: string) => id === '1' && user === 'user-1'
        ? { durationSec: 3, selectionStartSec: 0, selectionEndSec: 3, gates: [{ onSec: .5, offSec: 1 }] }
        : id === '1' && user === 'user-2' ? { durationSec: 4, selectionStartSec: 0, selectionEndSec: 4, gates: [{ onSec: 1, offSec: 2 }] }
          : id === '2' && user === 'user-2' ? { durationSec: 5, selectionStartSec: 0, selectionEndSec: 5, gates: [{ onSec: 2, offSec: 3 }] } : null,
      getPitchRecording: (id: string, user: string) => id === '1' && user === 'user-1' ? { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1, valueNormalized: 1 }] }
        : id === '1' && user === 'user-2' ? { durationSec: 6, selectionStartSec: 0, selectionEndSec: 6,
          points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 5.5, valueNormalized: 1 }, { timeSec: 6, valueNormalized: 0 }] } : null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      gateOn: (_id: string, time: number) => gates.push({ kind: 'on', time }),
      gateOff: (_id: string, time: number) => gates.push({ kind: 'off', time }),
      setSequencePitch: (_id: string, value: number, _scale: number, _filter: number, time: number, transition: number) => pitches.push({ value, time, transition }),
      resetSequencePitch: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(section => section.duration)).toEqual([3, 5]);
    expect(await song.play()).toBe(true);
    context.currentTime = 4.1; tick();
    expect(gates.some(event => event.kind === 'on' && Math.abs(event.time - .58) < 1e-9)).toBe(true);
    expect(gates.some(event => event.kind === 'on' && Math.abs(event.time - 4.08) < 1e-9)).toBe(true);
    expect(pitches.some(event => event.value === 1 && Math.abs(event.time - .08) < 1e-9 && event.transition === 1)).toBe(true);
    expect(pitches.some(event => event.value === 1 && Math.abs(event.time - 1.08) < 1e-9 && event.transition === 1)).toBe(true);
    expect(pitches.some(event => Math.abs(event.time - 3.08) < 1e-9 && event.transition === 5 && Math.abs(event.value - 5 / 5.5) < 1e-9)).toBe(true);
    expect(song.position()).toMatchObject({ user: 2, userDurationSec: 5 });
    context.currentTime = 8.7; tick();
    expect(gates.some(event => event.kind === 'on' && Math.abs(event.time - 8.58) < 1e-9)).toBe(true);
    song.stop(); vi.unstubAllGlobals();
  });
  it('skips a middle USER with Pitch only in both modes and follows BPM only in Bars', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const settings: SongSettings = { bpm: 120, speed: 1, bars: [1, 1, 2, 1, 1, 1, 1, 1], timingMode: 'original' };
    const gate = (durationSec: number): TriggerRecording => ({ durationSec, selectionStartSec: 0, selectionEndSec: durationSec,
      gates: [{ onSec: .1, offSec: .2 }] });
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? gate(1) : user === 'user-3' ? gate(3) : null,
      getPitchRecording: (_id: string, user: string) => user === 'user-2' ? { durationSec: 4, selectionStartSec: 0, selectionEndSec: 4,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 4, valueNormalized: 1 }] } : null,
      getGateMuted: () => false, getPitchMuted: () => false, getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      gateOn: () => {}, gateOff: () => {}, resetSequencePitch: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(({ user, offset, duration }) => ({ user, offset, duration }))).toEqual([
      { user: 1, offset: 0, duration: 1 }, { user: 3, offset: 1, duration: 3 }
    ]);
    settings.timingMode = 'bars';
    expect(song.preview().map(({ user, offset, duration }) => ({ user, offset, duration }))).toEqual([
      { user: 1, offset: 0, duration: 2 }, { user: 3, offset: 2, duration: 4 }
    ]);
    settings.bpm = 60;
    expect(song.preview().map(section => section.duration)).toEqual([4, 8]);
    settings.timingMode = 'original';
    expect(song.preview().map(section => section.duration)).toEqual([1, 3]);
    song.stop(); vi.unstubAllGlobals();
  });
  it('does not start when every USER lacks a Gate recording', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const engine = {
      context: { currentTime: 0, state: 'running' }, getSongSettings: () => ({ bpm: 120, speed: 1, bars: [1, 1, 1, 1, 1, 1, 1, 1], timingMode: 'bars' }),
      getChannelIds: () => ['1'], getChannel: () => ({}), getGateRecording: () => null,
      getPitchRecording: () => ({ durationSec: 1, selectionStartSec: 0, selectionEndSec: 1 })
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview()).toEqual([]);
    expect(await song.play()).toBe(false);
    vi.unstubAllGlobals();
  });
  it('fits a long Gate selection into Bars without losing later events', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const onTimes: number[] = [];
    const engine = {
      context, getSongSettings: () => ({ bpm: 120, speed: 1, bars: [1, 1, 1, 1, 1, 1, 1, 1], timingMode: 'bars' }),
      getChannelIds: () => ['1'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 4, selectionStartSec: 0, selectionEndSec: 4,
        gates: [{ onSec: .5, offSec: .7 }, { onSec: 3, offSec: 3.2 }] } : null,
      getPitchRecording: () => null, getGateMuted: () => false, getPitchMuted: () => false,
      gateOn: (_id: string, time: number) => onTimes.push(time), gateOff: () => {}, resetSequencePitch: () => {},
      cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(section => section.duration)).toEqual([2]);
    await song.play(); context.currentTime = 4.1; tick();
    expect(onTimes).toEqual([.33, 1.58, 2.33, 3.58]);
    song.stop(); vi.unstubAllGlobals();
  });
  it('combines BPM and Song Speed and retimes a playing USER without retriggering its held Gate', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const settings: SongSettings = { bpm: 120, speed: 1, bars: [1, 1, 1, 1, 1, 1, 1, 1], timingMode: 'bars' };
    const onTimes: number[] = [], offTimes: number[] = [], cancelled: number[] = [];
    const pitches: Array<{ time: number; transition: number; value: number }> = [];
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1'], getChannel: () => ({}),
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 2, selectionStartSec: 0,
        selectionEndSec: 2, gates: [{ onSec: 0, offSec: 1 }] } : null,
      getPitchRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 2, selectionStartSec: 0,
        selectionEndSec: 2, points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 2, valueNormalized: 1 }] } : null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      getGateMuted: () => false, getPitchMuted: () => false,
      gateOn: (_id: string, time: number) => onTimes.push(time), gateOff: (_id: string, time: number) => offTimes.push(time),
      setSequencePitch: (_id: string, value: number, _scale: number, _filter: number, time: number, transition: number) => pitches.push({ value, time, transition }),
      resetSequencePitch: () => {}, cancelScheduledGates: () => {},
      cancelSongFuture: (_id: string, time: number) => { cancelled.push(time); for (let i = offTimes.length - 1; i >= 0; i -= 1)
        if (offTimes[i]! > time) offTimes.splice(i, 1); }, holdSequencePitch: () => 0
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    await song.play(); context.currentTime = .04; tick();
    expect(onTimes).toEqual([.08]);
    context.currentTime = .5; tick();
    settings.bpm = 240; settings.speed = 2;
    expect(song.preview()[0]!.duration).toBe(.5);
    song.updateTiming();
    expect(song.position()?.user).toBe(1);
    expect(song.position()?.userElapsedSec).toBeCloseTo(.105);
    expect(cancelled).toEqual([.5]);
    expect(onTimes).toEqual([.08]);
    expect(pitches.some(pitch => pitch.time === .5 && pitch.value === 1 && Math.abs(pitch.transition - .395) < 1e-9)).toBe(true);
    context.currentTime = .60; tick();
    expect(offTimes).toEqual([.08, .645]);
    song.stop(); vi.unstubAllGlobals();
  });
});
