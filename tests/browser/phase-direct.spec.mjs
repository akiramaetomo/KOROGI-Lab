import { test, expect } from '@playwright/test';

test('FX1 DIRECT follows the selected active Timbre, bypasses slot mix, and retains Master controls', async ({ page }) => {
  await page.goto('/');
  const levels = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const rate = 48000; const context = new OfflineAudioContext(1, rate / 2, rate);
    const engine = new AudioEngine(context); engine.setMasterGainDb(0);
    engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
    const silentSources = defaultTimbre(); silentSources.settings.blocksEnabled.osc1 = false; silentSources.settings.blocksEnabled.osc2 = false;
    engine.replaceChannel('1', silentSources); engine.replaceChannel('2', silentSources);
    for (const [id, value] of [['1', .1], ['2', .2]]) {
      engine.setChannelMix(id, { gainDb: -60, muted: true, balance: id === '1' ? 0 : 1, pan: id === '1' ? -1 : 1 });
      const source = context.createConstantSource(); source.offset.value = value; source.connect(engine.getChannel(id).output); source.start();
      engine.gateOn(id);
    }
    engine.setDirectMonitorId('1'); engine.setMasterInputMode('fx1-direct');
    const pauses = [.1, .2, .3, .4].map(time => context.suspend(time)); const rendering = context.startRendering();
    await pauses[0]; engine.setDirectMonitorId('2'); await context.resume();
    await pauses[1]; engine.setMasterGainDb(-6); await context.resume();
    await pauses[2]; engine.setMasterMuted(true); await context.resume();
    await pauses[3]; engine.setMasterMuted(false); engine.setDirectMonitorId('3'); await context.resume();
    const data = (await rendering).getChannelData(0);
    const mean = (a, b) => data.slice(a * rate, b * rate).reduce((sum, sample) => sum + sample, 0) / ((b - a) * rate);
    const result = [mean(.05, .09), mean(.15, .19), mean(.25, .29), mean(.35, .39), mean(.45, .49)]; engine.dispose(); return result;
  });
  expect(levels[0]).toBeCloseTo(.1, 3);
  expect(levels[1]).toBeCloseTo(.2, 3);
  expect(levels[2]).toBeCloseTo(.2 * 10 ** (-6 / 20), 3);
  expect(levels[3]).toBe(0);
  expect(levels[4]).toBe(0);
});

test('FX1 DIRECT remains silent until activation and COMMON SPACE remains available after A/B switching', async ({ page }) => {
  await page.goto('/');
  const levels = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const rate = 48000; const context = new OfflineAudioContext(1, rate / 2, rate);
    const timbre = defaultTimbre(); timbre.settings.blocksEnabled.osc1 = false; timbre.settings.blocksEnabled.osc2 = false;
    const engine = new AudioEngine(context); engine.setMasterGainDb(0); engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
    engine.replaceChannel('1', timbre); engine.setChannelMix('1', { balance: 0, pan: 0, muted: false, gainDb: 0 });
    const source = context.createConstantSource(); source.offset.value = .1; source.connect(engine.getChannel('1').output); source.start();
    engine.setDirectMonitorId('1'); engine.setMasterInputMode('fx1-direct');
    const pauses = [.1, .2, .3].map(time => context.suspend(time)); const rendering = context.startRendering();
    await pauses[0]; engine.gateOn('1'); await context.resume();
    await pauses[1]; engine.setMasterInputMode('common-space'); await context.resume();
    await pauses[2]; engine.setMasterInputMode('fx1-direct'); engine.replaceChannel('1', timbre); await context.resume();
    const data = (await rendering).getChannelData(0);
    const mean = (a, b) => data.slice(a * rate, b * rate).reduce((sum, sample) => sum + sample, 0) / ((b - a) * rate);
    const result = [mean(.04, .08), mean(.14, .18), mean(.24, .28), mean(.34, .38)]; engine.dispose(); return result;
  });
  expect(levels[0]).toBe(0);
  expect(levels[1]).toBeCloseTo(.1, 3);
  // Center stereo pan followed by mono destination fold-down contributes two 1/sqrt(2) stages.
  expect(levels[2]).toBeCloseTo(.05, 3);
  expect(levels[3]).toBe(0);
});

test('SYNC restarts both periodic OSCs at the same Gate time and excludes overlap, AEnv OFF, FREE, and noise', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const run = (configure, events) => {
      const context = new OfflineAudioContext(1, 24000, 48000); const starts = []; const stopped = [];
      const create = context.createOscillator.bind(context);
      context.createOscillator = () => {
        const node = create(); const start = node.start.bind(node); const stop = node.stop.bind(node); const item = { time: null };
        node.start = time => { item.time = time ?? 0; starts.push(item); start(time); };
        node.stop = (...args) => { stopped.push(item); stop(...args); };
        return node;
      };
      const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS); configure(settings);
      const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
      synth.setAmplitudeEnvelope({ attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .05, mode: 'gate', attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' });
      events(synth); return { starts: starts.map(item => item.time), stopped: stopped.map(item => item.time) };
    };
    return {
      sync: run(() => {}, synth => { synth.gateOn(.1); synth.gateOn(.1); synth.gateOn(.11); synth.gateOff(.12); synth.gateOn(.3); }),
      free: run(settings => { settings.phaseMode = 'free'; }, synth => synth.gateOn(.1)),
      bypass: run(settings => { settings.blocksEnabled.aenv = false; }, synth => synth.gateOn(.1)),
      noise: run(settings => { settings.osc2.sourceType = 'white-noise'; }, synth => synth.gateOn(.1)),
      initialOff: run(() => {}, synth => { synth.gateOff(0); synth.gateOn(.1); }),
      cancelled: run(() => {}, synth => { synth.gateOn(.2); synth.cancelScheduledGatesFrom(.1); })
    };
  });
  expect(result.sync.starts).toEqual([0, 0, .1, .1, .3, .3]);
  expect(result.free.starts).toEqual([0, 0]);
  expect(result.bypass.starts).toEqual([0, 0]);
  expect(result.noise.starts).toEqual([0, .1]);
  expect(result.initialOff.starts).toEqual([0, 0, .1, .1]);
  expect(result.cancelled.starts).toEqual([0, 0, .2, .2]);
  expect(result.cancelled.stopped.filter(time => time === .2)).toHaveLength(2);
});

test('SYNC produces a repeatable low-frequency phase while FREE keeps the running phase', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { SourceUnit } = await import('/src/audio/dsp/SourceUnit.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const render = async sync => {
      const rate = 48000; const context = new OfflineAudioContext(1, rate / 2, rate);
      const shape = context.createConstantSource(); shape.offset.value = 0; shape.start();
      const source = new SourceUnit(context, new WhiteNoiseFactory(context), shape, 'sine', 7);
      source.output.connect(context.destination);
      if (sync) { source.syncPhaseAt(.1); source.syncPhaseAt(.3); }
      const data = (await context.startRendering()).getChannelData(0);
      const sample = time => data[Math.round(time * rate)];
      const result = [sample(.125), sample(.325)]; source.dispose(); return result;
    };
    return { sync: await render(true), free: await render(false) };
  });
  expect(values.sync[0]).toBeCloseTo(values.sync[1], 4);
  expect(Math.abs(values.free[0] - values.free[1])).toBeGreaterThan(.5);
});
