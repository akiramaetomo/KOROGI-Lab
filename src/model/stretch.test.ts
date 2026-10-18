import { describe, expect, it } from 'vitest';
import { clickTimes, nextBarTime } from './metronome';
import { barsFromSeconds, formatBars, isPatternBars, parsePatternBars, patternBarChoices, patternBars, stretchBasePattern, stretchLoopSeconds, stretchSpeed } from './stretch';

const song = { bpm: 120 };
const timbre = { patternBars: [1, 2, 4, 1, 1, 1, 1, 1] };

describe('stretchBasePattern', () => {
  it('uses the Gate Pattern while recorded Gates play, otherwise the Pitch Pattern', () => {
    const source = { gateMode: 'user' as const, gateUserId: 'user-3' as const, pitchUserId: 'user-2' as const };
    expect(stretchBasePattern(source, true)).toBe('user-3');
    expect(stretchBasePattern(source, false)).toBe('user-2');
    expect(stretchBasePattern({ ...source, gateMode: 'auto' }, true)).toBe('user-2');
  });
});

describe('Stretch loop', () => {
  it('lasts the Pattern bars at the BPM and fits each selection to it', () => {
    expect(patternBars(timbre, 'user-3')).toBe(4);
    expect(stretchLoopSeconds(patternBars(timbre, 'user-2'), song)).toBe(4);
    expect(stretchLoopSeconds(patternBars(timbre, 'user-1'), { bpm: 60 })).toBe(4);
    // A 2.30 s Gate and a 1.00 s Pitch selection both lap every 2.00 s at 1 bar and 120 BPM.
    const loop = stretchLoopSeconds(1, song);
    expect(2.3 / stretchSpeed(2.3, loop)).toBeCloseTo(2);
    expect(1 / stretchSpeed(1, loop)).toBeCloseTo(2);
  });

  it('round-trips recorded seconds: a real-time input maps back to the position it plays at', () => {
    const loop = stretchLoopSeconds(1, song), speed = stretchSpeed(2.3, loop);
    const realSinceStart = 2 + .75; // second lap, 0.75 s in
    const stored = (realSinceStart * speed) % 2.3;
    expect(stored).toBeCloseTo(.75 * 1.15);
    expect(stored / speed).toBeCloseTo(.75);
  });

  it('gives a click clock of whole bars, so laps never cut a bar short', () => {
    const loop = stretchLoopSeconds(2, song);
    const clock = { startedAt: 0, periodSec: loop, barSec: 240 / song.bpm, speed: 1 };
    expect(clickTimes(clock, ['pi', 'po', 'po', 'po'], 0, 8).map(click => click.time))
      .toEqual([0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5]);
    expect(nextBarTime(clock, 4.1)).toBe(6);
  });

  it('counts whole bars for a loop shorter than a bar, so the click does not restart each lap', () => {
    // 1/4 bar at 120 BPM laps every 0.50 s; the clock period is one bar (TriggerRecorder.clickClock).
    const barSec = 240 / song.bpm, loop = .25 * barSec;
    const clock = { startedAt: 0, periodSec: Math.max(loop, barSec), barSec, speed: 1 };
    expect(clickTimes(clock, ['pi', 'po', 'po', 'po'], 0, 4).map(click => click.tone))
      .toEqual(['pi', 'po', 'po', 'po', 'pi', 'po', 'po', 'po']);
    expect(nextBarTime(clock, .6)).toBe(2);
  });
});

describe('fractional Pattern bars', () => {
  it('allows 1/2, 1/4, 1/8 and 1/16, and whole bars up to the limit', () => {
    for (const bars of [.5, .25, .125, .0625, 1, 37]) expect(isPatternBars(bars, 37)).toBe(true);
    for (const bars of [1 / 32, .3, .75, 1.5, 0, -1, 38, Number.NaN]) expect(isPatternBars(bars, 37)).toBe(false);
  });

  it('lists every allowed count for the Bars menus, and nothing else', () => {
    expect(patternBarChoices(3)).toEqual([.0625, .125, .25, .5, 1, 2, 3]);
    expect(patternBarChoices(150).every(bars => isPatternBars(bars, 150))).toBe(true);
  });

  it('reads fractions and decimals and shows fractions', () => {
    expect(parsePatternBars('1/4')).toBe(.25);
    expect(parsePatternBars(' 1 / 16 ')).toBe(.0625);
    expect(parsePatternBars('0.5')).toBe(.5);
    expect(parsePatternBars('.125')).toBe(.125);
    expect(parsePatternBars('2')).toBe(2);
    for (const text of ['', 'abc', '1/0', '-1', '1/4/2', '1e2']) expect(parsePatternBars(text)).toBeNull();
    expect([.5, .25, .125, .0625, 1, 12].map(formatBars)).toEqual(['1/2', '1/4', '1/8', '1/16', '1', '12']);
  });
});

describe('barsFromSeconds', () => {
  it('rounds the recorded length to whole bars at the BPM from one bar, at most the limit', () => {
    expect(barsFromSeconds(12, 120, 150)).toBe(6);
    expect(barsFromSeconds(13, 120, 150)).toBe(7);
    expect(barsFromSeconds(8, 90, 150)).toBe(3);
    expect(barsFromSeconds(2.9, 120, 150)).toBe(1);
    expect(barsFromSeconds(600, 120, 150)).toBe(150);
  });

  it('chooses the nearest of 1/16, 1/8, 1/4, 1/2 and 1 on a log scale below one bar', () => {
    expect(barsFromSeconds(.5, 120, 150)).toBe(.25);
    expect(barsFromSeconds(.4, 120, 150)).toBe(.25);
    expect(barsFromSeconds(1.9, 120, 150)).toBe(1);
    expect(barsFromSeconds(1.2, 120, 150)).toBe(.5);
    expect(barsFromSeconds(.1, 120, 150)).toBe(.0625);
  });
});
