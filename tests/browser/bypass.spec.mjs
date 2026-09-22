import { test, expect } from '@playwright/test';

for (const order of [2, 4]) {
  test(`Filter unity bypass and restore, order ${order}`, async ({ page }) => {
    await page.goto('/');
    const metrics = await page.evaluate(async (order) => {
      const { FilterChain } = await import('/src/audio/dsp/FilterChain.ts');
      const context = new OfflineAudioContext(1, 48000, 48000);
      const source = context.createOscillator(); source.frequency.value = 4500;
      const filter = new FilterChain(context, { type: 'lowpass', order, frequencyHz: 100, q: .707 });
      source.connect(filter.input); filter.output.connect(context.destination); source.start();
      const actions = [[.2, () => filter.setEnabled(false)], [.4, () => filter.setFrequency(200)], [.6, () => filter.setEnabled(true)]];
      const suspensions = actions.map(([time]) => context.suspend(time));
      const rendering = context.startRendering();
      for (let i = 0; i < actions.length; i++) { await suspensions[i]; actions[i][1](); await context.resume(); }
      const samples = (await rendering).getChannelData(0);
      const peak = (a, b) => Math.max(...samples.slice(a * 48000, b * 48000).map(Math.abs));
      let unityError = 0;
      for (let i = .23 * 48000; i < .59 * 48000; i++) unityError = Math.max(unityError, Math.abs(samples[i] - Math.sin(2 * Math.PI * 4500 * i / 48000)));
      return { before: peak(.05, .18), restored: peak(.7, .9), unityError };
    }, order);
    expect(metrics.before).toBeLessThan(.001);
    expect(metrics.unityError).toBeLessThan(.001);
    expect(metrics.restored).toBeLessThan(.003);
  });
}

for (const type of ['distortion', 'delay', 'chorus', 'reverb', 'off']) {
  test(`FX ${type}: OFF is unity and silences wet tails`, async ({ page }) => {
    await page.goto('/');
    const metrics = await page.evaluate(async (type) => {
      const { EffectSlot } = await import('/src/audio/effects/EffectSlot.ts');
      const { DEFAULT_EFFECT_SLOT_SETTINGS } = await import('/src/audio/constants.ts');
      const context = new OfflineAudioContext(1, 48000, 48000);
      const source = context.createOscillator(); source.frequency.value = 4500;
      const effect = new EffectSlot(context, 'test-slot', { ...DEFAULT_EFFECT_SLOT_SETTINGS, type, delayTimeSec: .02, reverbDecaySec: .3 });
      source.connect(effect.input); effect.output.connect(context.destination); source.start(); source.stop(.6);
      const suspended = context.suspend(.2);
      const rendering = context.startRendering();
      await suspended; effect.setEnabled(false); effect.setDelayWet(.9); effect.setChorusWet(.9); effect.setReverbWet(.9); await context.resume();
      const samples = (await rendering).getChannelData(0);
      let unityError = 0, tail = 0;
      for (let i = .23 * 48000; i < .59 * 48000; i++) unityError = Math.max(unityError, Math.abs(samples[i] - Math.sin(2 * Math.PI * 4500 * i / 48000)));
      for (let i = .61 * 48000; i < samples.length; i++) tail = Math.max(tail, Math.abs(samples[i]));
      return { unityError, tail, settings: effect.getSettings() };
    }, type);
    expect(metrics.unityError).toBeLessThan(.001);
    expect(metrics.tail).toBeLessThan(1e-6);
    expect(metrics.settings.enabled).toBe(false);
    expect(metrics.settings.type).toBe(type);
  });
}

test('FX re-enable restores the retained sound processing', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { EffectSlot } = await import('/src/audio/effects/EffectSlot.ts');
    const { DEFAULT_EFFECT_SLOT_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const source = context.createConstantSource(); source.offset.value = .2; source.start();
    const slot = new EffectSlot(context, 'restore', { ...DEFAULT_EFFECT_SLOT_SETTINGS, enabled: true, type: 'distortion', distortionWet: 1 });
    source.connect(slot.input); slot.output.connect(context.destination);
    const actions = [[.2, false], [.4, true]];
    const suspensions = actions.map(([time]) => context.suspend(time));
    const rendering = context.startRendering();
    for (let i = 0; i < actions.length; i++) { await suspensions[i]; slot.setEnabled(actions[i][1]); await context.resume(); }
    const samples = (await rendering).getChannelData(0);
    return [.1, .3, .5].map((time) => samples[Math.round(time * 48000)]);
  });
  expect(values[0]).toBeGreaterThan(.6);
  expect(values[1]).toBeCloseTo(.2, 5);
  expect(values[2]).toBeCloseTo(values[0], 5);
});

