import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoTriggerScheduler, type GateTarget } from './AutoTriggerScheduler';
import type { AutoTriggerSettings } from '../types';

interface RecordedGateEvent {
  kind: 'on' | 'off';
  time: number;
}

function createHarness(initial: AutoTriggerSettings = { tonSec: 3, toffSec: 2 }) {
  const context = { currentTime: 0 };
  const events: RecordedGateEvent[] = [];
  const target: GateTarget = {
    gateOn: (time) => events.push({ kind: 'on', time }),
    gateOff: (time) => events.push({ kind: 'off', time })
  };
  const scheduler = new AutoTriggerScheduler(context as AudioContext, target, initial);
  return { context, events, scheduler };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AutoTriggerScheduler', () => {
  it('uses the one-shot ON interval independently of the retained Ton and Toff', () => {
    vi.useFakeTimers();
    const { context, events, scheduler } = createHarness({ tonSec: 3, toffSec: 2, oneShotRepeatSec: .1 });
    scheduler.setMode('one-shot');
    scheduler.start();
    context.currentTime = .09;
    vi.advanceTimersByTime(25);
    expect(events.slice(0, 4).map(event => event.kind)).toEqual(['on', 'off', 'on', 'off']);
    [.02, .07, .12, .17].forEach((time, index) => expect(events[index]!.time).toBeCloseTo(time, 9));
    scheduler.stop(false);
  });
  it('does not submit a long Ton Gate OFF before it enters the lookahead window', () => {
    vi.useFakeTimers();
    const { context, events, scheduler } = createHarness();

    scheduler.start();
    expect(events).toEqual([{ kind: 'on', time: 0.02 }]);

    context.currentTime = 2.90;
    vi.advanceTimersByTime(25);
    expect(events).toHaveLength(1);

    context.currentTime = 2.93;
    vi.advanceTimersByTime(25);
    expect(events).toEqual([
      { kind: 'on', time: 0.02 },
      { kind: 'off', time: 3.02 }
    ]);

    scheduler.stop(false);
  });

  it('snapshots Ton and Toff at Gate ON and applies updates to the next cycle', () => {
    vi.useFakeTimers();
    const { context, events, scheduler } = createHarness();

    scheduler.start();
    scheduler.setSettings({ tonSec: 0.5, toffSec: 0.5 });

    context.currentTime = 2.93;
    vi.advanceTimersByTime(25);
    context.currentTime = 4.93;
    vi.advanceTimersByTime(25);

    expect(events.slice(0, 3)).toEqual([
      { kind: 'on', time: 0.02 },
      { kind: 'off', time: 3.02 },
      { kind: 'on', time: 5.02 }
    ]);

    context.currentTime = 5.43;
    vi.advanceTimersByTime(25);
    expect(events[3]).toEqual({ kind: 'off', time: 5.52 });

    scheduler.stop(false);
  });

  it('stops the interval, clears pending events, and sends one immediate Gate OFF', () => {
    vi.useFakeTimers();
    const { context, events, scheduler } = createHarness();

    scheduler.start();
    context.currentTime = 0.25;
    scheduler.stop();
    expect(events.at(-1)).toEqual({ kind: 'off', time: 0.25 });

    context.currentTime = 10;
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(2);
  });

  it('orders four simultaneous 5 ms Gate cycles without a runaway queue', () => {
    vi.useFakeTimers();
    const voices = Array.from({ length: 4 }, () => createHarness({ tonSec: .005, toffSec: .005 }));
    voices.forEach(({ scheduler }) => scheduler.start());
    for (let tick = 1; tick <= 400; tick += 1) {
      voices.forEach(({ context }) => { context.currentTime = tick * .025; });
      vi.advanceTimersByTime(25);
    }
    for (const { context, events, scheduler } of voices) {
      expect(events.length).toBeGreaterThan(1900);
      for (let index = 1; index < events.length; index += 1) {
        expect(events[index]!.kind).not.toBe(events[index - 1]!.kind);
        expect(events[index]!.time - events[index - 1]!.time).toBeCloseTo(.005, 9);
      }
      scheduler.stop();
      expect(events.at(-1)).toEqual({ kind: 'off', time: context.currentTime });
    }
  });
});
