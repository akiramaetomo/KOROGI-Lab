import { test, expect } from '@playwright/test';

for (const scenario of [
  { name: 'single pulse', count: 1, period: .2, stop: .02, lastOn: 0 },
  { name: 'cancel unstarted groups', count: 1, period: .025, stop: .02, lastOn: 0 },
  { name: 'cancel after second group started', count: 1, period: .025, stop: .04, lastOn: .025 },
  { name: 'finish started two-pulse group', count: 2, period: .05, stop: .02, lastOn: .025 },
  { name: 'One-shot ignores phrase OFF', count: 1, period: .025, stop: .02, lastOn: 0, mode: 'one-shot' }
]) for (const timing of ['time', 'rate']) {
  test(`BURST ownership: ${scenario.name}, ${timing}`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async ({ scenario, timing }) => {
      const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
      const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
      const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
      // 51200 Hz makes 20/25/40 ms exact render-quantum boundaries.
      const rate = 51200, context = new OfflineAudioContext(2, rate * .2, rate);
      const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
      settings.ampEnvelope = { mode: 'one-shot', attackSec: 0, decaySec: .03, sustain: .5,
        releaseSec: .03, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: timing };
      settings.pitchEnvelope = { mode: scenario.mode ?? 'gate', start: 0, attack: .05, sustain: 0, release: -.05,
        attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: timing };
      settings.burst = { enabled: true, pulseCountMin: scenario.count, pulseCountMax: scenario.count,
        pulseIntervalSec: .025, pulseIntervalJitter: 0, groupPeriodSec: scenario.period, groupPeriodJitter: 0 };
      const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
      const merger = context.createChannelMerger(2);
      synth.pEnv.output.connect(merger, 0, 0);
      synth.filter1.output.disconnect(synth.ampEnvelope.node);
      const dc = context.createConstantSource(); dc.connect(synth.ampEnvelope.node); dc.start();
      synth.ampEnvelope.node.connect(merger, 0, 1); merger.connect(context.destination);
      synth.gateOn(0);
      const pause = context.suspend(scenario.stop), rendering = context.startRendering();
      await pause;
      const stoppedAt = context.currentTime;
      // Editing controls must not alter any already submitted pulse's snapshots.
      synth.setAmplitudeEnvelope({ ...settings.ampEnvelope, releaseSec: .12, sustain: .9 });
      synth.setPitchEnvelope({ ...settings.pitchEnvelope, releaseSec: .2, release: .04, scale: .1 });
      synth.gateOff();
      const ampEnd = scenario.lastOn + .03 + (timing === 'rate' ? .03 * (.5 - .0001) / (1 - .0001) : .03);
      const pitchOff = scenario.mode === 'one-shot' ? scenario.lastOn + .03 : ampEnd;
      // Sample at actual frames, avoiding a fractional sample at the Rate endpoint.
      const times = [pitchOff, pitchOff + .015, pitchOff + .03, .14].map(t => Math.ceil(t * rate) / rate);
      const logical = times.map(t => synth.pEnv.valueAt(t));
      const ampLogical = synth.ampEnvelope.valueAt(Math.ceil(ampEnd * rate) / rate);
      await context.resume(); const rendered = await rendering;
      const signal = times.map(t => rendered.getChannelData(0)[Math.round(t * rate)]);
      const ampSignal = rendered.getChannelData(1)[Math.ceil(ampEnd * rate)];
      synth.dispose();
      return { stoppedAt, times, pitchOff, logical, signal, ampLogical, ampSignal };
    }, { scenario, timing });
    expect(result.stoppedAt).toBeCloseTo(scenario.stop, 9);
    const expected = result.times.map(t => -.05 * Math.min(1, Math.max(0, (t - result.pitchOff) / .03)));
    result.logical.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
    result.signal.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 5));
    expect(result.ampLogical).toBeCloseTo(.0001, 8);
    expect(result.ampSignal).toBeCloseTo(.0001, 6);
  });
}

test('compacted One-shot history restores both control signals after a future ON is cancelled', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const rate = 51200, context = new OfflineAudioContext(2, rate * 2.1, rate);
    const amp = { mode: 'one-shot', attackSec: 0, decaySec: .03, sustain: .5, releaseSec: .03,
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: 'time' };
    const pitch = { mode: 'one-shot', start: 0, attack: .05, sustain: 0, release: -.05,
      attackSec: 0, decaySec: .03, releaseSec: .03, scale: .4, releaseTiming: 'time' };
    const a = new AmplitudeEnvelope(context, amp), p = new PitchEnvelopeControl(context, pitch);
    const dc = context.createConstantSource(), merger = context.createChannelMerger(2);
    p.output.connect(merger, 0, 0); dc.connect(a.node); a.node.connect(merger, 0, 1);
    dc.start(); merger.connect(context.destination);
    const times = Array.from({ length: 19 }, (_, i) => (i + 1) / 10);
    const pauses = [...times, 1.92].map(time => context.suspend(time));
    a.gateOn(0); p.gateOn(0);
    const rendering = context.startRendering();
    for (let i = 0; i < times.length; i++) {
      await pauses[i]; a.gateOn(context.currentTime); p.gateOn(context.currentTime);
      if (i === times.length - 1) {
        a.gateOn(1.925); p.gateOn(1.925, { ...pitch, scale: 1, release: .1 });
      }
      await context.resume();
    }
    await pauses.at(-1);
    a.preserveCurrent(1.925); p.preserveCurrent(1.925);
    const logical = [a.valueAt(1.96), p.scaledValueAt(1.96)];
    const retained = [a.events.length, p.events.length];
    await context.resume(); const rendered = await rendering;
    return { logical, retained, signal: [rendered.getChannelData(1)[Math.round(1.96 * rate)], rendered.getChannelData(0)[Math.round(1.96 * rate)]] };
  });
  expect(result.retained).toEqual([0, 0]);
  expect(result.logical[0]).toBeCloseTo(.0001, 8);
  expect(result.logical[1]).toBeCloseTo(-.02, 8);
  expect(result.signal[0]).toBeCloseTo(.0001, 6);
  expect(result.signal[1]).toBeCloseTo(-.02, 6);
});

test('zero-duration BURST envelopes stay finite when future groups are cancelled', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const rate = 51200, context = new OfflineAudioContext(1, rate * .1, rate);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.ampEnvelope = { mode: 'one-shot', attackSec: 0, decaySec: 0, sustain: .5, releaseSec: 0,
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: 'rate' };
    settings.pitchEnvelope = { mode: 'gate', start: 0, attack: .05, sustain: 0, release: -.05,
      attackSec: 0, decaySec: 0, releaseSec: 0, scale: 1, releaseTiming: 'rate' };
    settings.burst = { enabled: true, pulseCountMin: 1, pulseCountMax: 1, pulseIntervalSec: .025,
      pulseIntervalJitter: 0, groupPeriodSec: .025, groupPeriodJitter: 0 };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.pEnv.output.connect(context.destination); synth.gateOn(0);
    const pause = context.suspend(.02), rendering = context.startRendering();
    await pause; synth.gateOff();
    const logical = synth.pEnv.valueAt(.06);
    await context.resume(); const data = (await rendering).getChannelData(0);
    synth.dispose();
    return { logical, value: data[Math.round(.06 * rate)], finite: data.every(Number.isFinite) };
  });
  expect(result.finite).toBe(true);
  expect(result.logical).toBe(-.05);
  expect(result.value).toBeCloseTo(-.05, 6);
});
