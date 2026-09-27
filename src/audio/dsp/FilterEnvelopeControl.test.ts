import { describe, expect, it } from 'vitest';
import { FilterEnvelopeControl } from './FilterEnvelopeControl';
import { DEFAULT_CHANNEL_SETTINGS } from '../constants';

const settings = { ...DEFAULT_CHANNEL_SETTINGS.filterEnvelope, mode: 'gate' as const,
  attackSec: .1, decaySec: .1, sustain: .5, releaseSec: .2, amountCent: -1200,
  attackCurve: 'linear' as const, decayCurve: 'linear' as const, releaseCurve: 'linear' as const };
function harness() {
  const param = () => ({ value: 0, cancelAndHoldAtTime() {}, setValueAtTime() {},
    linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ gain: param(), offset: param(), connect(target: unknown) { return target; }, start() {}, stop() {}, disconnect() {} });
  const clock = { currentTime: 0, createGain: node, createConstantSource: node };
  return { clock, env: new FilterEnvelopeControl(clock as unknown as AudioContext, settings) };
}

describe('FEnv shared timeline', () => {
  it('uses signed cents and preserves settings until the next ON', () => {
    const { env } = harness(); env.gateOn(0); env.gateOff(.2);
    env.setSettings({ ...settings, amountCent: 4800, releaseSec: 0 });
    expect(env.centValueAt(.1)).toBeCloseTo(-1200);
    expect(env.centValueAt(.3)).toBeCloseTo(-300);
    expect(env.centValueAt(.4)).toBe(0);
    env.gateOn(.5); expect(env.centValueAt(.6)).toBeCloseTo(4800);
  });

  it('Rate uses normalized 1 -> 0 and is independent of signed Amount', () => {
    const { env } = harness(); env.gateOn(0, { ...settings, releaseTiming: 'rate' }); env.gateOff(.05);
    expect(env.normalizedValueAt(.05)).toBeCloseTo(.5);
    expect(env.centValueAt(.1)).toBeCloseTo(-300);
    expect(env.centValueAt(.15)).toBeCloseTo(0);
  });

  it('retrigger starts at the current shape, including while output is bypassed', () => {
    const { clock, env } = harness(); env.gateOn(0); env.gateOff(.2);
    clock.currentTime = .25; env.setEnabled(false);
    expect(env.centValueAt(.25)).toBe(0);
    env.gateOn(.25); expect(env.normalizedValueAt(.25)).toBeCloseTo(.375);
    clock.currentTime = .3; env.setEnabled(true);
    expect(env.centValueAt(.3)).toBeCloseTo(-825);
  });

  it('restores a started BURST owned release when the next unstarted ON is cancelled', () => {
    const { clock, env } = harness(); env.gateOn(0, settings, .12);
    env.gateOn(.15, { ...settings, amountCent: 4800 }, .3);
    clock.currentTime = .1; env.preserveCurrent(.15);
    expect(env.centValueAt(.12)).toBeCloseTo(-1080);
    expect(env.centValueAt(.22)).toBeCloseTo(-540);
    expect(env.centValueAt(.32)).toBeCloseTo(0);
  });

  it('a started new ON supersedes an old owned OFF and One-shot ignores external OFF', () => {
    const { env } = harness(); env.gateOn(0, settings, .12);
    env.gateOn(.1, { ...settings, mode: 'one-shot' }, .11); env.gateOff(.11);
    expect(env.centValueAt(.12)).toBeCloseTo(-1200);
    expect(env.centValueAt(.3)).toBeCloseTo(-600);
    expect(env.centValueAt(.5)).toBeCloseTo(0);
  });

  for (const mode of ['gate', 'one-shot'] as const) it(`${mode}: 5000 notes retain bounded history and zero endpoints`, () => {
    const { clock, env } = harness();
    for (let i = 0; i < 5000; i++) {
      clock.currentTime = i * .025; env.gateOn(clock.currentTime, { ...settings, mode }, clock.currentTime + .02);
      clock.currentTime += .01; env.gateOff(clock.currentTime);
    }
    const view = env as unknown as { events: unknown[]; segments: unknown[]; checkpoint: { segments: unknown[] } };
    expect(view.events.length).toBeLessThanOrEqual(2); expect(view.segments.length).toBeLessThanOrEqual(8);
    expect(view.checkpoint.segments.length).toBeLessThanOrEqual(5);
    env.silence(); expect(env.centValueAt(clock.currentTime)).toBe(0);
  });
});
