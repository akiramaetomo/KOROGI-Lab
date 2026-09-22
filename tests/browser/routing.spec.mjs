import { test, expect } from '@playwright/test';

test('Source FX1 carries Gate OFF tails and its switch bypasses them while retaining settings', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const { ENVELOPE_FLOOR_GAIN } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const context = new OfflineAudioContext(1, 24000, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);

    settings.ampEnvelope.releaseSec = .001;
    settings.fx1 = { ...settings.fx1, enabled: true, type: 'delay', delayTimeSec: .05, delayFeedback: .5, delayWet: 1 };
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    channel.output.connect(context.destination); channel.gateOn(.02); channel.gateOff(.1);
    const suspended = context.suspend(.2);
    const rendering = context.startRendering();
    await suspended; channel.setFx1Enabled(false); await context.resume();
    const samples = (await rendering).getChannelData(0);
    const peak = (a, b) => Math.max(...samples.slice(Math.round(a * 48000), Math.round(b * 48000)).map(Math.abs));
    return { tail: peak(.16, .19), bypassedTail: peak(.24, .45), floor: ENVELOPE_FLOOR_GAIN * 10 ** (-18 / 20), fx1: channel.getSettings().fx1 };
  });
  expect(metrics.tail).toBeGreaterThan(.01);
  // Unity bypass exposes the existing AEnv exponential-ramp floor (1e-4).
  // Only the wet tail must disappear; the dry path is deliberately retained.
  expect(metrics.bypassedTail).toBeCloseTo(metrics.floor, 7);
  expect(metrics.fx1).toMatchObject({ enabled: false, type: 'delay', delayTimeSec: .05, delayFeedback: .5, delayWet: 1 });
});
