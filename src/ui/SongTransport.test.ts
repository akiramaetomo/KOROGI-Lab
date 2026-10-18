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
      context, getSongSettings: () => ({ bpm: 60, speed: 1, frameBars: 1, timingMode: 'bars' }),
      getChannelIds: () => ['1'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: false } }) }), getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
        gates: [{ onSec: .5, offSec: 3.5 }] } : null,
      getPitchRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1, valueNormalized: 0 },
          { timeSec: 2, valueNormalized: 1 }, { timeSec: 3, valueNormalized: 0 }, { timeSec: 4, valueNormalized: 0 }] } : null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      gateOn: (_id: string, time: number) => gates.push({ kind: 'on', time }),
      gateOff: (_id: string, time: number) => gates.push({ kind: 'off', time }),
      setSequencePitch: (_id: string, value: number, _scale: number, _filter: number, time: number, transition: number) => pitches.push({ value, time, transition }),
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {}
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
    const settings: SongSettings = { bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' };
    const recordings: Record<string, TriggerRecording> = {
      '1': { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .2, offSec: .4 }] },
      '2': { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates: [{ onSec: .2, offSec: .4 }] }
    };
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1', '2'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (id: string, user: string) => user === 'user-1' ? recordings[id] : null,
      getPitchRecording: () => null,
      gateOn: (id: string, time: number) => calls.push({ id, kind: 'on', time }),
      gateOff: (id: string, time: number) => calls.push({ id, kind: 'off', time }),
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {}
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
      context, getSongSettings: () => ({ bpm: 120, speed: 1, frameBars: 1, timingMode: 'original' }),
      getChannelIds: () => ['1', '2'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
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
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {}
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
  it('loops each timbre at its Play/Rec Speed inside a Seconds section set by the longest one (ADR 0010)', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const ons: Array<{ id: string; time: number }> = [];
    const engine = {
      context, getSongSettings: () => ({ bpm: 120, speed: 2, frameBars: 1, timingMode: 'original' }),
      getChannelIds: () => ['1', '2'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getPatternInSong: () => true, getPatternBars: () => 1, getGateMuted: () => false, getPitchMuted: () => false,
      // Timbre 1: 4 s at 1× → 4 s; Timbre 2: 1.5 s at 0.5× → 3 s. Song Speed 2 halves both: the section is 2 s.
      getSequenceSelection: (id: string) => ({ playSpeed: id === '1' ? 1 : .5 }),
      getGateRecording: (id: string, user: string) => user !== 'user-1' ? null : id === '1'
        ? { durationSec: 4, selectionStartSec: 0, selectionEndSec: 4, gates: [{ onSec: 1, offSec: 2 }] }
        : { durationSec: 1.5, selectionStartSec: 0, selectionEndSec: 1.5, gates: [{ onSec: .2, offSec: .4 }] },
      getPitchRecording: () => null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      gateOn: (id: string, time: number) => ons.push({ id, time }), gateOff: () => {},
      setSequencePitch: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(section => section.duration)).toEqual([2]);
    expect(await song.play()).toBe(true);
    context.currentTime = 3; tick();
    const times = (id: string) => ons.filter(event => event.id === id).map(event => Math.round(event.time * 1000) / 1000);
    // Timbre 2 loops its 1.5 s Gate within the section, then the section head restarts it.
    expect(times('2')).toEqual([.28, 1.78, 2.28]);
    expect(times('1')).toEqual([.58, 2.58]);
    song.stop(); vi.unstubAllGlobals();
  });
  it('skips a middle USER with Pitch only in both modes, gives every Bars section the Frame and follows BPM only in Bars', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const settings: SongSettings = { bpm: 120, speed: 1, frameBars: 2, timingMode: 'original' };
    const gate = (durationSec: number): TriggerRecording => ({ durationSec, selectionStartSec: 0, selectionEndSec: durationSec,
      gates: [{ onSec: .1, offSec: .2 }] });
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? gate(1) : user === 'user-3' ? gate(3) : null,
      getPitchRecording: (_id: string, user: string) => user === 'user-2' ? { durationSec: 4, selectionStartSec: 0, selectionEndSec: 4,
        points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 4, valueNormalized: 1 }] } : null,
      getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false, getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      gateOn: () => {}, gateOff: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(({ user, offset, duration }) => ({ user, offset, duration }))).toEqual([
      { user: 1, offset: 0, duration: 1 }, { user: 3, offset: 1, duration: 3 }
    ]);
    settings.timingMode = 'bars';
    expect(song.preview().map(({ user, offset, duration }) => ({ user, offset, duration }))).toEqual([
      { user: 1, offset: 0, duration: 4 }, { user: 3, offset: 4, duration: 4 }
    ]);
    settings.bpm = 60;
    expect(song.preview().map(section => section.duration)).toEqual([8, 8]);
    settings.speed = 2;
    expect(song.preview().map(section => section.duration)).toEqual([8, 8]);
    settings.bpm = 30;
    expect(song.preview().map(section => section.duration)).toEqual([16, 16]);
    settings.timingMode = 'original';
    expect(song.preview().map(section => section.duration)).toEqual([.5, 1.5]);
    settings.speed = 1;
    expect(song.preview().map(section => section.duration)).toEqual([1, 3]);
    song.stop(); vi.unstubAllGlobals();
  });
  it('loops each timbre at its Pattern bars inside a Bars section of the Frame, cut at the end, and fits a longer Pattern to the Frame (ADR 0011)', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const gates: Array<{ id: string; kind: string; time: number }> = [];
    // 120 BPM, Frame 4 bars (8 s). Timbre 1: a 3-bar Pattern (6 s loop) plays "3 + the first 1". Timbre 2: an 8-bar Pattern fits the 4-bar Frame.
    const engine = {
      context, getSongSettings: () => ({ bpm: 120, speed: 1, frameBars: 4, timingMode: 'bars' }),
      getChannelIds: () => ['1', '2'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getPatternInSong: () => true, getPatternBars: (id: string) => id === '1' ? 3 : 8,
      getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (id: string, user: string) => user !== 'user-1' ? null : id === '1'
        ? { durationSec: 6, selectionStartSec: 0, selectionEndSec: 6, gates: [{ onSec: .5, offSec: 1 }] }
        : { durationSec: 16, selectionStartSec: 0, selectionEndSec: 16, gates: [{ onSec: 12, offSec: 13 }] },
      getPitchRecording: () => null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      gateOn: (id: string, time: number) => gates.push({ id, kind: 'on', time }),
      gateOff: (id: string, time: number) => gates.push({ id, kind: 'off', time }),
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(section => section.duration)).toEqual([8]);
    expect(await song.play()).toBe(true);
    for (const time of [2, 4, 6, 8.2, 10, 12, 14.2, 14.6]) { context.currentTime = time; tick(); }
    const ons = (id: string) => gates.filter(event => event.id === id && event.kind === 'on').map(event => Math.round(event.time * 100) / 100);
    // Laps start at 0 and 6 s; the Frame end at 8 s cuts the second lap, and the next Frame starts the Pattern again.
    expect(ons('1')).toEqual([.58, 6.58, 8.58, 14.58]);
    // 16 s of selection play in the 8 s Frame: the Gate at 12 s sounds at 6 s.
    expect(ons('2')).toEqual([6.08, 14.08]);
    song.stop(); vi.unstubAllGlobals();
  });
  it('does not start when every USER lacks a Gate recording', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
    const engine = {
      context: { currentTime: 0, state: 'running' }, getSongSettings: () => ({ bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' }),
      getChannelIds: () => ['1'], getChannel: () => ({}), getGateRecording: () => null, getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }),
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
      context, getSongSettings: () => ({ bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' }),
      getChannelIds: () => ['1'], getChannel: () => ({ getSettings: () => ({ blocksEnabled: { aenv: true } }) }),
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 4, selectionStartSec: 0, selectionEndSec: 4,
        gates: [{ onSec: .5, offSec: .7 }, { onSec: 3, offSec: 3.2 }] } : null,
      getPitchRecording: () => null, getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
      gateOn: (_id: string, time: number) => onTimes.push(time), gateOff: () => {}, resetSequencePitch: () => {}, setSequencePitchMuted: () => {},
      cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(section => section.duration)).toEqual([2]);
    await song.play(); context.currentTime = 4.1; tick();
    expect(onTimes).toEqual([.33, 1.58, 2.33, 3.58]);
    song.stop(); vi.unstubAllGlobals();
  });
  it('follows BPM alone in Bars (Song Speed ignored) and retimes a playing USER without retriggering its held Gate', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const settings: SongSettings = { bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' };
    const onTimes: number[] = [], offTimes: number[] = [], cancelled: number[] = [];
    const pitches: Array<{ time: number; transition: number; value: number }> = [];
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1'], getChannel: () => ({}),
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 2, selectionStartSec: 0,
        selectionEndSec: 2, gates: [{ onSec: 0, offSec: 1 }] } : null,
      getPitchRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 2, selectionStartSec: 0,
        selectionEndSec: 2, points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 2, valueNormalized: 1 }] } : null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
      gateOn: (_id: string, time: number) => onTimes.push(time), gateOff: (_id: string, time: number) => offTimes.push(time),
      setSequencePitch: (_id: string, value: number, _scale: number, _filter: number, time: number, transition: number) => pitches.push({ value, time, transition }),
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {},
      cancelSongFuture: (_id: string, time: number) => { cancelled.push(time); for (let i = offTimes.length - 1; i >= 0; i -= 1)
        if (offTimes[i]! > time) offTimes.splice(i, 1); }, holdSequencePitch: () => 0
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    await song.play(); context.currentTime = .04; tick();
    expect(onTimes).toEqual([.08]);
    context.currentTime = .5; tick();
    settings.bpm = 480; settings.speed = 2;
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
  it('applies Pitch settings at once and recording edits from the next section head', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const settings: SongSettings = { bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' };
    const gates: Record<string, TriggerRecording> = {
      'user-1': { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .2, offSec: .4 }] },
      'user-2': { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .2 }] }
    };
    let pitchScaleCent = 200;
    const onTimes: number[] = [], offTimes: number[] = [];
    const pitches: Array<{ time: number; scale: number }> = [];
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1'], getChannel: () => ({}),
      getGateRecording: (_id: string, user: string) => gates[user] ?? null,
      getPitchRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 1, selectionStartSec: 0,
        selectionEndSec: 1, points: [{ timeSec: 0, valueNormalized: .5 }, { timeSec: 1, valueNormalized: .5 }] } : null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent, filterAmountCent: 0 }),
      getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
      gateOn: (_id: string, time: number) => onTimes.push(time), gateOff: (_id: string, time: number) => offTimes.push(time),
      setSequencePitch: (_id: string, _value: number, scale: number, _filter: number, time: number) => pitches.push({ time, scale }),
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {},
      cancelSongFuture: () => {}, holdSequencePitch: () => 0
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    await song.play(); context.currentTime = .5; tick();
    pitchScaleCent = 1200; song.updateTiming();
    expect(pitches.some(pitch => pitch.time === .5 && pitch.scale === 1200)).toBe(true);
    // Edit the playing Pattern 1 and the next Pattern 2: the current section finishes unchanged.
    gates['user-1'] = { ...gates['user-1']!, gates: [{ onSec: .6, offSec: .7 }] };
    gates['user-2'] = { ...gates['user-2']!, gates: [{ onSec: .5, offSec: .6 }] };
    song.contentChanged();
    for (const time of [1, 1.5, 2, 2.1, 2.5, 3.2, 4, 4.5, 5, 5.5]) { context.currentTime = time; tick(); }
    expect(offTimes.some(time => Math.abs(time - .88) < 1e-9)).toBe(true);
    expect(offTimes.some(time => Math.abs(time - 1.48) < 1e-9)).toBe(false);
    expect(onTimes.map(time => Number(time.toFixed(2)))).toEqual([.48, 3.08, 5.28]);
    expect(song.position()?.user).toBe(1);
    song.stop(); vi.unstubAllGlobals();
  });
  it('rests a timbre left out of a Pattern and skips a Pattern every timbre leaves out', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const settings: SongSettings = { bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' };
    const gate: TriggerRecording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .2, offSec: .4 }] };
    // Timbre 1 records Patterns 1–3 and leaves out 3; Timbre 2 records 1–2 and leaves out 2.
    const recorded: Record<string, string[]> = { '1': ['user-1', 'user-2', 'user-3'], '2': ['user-1', 'user-2'] };
    const out: Record<string, string[]> = { '1': ['user-3'], '2': ['user-2'] };
    const calls: Array<{ id: string; time: number }> = [];
    const engine = {
      context, getSongSettings: () => settings, getChannelIds: () => ['1', '2'], getChannel: () => ({}),
      getPatternInSong: (id: string, user: string) => !out[id]!.includes(user), getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => false, getPitchMuted: () => false,
      getGateRecording: (id: string, user: string) => recorded[id]!.includes(user) ? gate : null, getPitchRecording: () => null,
      gateOn: (id: string, time: number) => calls.push({ id, time }), gateOff: () => {},
      resetSequencePitch: () => {}, setSequencePitchMuted: () => {}, cancelScheduledGates: () => {}
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    expect(song.preview().map(section => section.user)).toEqual([1, 2]);
    await song.play();
    for (const time of [1, 2, 3, 3.9]) { context.currentTime = time; tick(); }
    expect(calls.map(call => ({ id: call.id, time: Number(call.time.toFixed(2)) }))).toEqual([
      { id: '1', time: .48 }, { id: '2', time: .48 }, { id: '1', time: 2.48 }
    ]);
    song.stop(); vi.unstubAllGlobals();
  });
  it('keeps the Song clock through a live lane Mute and resumes inside a held Gate on unmute', async () => {
    let tick = () => {};
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {} });
    const context = { currentTime: 0, state: 'running' };
    const muted = { gate: false, pitch: false };
    const onTimes: number[] = [], offTimes: number[] = [], cancelled: number[] = [];
    const pitchMute: Array<{ muted: boolean; time?: number }> = [];
    const engine = {
      context, getSongSettings: () => ({ bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' }),
      getChannelIds: () => ['1'], getChannel: () => ({}),
      getGateRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 2, selectionStartSec: 0,
        selectionEndSec: 2, gates: [{ onSec: 0, offSec: 1 }, { onSec: 1.5, offSec: 1.9 }] } : null,
      getPitchRecording: (_id: string, user: string) => user === 'user-1' ? { durationSec: 2, selectionStartSec: 0,
        selectionEndSec: 2, points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 2, valueNormalized: 1 }] } : null,
      getSequenceSettings: () => ({ pitchMode: { kind: 'smooth' }, pitchScaleCent: 200, filterAmountCent: 0 }),
      getPatternInSong: () => true, getPatternBars: () => 1, getSequenceSelection: () => ({ playSpeed: 1 }), getGateMuted: () => muted.gate, getPitchMuted: () => muted.pitch,
      gateOn: (_id: string, time: number) => onTimes.push(time), gateOff: (_id: string, time: number) => offTimes.push(time),
      setSequencePitch: () => {}, resetSequencePitch: () => {}, cancelScheduledGates: () => {},
      cancelScheduledGatesFrom: (_id: string, time: number) => cancelled.push(time),
      setSequencePitchMuted: (_id: string, value: boolean, time?: number) => pitchMute.push({ muted: value, time })
    } as unknown as AudioEngine;
    const song = new SongTransport(() => engine, async () => {}, () => {}, () => {});
    await song.play(); context.currentTime = .04; tick();
    expect(onTimes).toEqual([.08]);
    context.currentTime = .3; tick();
    muted.gate = true; muted.pitch = true;
    song.laneMutedChanged('1', 'gate'); song.laneMutedChanged('1', 'pitch');
    expect(cancelled).toEqual([.3]);
    expect(offTimes.at(-1)).toBe(.3);
    expect(pitchMute.at(-1)).toEqual({ muted: true, time: undefined });
    context.currentTime = 1.6; tick();
    // The muted second Gate (1.58 s) is not sent, but the clock and cursor advance.
    expect(onTimes).toEqual([.08]);
    expect(song.lanePosition('1', 'gate', 'user-1')?.elapsed).toBeCloseTo(1.52);
    expect(song.lanePosition('1', 'gate', 'user-2')).toBeNull();
    // Next lap: the section reset re-applies this Pattern's Pitch Mute at the boundary.
    context.currentTime = 2.1; tick();
    expect(onTimes).toEqual([.08]);
    expect(pitchMute.some(item => item.muted && Math.abs(item.time! - 2.08) < 1e-9)).toBe(true);
    context.currentTime = 2.2; muted.gate = false;
    song.laneMutedChanged('1', 'gate');
    expect(onTimes).toEqual([.08, 2.2]);
    song.stop(); vi.unstubAllGlobals();
  });
});