test('Carrier mute, PEnv/MOD bypass, fixed reference level and carrier restore', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.baseFrequencyHz = 4500;

    settings.pitchEnvelope = { amount: .1, transitionTimeSec: .4 };
    settings.mod = { mode: 'am', amDepth: 1, fmDepthCent: 400 };
    settings.blocksEnabled = { ...settings.blocksEnabled, penv: false, mod: false, aenv: false };
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    channel.output.connect(context.destination); channel.gateOn(.02);
    const actions = [[.2, () => channel.setBlockEnabled('osc1', false)], [.4, () => channel.setBlockEnabled('osc1', true)]];
    const suspensions = actions.map(([time]) => context.suspend(time));
    const rendering = context.startRendering();
    for (let i = 0; i < actions.length; i++) { await suspensions[i]; actions[i][1](); await context.resume(); }
    const samples = (await rendering).getChannelData(0);
    const error = (a, b, gain) => {
      let max = 0;
      for (let i = a * 48000; i < b * 48000; i++) max = Math.max(max, Math.abs(samples[i] - gain * Math.sin(2 * Math.PI * 4500 * i / 48000)));
      return max;
    };
    return { reference: error(.05, .18, 10 ** (-18 / 20)), mute: error(.23, .38, 0), restored: error(.43, .58, 10 ** (-18 / 20)), gain: error(.63, .9, 10 ** (-18 / 20)), settings: channel.getSettings() };
  });
  for (const key of ['reference', 'mute', 'restored', 'gain']) expect(metrics[key], key).toBeLessThan(.001);
  expect(metrics.settings.pitchEnvelope.amount).toBe(.1);
  expect(metrics.settings.mod.amDepth).toBe(1);
  expect(metrics.settings).not.toHaveProperty('channelGainDb');
});

test('OSC2 mute and FM bypass both remove modulation', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const render = async (block) => {
      const context = new OfflineAudioContext(1, 48000, 48000);
      const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
      settings.osc1.baseFrequencyHz = 4500;
      settings.mod = { mode: 'fm', amDepth: 1, fmDepthCent: 400 };
      settings.blocksEnabled = { ...settings.blocksEnabled, aenv: false, [block]: false };
      const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
      channel.output.connect(context.destination);
      const samples = (await context.startRendering()).getChannelData(0);
      // Initial 10ms smoothing may produce a phase offset. Check the steady
      // carrier's frequency/amplitude with a 4500Hz quadrature projection.
      let sin = 0, cos = 0;
      for (let i = 4800; i < 48000; i++) {
        const phase = 2 * Math.PI * 4500 * i / 48000;
        sin += samples[i] * Math.sin(phase); cos += samples[i] * Math.cos(phase);
      }
      return 2 * Math.hypot(sin, cos) / 43200;
    };
    return Promise.all([render('osc2'), render('mod')]);
  });
  for (const amplitude of metrics) expect(amplitude).toBeCloseTo(10 ** (-18 / 20), 3);
});

test('Both Mix gains: unity bypass, edit while OFF, restore and bus routing', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const context = new OfflineAudioContext(1, 48000 * 2.3, 48000);
    const engine = new AudioEngine(context);
    engine.getChannel('1').setOsc1Frequency(4500);

    engine.getChannel('1').setBlockEnabled('aenv', false);
    engine.setChannelMix('1', { balance: 0 }); engine.setCrossfade(0); engine.gateOn('1');
    engine.setMixGainDb('near', -12); engine.setMixGainDb('far', -24);
    // Let the output compressor's startup state settle before comparing gains.
    const actions = [[1.2, () => engine.setMixGainEnabled('near', false)], [1.4, () => engine.setMixGainDb('near', -6)], [1.6, () => engine.setMixGainEnabled('near', true)],
      [1.8, async () => { engine.setMixGainEnabled('far', false); engine.setChannelMix('1', { balance: 1 }); engine.setCrossfade(1); }], [2, () => engine.setMixGainEnabled('far', true)]];
    const suspensions = actions.map(([time]) => context.suspend(time));
    const rendering = context.startRendering();
    for (let i = 0; i < actions.length; i++) { await suspensions[i]; await actions[i][1](); await context.resume(); }
    const samples = (await rendering).getChannelData(0);
    const rms = (a, b) => {
      let sum = 0;
      const start = Math.round(a * 48000), end = Math.round(b * 48000);
      for (let i = start; i < end; i++) sum += samples[i] ** 2;
      return Math.sqrt(sum / (end - start));
    };
    return [rms(1.05, 1.15), rms(1.25, 1.35), rms(1.45, 1.55), rms(1.65, 1.75), rms(1.85, 1.95), rms(2.05, 2.15)];
  });
  // Compare relative to the measured unity path: centered stereo pan folds
  // into this mono context, and the compressor may apply makeup gain.
  const unityRms = values[1];
  expect(unityRms).toBeGreaterThan(.008);
  const gains = [10 ** (-12 / 20), 1, 1, 10 ** (-6 / 20), 1, 10 ** (-24 / 20)];
  for (let i = 0; i < values.length; i++) expect(values[i] / unityRms, JSON.stringify(values)).toBeCloseTo(gains[i], 3);
});
