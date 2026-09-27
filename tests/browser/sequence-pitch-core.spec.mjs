import { test, expect } from '@playwright/test';

test('Sequence Pitch adds cents to the periodic carrier without changing the saved static Detune', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS, VOICE_FX_INPUT_DB } = await import('/src/audio/constants.ts');
    const rate = 48000; const context = new OfflineAudioContext(1, rate / 4, rate);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.baseFrequencyHz = 1000;
    settings.blocksEnabled = { ...settings.blocksEnabled, osc2: false, penv: false, mod: false, filter1: false, filter2: false, aenv: false };
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    channel.output.connect(context.destination);
    channel.setSequencePitchCent(1200, 0);
    const samples = (await context.startRendering()).getChannelData(0);
    const gain = 10 ** (VOICE_FX_INPUT_DB / 20);
    let maxError = 0;
    for (let index = Math.round(.05 * rate); index < Math.round(.2 * rate); index += 1) {
      maxError = Math.max(maxError, Math.abs(samples[index] - gain * Math.sin(2 * Math.PI * 2000 * index / rate)));
    }
    return { maxError, sequenceCent: channel.getSequencePitchCent(.1), staticCent: channel.getCurrentDetuneCent(), savedRange: channel.getDetuneRangeCent() };
  });
  expect(metrics.maxError).toBeLessThan(.001);
  expect(metrics.sequenceCent).toBe(1200);
  expect(metrics.staticCent).toBe(0);
  expect(metrics.savedRange).toBe(0);
});
