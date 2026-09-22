import { afterEach, describe, expect, it, vi } from 'vitest';
import { BurstScheduler } from './BurstScheduler';
import type { BurstSettings } from '../types';

const settings = (overrides: Partial<BurstSettings> = {}): BurstSettings => ({
  enabled: true, pulseCountMin: 3, pulseCountMax: 3, pulseIntervalSec: .025,
  pulseIntervalJitter: 0, groupPeriodSec: .1, groupPeriodJitter: 0, ...overrides
});

function harness(value = settings(), random = () => .5) {
  const context = { currentTime: 0 };
  const pulses: number[] = [], cancellations: number[] = [];
  const scheduler = new BurstScheduler(context as AudioContext,
    { pulse: time => pulses.push(time), cancelFrom: time => {
      cancellations.push(time);
      const index = pulses.findIndex(pulse => pulse >= time);
      if (index >= 0) pulses.splice(index);
    } }, value, random);
  return { context, pulses, cancellations, scheduler };
}

afterEach(() => vi.useRealTimers());

describe('BurstScheduler', () => {
  it('schedules fixed three-pulse groups at 25 ms inside a 100 ms period', () => {
    vi.useFakeTimers();
    const { context, pulses, scheduler } = harness();
    scheduler.gateOn(0);
    expect(pulses).toEqual([0, .025, .05, .1, .125, .15]);
    context.currentTime = .11; vi.advanceTimersByTime(15);
    expect(pulses.slice(6, 9)).toEqual([.2, .225, .25]);
    scheduler.gateOff(.11);
  });

  it('draws an inclusive count range and independent interval and group jitter', () => {
    vi.useFakeTimers();
    const draws = [0.99, 0, 1, 1, .5, .5, .5];
    const { context, pulses, scheduler } = harness(settings({ pulseCountMin: 1, pulseCountMax: 3,
      pulseIntervalJitter: .5, groupPeriodJitter: .5 }), () => draws.shift() ?? .5);
    scheduler.gateOn(0);
    expect(pulses[0]).toBe(0);
    expect(pulses[1]).toBeCloseTo(.0125, 9);
    expect(pulses[2]).toBeCloseTo(.05, 9);
    context.currentTime = .06;
    vi.advanceTimersByTime(15);
    expect(pulses[3]).toBeCloseTo(.15, 9);
    scheduler.gateOff(0);
  });

  it('finishes the current group on OFF and cancels groups that have not started', () => {
    vi.useFakeTimers();
    const { pulses, cancellations, scheduler } = harness();
    scheduler.gateOn(0);
    scheduler.gateOff(.03);
    expect(pulses).toEqual([0, .025, .05]);
    expect(cancellations).toEqual([.1]);
  });

  it('moves an overlapping group start to five milliseconds after the final pulse', () => {
    vi.useFakeTimers();
    const { context, pulses, scheduler } = harness(settings({ pulseCountMin: 3, pulseCountMax: 3,
      pulseIntervalSec: .05, groupPeriodSec: .01 }));
    scheduler.gateOn(0);
    context.currentTime = .01;
    vi.advanceTimersByTime(15);
    expect(pulses[3]).toBeCloseTo(.105, 9);
    scheduler.gateOff(.001);
  });

  it('applies setting changes to the next group and restarts immediately after a new ON', () => {
    vi.useFakeTimers();
    const { context, pulses, cancellations, scheduler } = harness();
    scheduler.gateOn(0);
    scheduler.setSettings(settings({ pulseCountMin: 1, pulseCountMax: 1, groupPeriodSec: .2 }));
    expect(cancellations).toEqual([.1]);
    expect(pulses.filter(time => Math.abs(time - .1) < 1e-9)).toHaveLength(1);
    context.currentTime = .21; vi.advanceTimersByTime(15);
    expect(pulses.some(time => Math.abs(time - .3) < 1e-9)).toBe(true);
    scheduler.gateOff(.21);
    context.currentTime = .4; scheduler.gateOn(.4);
    expect(pulses.some(time => Math.abs(time - .4) < 1e-9)).toBe(true);
    scheduler.gateOff(.4);
  });
});
