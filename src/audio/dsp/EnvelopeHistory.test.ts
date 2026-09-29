import { describe, expect, it } from 'vitest';
import { AmplitudeEnvelope } from './AmplitudeEnvelope';
import { PitchEnvelopeControl } from './PitchEnvelopeControl';
import type { AmplitudeEnvelopeSettings, PitchEnvelopeSettings } from '../types';

const amp: AmplitudeEnvelopeSettings = { attackSec: .01, decaySec: .03, sustain: .5, releaseSec: .03,
  mode: 'gate', attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: 'time' };
const pitch: PitchEnvelopeSettings = { start: 0, attack: .05, sustain: 0, release: -.05,
  attackSec: .01, decaySec: .03, releaseSec: .03, mode: 'gate', curve: 'linear', scale: .5, releaseTiming: 'time' };

// No event log in the AudioParam stub: measurements concern the envelopes themselves.
function harness() {
  const param = () => ({ value: 0, cancelAndHoldAtTime() {}, setValueAtTime() {}, setValueCurveAtTime() {},
    linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ gain: param(), offset: param(), connect(target: unknown) { return target; }, start() {} });
  const clock = { currentTime: 0, createGain: node, createConstantSource: node };
  return { clock, context: clock as unknown as AudioContext };
}

interface Inspection {
  events: unknown[];
  segments: unknown[];
  checkpoint?: { segments: unknown[] };
  trimSegments(time: number): void;
  valueAt(time: number): number;
}
const inspect = (env: AmplitudeEnvelope | PitchEnvelopeControl) => env as unknown as Inspection;

