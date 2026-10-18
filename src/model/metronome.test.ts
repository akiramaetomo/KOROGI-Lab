import { describe, expect, it } from 'vitest';
import { barSeconds, clickTimes, nextBarTime } from './metronome';

// A fixed pattern: these tests cover the timing, not the tunable constants.
const quarter = ['pi', 'po', 'po', 'po'] as const;

describe('barSeconds', () => {
  it('divides a selection into its bar count, or follows the BPM without one', () => {
    expect(barSeconds(4.2, 2, 120)).toBeCloseTo(2.1);
    expect(barSeconds(10, null, 120)).toBe(2);
    expect(barSeconds(10, null, 60)).toBe(4);
  });
});

describe('clickTimes', () => {
  it('plays pi, po, po, po on the quarters of a 120 BPM bar', () => {
    const clicks = clickTimes({ startedAt: 10, periodSec: 2, barSec: 2, speed: 1 }, quarter, 10, 12);
    expect(clicks.map(click => click.tone)).toEqual(['pi', 'po', 'po', 'po']);
    expect(clicks.map(click => click.time)).toEqual([10, 10.5, 11, 11.5]);
    expect(clicks.map(click => click.step)).toEqual([0, 1, 2, 3]);
  });

  it('slows with Play/Rec Speed and restarts every lap on pi', () => {
    const clicks = clickTimes({ startedAt: 0, periodSec: 2, barSec: 2, speed: .5 }, quarter, 0, 8);
    expect(clicks.map(click => click.time)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(clicks[4]!.tone).toBe('pi');
  });

  it('cuts the last bar short when a lap is not a whole number of bars', () => {
    const clicks = clickTimes({ startedAt: 0, periodSec: 2.6, barSec: 2, speed: 1 }, quarter, 0, 5.2);
    expect(clicks.map(click => click.time)).toEqual([0, .5, 1, 1.5, 2, 2.5, 2.6, 3.1, 3.6, 4.1, 4.6, 5.1]);
    expect(clicks.map(click => click.tone)).toEqual(['pi', 'po', 'po', 'po', 'pi', 'po', 'pi', 'po', 'po', 'po', 'pi', 'po']);
  });

  it('returns each click once across adjacent windows', () => {
    const clock = { startedAt: 1, periodSec: 4, barSec: 2, speed: 1.3 };
    const whole = clickTimes(clock, quarter, 0, 20).map(click => click.time);
    const edges = [0, 3.33, 7.1, 12.9, 20];
    const pieces = edges.slice(0, -1).flatMap((from, index) => clickTimes(clock, quarter, from, edges[index + 1]!).map(click => click.time));
    expect(pieces).toEqual(whole);
    expect(whole[0]).toBe(1);
  });

  it('keeps lap starts exact after many laps', () => {
    const clicks = clickTimes({ startedAt: 0, periodSec: .7, barSec: .7, speed: 1 }, quarter, 699.99, 700.01);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.time).toBeCloseTo(700, 9);
    expect(clicks[0]!.tone).toBe('pi');
  });
});

describe('nextBarTime', () => {
  const clock = { startedAt: 10, periodSec: 5, barSec: 2, speed: 1 };
  it('returns the next bar start inside the lap, or the next lap start', () => {
    expect(nextBarTime(clock, 9)).toBe(10);
    expect(nextBarTime(clock, 10.1)).toBe(12);
    expect(nextBarTime(clock, 12)).toBe(12);
    expect(nextBarTime(clock, 14.5)).toBe(15);
    expect(nextBarTime({ ...clock, speed: 2 }, 11.2)).toBe(12);
  });
});
