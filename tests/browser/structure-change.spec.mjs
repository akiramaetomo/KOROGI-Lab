import { test, expect } from '@playwright/test';

// Structural changes (OSC type, Filter type/order) share one fade. Requests issued while that
// fade is pending must resolve to the last request per item, without losing other items.
async function run(page, body) {
  await page.goto('/');
  return page.evaluate(body);
}

test('returning to the committed OSC type while a change is pending keeps the last request', async ({ page }) => {
  const result = await run(page, async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 4800, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.sourceType = 'sine'; settings.osc2.sourceType = 'sine';
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    await Promise.all([channel.setOsc1Type('triangle'), channel.setOsc1Type('sine')]);
    await Promise.all([channel.setOsc2Type('square'), channel.setOsc2Type('sine'), channel.setOsc2Type('sawtooth')]);
    return { osc1: channel.getSettings().osc1.sourceType, osc2: channel.getSettings().osc2.sourceType,
      osc1Node: channel.osc1.sourceType, osc2Node: channel.osc2.sourceType };
  });
  expect(result).toEqual({ osc1: 'sine', osc2: 'sawtooth', osc1Node: 'sine', osc2Node: 'sawtooth' });
});

test('consecutive requests to different items and replaced Filter requests all commit', async ({ page }) => {
  const result = await run(page, async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 4800, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.sourceType = 'sine'; settings.osc2.sourceType = 'sine';
    settings.filter1 = { ...settings.filter1, type: 'lowpass', order: 2 };
    settings.filter2 = { ...settings.filter2, type: 'lowpass', order: 2 };
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    await Promise.all([
      channel.setOsc1Type('triangle'), channel.setOsc2Type('square'),
      channel.setFilter1Structure('highpass', 4), channel.setFilter1Structure('bandpass', 2),
      channel.setFilter2Structure('highpass', 4)
    ]);
    const saved = channel.getSettings();
    return { osc1: saved.osc1.sourceType, osc2: saved.osc2.sourceType,
      filter1: [saved.filter1.type, saved.filter1.order], filter2: [saved.filter2.type, saved.filter2.order] };
  });
  expect(result).toEqual({ osc1: 'triangle', osc2: 'square', filter1: ['bandpass', 2], filter2: ['highpass', 4] });
});

test('the shared structure fade returns to full level after overlapping requests', async ({ page }) => {
  const result = await run(page, async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const rate = 48000; const context = new OfflineAudioContext(1, rate / 10, rate);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1 = { ...settings.osc1, sourceType: 'sine', baseFrequencyHz: 1000 };
    settings.blocksEnabled = { ...settings.blocksEnabled, osc2: false, penv: false, mod: false, filter1: false, filter2: false, aenv: false };
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    channel.output.connect(context.destination);
    const first = channel.setOsc1Type('triangle');
    const second = channel.setOsc1Type('sine');
    await Promise.all([first, second]);
    const samples = (await context.startRendering()).getChannelData(0);
    let peak = 0;
    for (let index = Math.round(.05 * rate); index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
    return { peak, type: channel.getSettings().osc1.sourceType };
  });
  expect(result.type).toBe('sine');
  expect(result.peak).toBeGreaterThan(.05);
});