describe('bounded envelope history', () => {
  it('curves signed PEnv levels logarithmically without changing endpoints or Rate duration', () => {
    const { context } = harness();
    const env = new PitchEnvelopeControl(context, { ...pitch, start: -.4, attack: .6,
      sustain: .2, release: -.2, attackSec: .1, decaySec: .1, releaseSec: .1,
      scale: 1, curve: 'logarithmic', releaseTiming: 'rate' });
    env.gateOn(0); env.gateOff(.2);
    expect(env.valueAt(0)).toBeCloseTo(-.4);
    expect(env.valueAt(.05)).toBeCloseTo(-.4 + Math.log1p(4.5) / Math.log(10));
    expect(env.valueAt(.1)).toBeCloseTo(.6);
    expect(env.valueAt(.2)).toBeCloseTo(.2);
    expect(env.valueAt(.25)).toBeCloseTo(.2 - .4 * Math.log1p(4.5) / Math.log(10));
    expect(env.valueAt(.3)).toBeCloseTo(-.2);
  });
  for (const mode of ['gate', 'one-shot'] as const) for (const interval of [.1, .025]) {
    it(`${mode}, ${interval * 1000} ms: 8 timbres retain bounded history for 5000 notes`, () => {
      const { clock, context } = harness();
      const voices = Array.from({ length: 8 }, (_, i) => {
        const releaseTiming = i % 2 ? 'rate' : 'time';
        return [new AmplitudeEnvelope(context, { ...amp, mode, releaseTiming }),
          new PitchEnvelopeControl(context, { ...pitch, mode, releaseTiming })];
      }).flat();
      let work = 0;
      for (const env of voices) {
        const view = inspect(env), original = view.trimSegments;
        view.trimSegments = function(time) { work += this.segments.length; original.call(this, time); };
      }
      const samples: unknown[] = [], first: number[] = [], last: number[] = [];
      let earlyWork = 0;
      for (let i = 0; i < 5000; i++) {
        clock.currentTime = i * interval;
        work = 0;
        const start = performance.now();
        for (const env of voices) env.gateOn(clock.currentTime);
        clock.currentTime += interval * .4;
        for (const env of voices) env.gateOff(clock.currentTime);
        const elapsed = performance.now() - start;
        if (i >= 50 && i < 100) first.push(elapsed);
        if (i >= 4950) last.push(elapsed);
        if ([99, 599, 999, 4999].includes(i)) {
          const counts = voices.map(env => {
            const v = inspect(env);
            return [v.events.length, v.segments.length, v.checkpoint?.segments.length ?? 0];
          });
          samples.push({ notes: i + 1, counts, trimVisits: work });
          // With no outstanding future ONs, a note needs only a fixed ADSR tail.
          for (const [events, segments, checkpoint] of counts) {
            expect(events).toBeLessThanOrEqual(2);
            expect(segments).toBeLessThanOrEqual(8);
            expect(checkpoint).toBeLessThanOrEqual(5);
          }
          if (i === 99) earlyWork = work;
          else expect(work).toBeLessThanOrEqual(earlyWork + 32);
        }
      }
      const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
      console.info(JSON.stringify({ mode, interval, samples, firstMeanMs: mean(first), lastMeanMs: mean(last) }));
    });
  }

  it('compaction restores the original One-shot tail and scale after overlapping future cancellation', () => {
    const { clock, context } = harness();
    const a = new AmplitudeEnvelope(context, { ...amp, mode: 'one-shot', attackSec: 0 });
    const p = new PitchEnvelopeControl(context, { ...pitch, mode: 'one-shot', attackSec: 0 });
    for (let i = 0; i < 100; i++) { clock.currentTime = i * .1; a.gateOn(clock.currentTime); p.gateOn(clock.currentTime); }
    clock.currentTime = 10;
    a.gateOn(10); p.gateOn(10);
    a.gateOn(10.025); p.gateOn(10.025, { ...pitch, mode: 'one-shot', scale: 1 });
    clock.currentTime = 10.02;
    a.preserveCurrent(10.025); p.preserveCurrent(10.025);
    expect(inspect(a).valueAt(10.06)).toBeCloseTo(.0001, 8);
    expect(p.valueAt(10.06)).toBeCloseTo(-.05, 8);
    expect(p.scaledValueAt(10.06)).toBeCloseTo(-.025, 8);
    expect(inspect(a).events.length).toBeLessThanOrEqual(2);
    expect(inspect(p).events.length).toBeLessThanOrEqual(2);
  });

  it('keeps unstarted ONs before a future cancellation boundary, without baking them into the checkpoint', () => {
    const { clock, context } = harness();
    const a = new AmplitudeEnvelope(context, { ...amp, attackSec: .1, decaySec: .1 });
    const p = new PitchEnvelopeControl(context, { ...pitch, attackSec: .1, decaySec: .1 });
    a.gateOn(0); p.gateOn(0);
    a.gateOn(.15); p.gateOn(.15, { ...pitch, start: -.02 });
    a.gateOn(.25); p.gateOn(.25);
    clock.currentTime = .02;
    a.preserveCurrent(.2); p.preserveCurrent(.2);
    expect(p.valueAt(.15)).toBe(-.02); // still a pending ON, not past history
    expect(inspect(a).events).toHaveLength(1);
    expect(inspect(p).events).toHaveLength(1);
    clock.currentTime = .04;
    a.preserveCurrent(.15); p.preserveCurrent(.15);
    expect(inspect(a).valueAt(.15)).toBeCloseTo(.75, 9);
    expect(p.valueAt(.15)).toBeCloseTo(.025, 9);
    expect(p.scaledValueAt(.15)).toBeCloseTo(.0125, 9);
  });

  it('preserves Gate snapshots through Attack OFF, Release retrigger and bypass after compaction', () => {
    const { clock, context } = harness();
    const a = new AmplitudeEnvelope(context, { ...amp, attackSec: .1, releaseSec: .1 });
    const p = new PitchEnvelopeControl(context, { ...pitch, attackSec: .1, releaseSec: .1 });
    a.gateOn(0); p.gateOn(0);
    a.setSettings({ ...amp, attackSec: .1, releaseSec: 0 });
    p.setSettings({ ...pitch, start: -.02, releaseSec: 0, scale: 1 });
    clock.currentTime = .05;
    a.gateOff(.05); p.gateOff(.05);
    expect(inspect(a).valueAt(.1)).toBeCloseTo(.250075, 9);
    expect(p.valueAt(.1)).toBeCloseTo(-.0125, 9);
    clock.currentTime = .075;
    a.setEnabled(false); p.setEnabled(false);
    expect(p.scaledValueAt(.1)).toBe(0);
    // Re-enable AEnv with released Gate: return to floor, retaining future ON.
    a.gateOn(.2); p.gateOn(.2);
    clock.currentTime = .08;
    a.setEnabled(true); p.setEnabled(true);
    expect(inspect(a).valueAt(.1)).toBe(.0001);
    expect(p.scaledValueAt(.1)).toBeCloseTo(-.00625, 9);
    a.preserveCurrent(.2); p.preserveCurrent(.2);
    clock.currentTime = .081;
    const aStart = inspect(a).valueAt(.081);
    a.gateOn(.081); p.gateOn(.081);
    expect(inspect(a).valueAt(.081)).toBe(aStart);
    expect(p.valueAt(.081)).toBe(-.02);
  });

  it('retrigger starts at the current AEnv amplitude and P0 during an unfinished Release', () => {
    const { clock, context } = harness();
    const a = new AmplitudeEnvelope(context, { ...amp, attackSec: .1, releaseSec: .1 });
    const p = new PitchEnvelopeControl(context, { ...pitch, attackSec: .1, releaseSec: .1 });
    a.gateOn(0); p.gateOn(0);
    clock.currentTime = .05; a.gateOff(.05); p.gateOff(.05);
    clock.currentTime = .075; a.gateOn(.075); p.gateOn(.075);
    expect(inspect(a).valueAt(.075)).toBeCloseTo(.3750625, 9);
    expect(p.valueAt(.075)).toBe(0);
    expect(() => p.valueAt(.01)).toThrow(RangeError);
  });

  it('keeps owned OFF and Scale snapshots, and a simultaneous new ON supersedes the old OFF', () => {
    const { clock, context } = harness();
    const p = new PitchEnvelopeControl(context, pitch);
    p.gateOn(0, pitch, .1);
    const next = { ...pitch, start: .08, attack: .04, attackSec: .1, scale: .25 };
    p.gateOn(.1, next, .3);
    clock.currentTime = .12;
    p.preserveCurrent(.2); // folds both started notes; cannot revive the first OFF
    expect(p.valueAt(.15)).toBeCloseTo(.06, 9);
    expect(p.scaledValueAt(.15)).toBeCloseTo(.015, 9);
    expect(p.valueAt(.315)).toBeCloseTo(-.025, 9);
    expect(p.valueAt(.33)).toBeCloseTo(-.05, 9);
  });

  it('same-time replacements and zero intervals remain finite after clock advancement', () => {
    const { clock, context } = harness();
    const a = new AmplitudeEnvelope(context, { ...amp, attackSec: 0, decaySec: 0, releaseSec: 0 });
    const p = new PitchEnvelopeControl(context, { ...pitch, attackSec: 0, decaySec: 0, releaseSec: 0 });
    clock.currentTime = 1;
    a.gateOn(1); a.gateOff(1); a.gateOn(1); a.gateOff(1);
    p.gateOn(1); p.gateOff(1); p.gateOn(1); p.gateOff(1);
    expect(inspect(a).valueAt(1)).toBe(.0001);
    expect(p.valueAt(1)).toBe(-.05);
    clock.currentTime = 2;
    a.preserveCurrent(); p.preserveCurrent();
    expect(inspect(a).valueAt(2)).toBe(.0001);
    expect(p.valueAt(2)).toBe(-.05);
  });
});
