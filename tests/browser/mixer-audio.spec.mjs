import { test, expect } from '@playwright/test';

test('Per-slot pan reaches both stereo buses and sums four independent L/R inputs through Master', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const render = async (bus, pans) => {
      const context = new OfflineAudioContext(2, 24000, 48000);
      const engine = new AudioEngine(context); engine.setMasterGainDb(0);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      engine.setCrossfade(bus === 'near' ? 0 : 1);
      for (const [index, pan] of pans.entries()) {
        const id = String(index + 1);
        const timbre = defaultTimbre(); timbre.settings.blocksEnabled.osc1 = false; timbre.settings.blocksEnabled.osc2 = false;
        engine.replaceChannel(id, timbre);
        engine.setChannelMix(id, { balance: bus === 'near' ? 0 : 1, pan });
        const source = context.createConstantSource(); source.offset.value = .1; source.connect(engine.getChannel(id).output); source.start();
        engine.gateOn(id);
      }
      const buffer = await context.startRendering();
      const levels = [0, 1].map(channel => {
        const data = buffer.getChannelData(channel).slice(4800, 20000);
        return data.reduce((sum, sample) => sum + sample, 0) / data.length;
      });
      engine.dispose(); return levels;
    };
    const values = [];
    for (const bus of ['near', 'far']) {
      for (const pan of [-1, 0, 1]) values.push({ bus, pan, levels: await render(bus, [pan]) });
      values.push({ bus, pan: 'four', levels: await render(bus, [-1, -1, 1, 1]) });
    }
    return values;
  });
  for (const { pan, levels } of results) {
    const expected = pan === -1 ? [.1, 0] : pan === 1 ? [0, .1] : pan === 0 ? [.1 / Math.SQRT2, .1 / Math.SQRT2] : [.2, .2];
    expect(levels[0]).toBeCloseTo(expected[0], 3);
    expect(levels[1]).toBeCloseTo(expected[1], 3);
  }
});

test('Stereo pan passes through both serial bus effects without collapsing L/R', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const cases = [
      { bus: 'near', effects: [['delay', 'delayWet', 1], ['reverb', 'reverbWet', 1]] },
      { bus: 'far', effects: [['chorus', 'chorusWet', 1], ['distortion', 'distortionWet', 1]] }
    ];
    const results = [];
    for (const { bus, effects } of cases) {
      const context = new OfflineAudioContext(2, 24000, 48000);
      const engine = new AudioEngine(context); engine.setMasterGainDb(0);
      const timbre = defaultTimbre(); timbre.settings.blocksEnabled.osc1 = false; timbre.settings.blocksEnabled.osc2 = false;
      engine.replaceChannel('1', timbre); engine.setChannelMix('1', { balance: bus === 'near' ? 0 : 1, pan: -1 });
      engine.setCrossfade(bus === 'near' ? 0 : 1);
      for (const [index, [type, wet, value]] of effects.entries()) {
        const slot = index + 2;
        await engine.setBusEffectType(bus, slot, type);
        engine.setBusEffectParameter(bus, slot, wet, value);
        engine.setBusEffectEnabled(bus, slot, true);
      }
      const source = context.createConstantSource(); source.offset.value = .1; source.connect(engine.getChannel('1').output); source.start(); engine.gateOn('1');
      const buffer = await context.startRendering();
      results.push([0, 1].map(channel => {
        const data = buffer.getChannelData(channel).slice(9600, 22000);
        return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
      }));
      engine.dispose();
    }
    return results;
  });
  for (const [left, right] of results) {
    expect(left).toBeGreaterThan(.001);
    expect(right).toBeLessThan(left / 10);
  }
});

test('Stereo FX1 reverb keeps its width at center and moves to either side', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const render = async pan => {
      const context = new OfflineAudioContext(2, 24000, 48000);
      const engine = new AudioEngine(context); engine.setMasterGainDb(0);
      engine.setChannelMix('1', { balance: 0, pan }); engine.setCrossfade(0);
      const synth = engine.getChannel('1');
      await synth.setFx1Type('reverb'); synth.setFx1Parameter('reverbDecaySec', .1); synth.setFx1Parameter('reverbWet', 1); synth.setFx1Enabled(true);
      synth.setBlockEnabled('aenv', false); engine.gateOn('1');
      const buffer = await context.startRendering();
      const channels = [0, 1].map(i => buffer.getChannelData(i).slice(4800, 20000));
      const rms = channels.map(data => Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length));
      const difference = Math.sqrt(channels[0].reduce((sum, sample, i) => sum + (sample - channels[1][i]) ** 2, 0) / channels[0].length);
      engine.dispose(); return { rms, difference };
    };
    return { center: await render(0), left: await render(-1), right: await render(1) };
  });
  expect(results.center.rms[0]).toBeGreaterThan(.001);
  expect(results.center.rms[1]).toBeGreaterThan(.001);
  expect(results.center.difference).toBeGreaterThan(.001);
  expect(results.left.rms[0]).toBeGreaterThan(.001);
  expect(results.left.rms[1]).toBeLessThan(.0001);
  expect(results.right.rms[0]).toBeLessThan(.0001);
  expect(results.right.rms[1]).toBeGreaterThan(.001);
});

test('Live pan movement ramps without an L/R step', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const context = new OfflineAudioContext(2, 12000, 48000);
    const engine = new AudioEngine(context); engine.setMasterGainDb(0);
    engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
    const timbre = defaultTimbre(); timbre.settings.blocksEnabled.osc1 = false; timbre.settings.blocksEnabled.osc2 = false;
    engine.replaceChannel('1', timbre); engine.setChannelMix('1', { balance: 0, pan: -1 }); engine.setCrossfade(0);
    const source = context.createConstantSource(); source.offset.value = .1; source.connect(engine.getChannel('1').output); source.start(); engine.gateOn('1');
    const pause = context.suspend(.1), rendering = context.startRendering(); await pause;
    engine.setChannelMix('1', { pan: 1 }); await context.resume();
    const buffer = await rendering;
    const result = [0, 1].map(channel => {
      const data = buffer.getChannelData(channel);
      return { before: data[4799], step: Math.abs(data[4800] - data[4799]), after: data[8000] };
    });
    engine.dispose(); return result;
  });
  expect(result[0].before).toBeCloseTo(.1, 3); expect(result[1].before).toBeCloseTo(0, 3);
  expect(result[0].step).toBeLessThan(.001); expect(result[1].step).toBeLessThan(.001);
  expect(result[0].after).toBeCloseTo(0, 3); expect(result[1].after).toBeCloseTo(.1, 3);
});

test('Two equal-power stages reproduce cos of the position difference at endpoints and center', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { AudioEngine, equalPower } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultBus, defaultTimbre, DEFAULT_CHANNEL_MIX } = await import('/src/model/documents.ts');
    const results = [];
    for (const balance of [0, .5, 1]) for (const crossfade of [0, .5, 1]) {
      const context = new OfflineAudioContext(1, 24000, 48000);
      const timbre = defaultTimbre(); timbre.settings.blocksEnabled.aenv = false; 
      const engine = new AudioEngine(context, { formatVersion: 'KOROGI-Lab/session-v4', name: 'Test', savedAt: '', channels: [{ id: 'a', ...DEFAULT_CHANNEL_MIX, balance, timbre }],
        near: defaultBus(), far: defaultBus(), crossfade, masterGainDb: 0, masterMuted: false });
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      engine.gateOn('a');
      const samples = (await context.startRendering()).getChannelData(0);
      const rms = Math.sqrt(samples.slice(4800).reduce((sum, x) => sum + x * x, 0) / (samples.length - 4800));
      results.push({ balance, crossfade, amplitude: rms * Math.sqrt(2) }); engine.dispose();
    }
    return { results, endpoints: [equalPower(0), equalPower(1)] };
  });
  expect(metrics.endpoints).toEqual([[1, 0], [0, 1]]);
  // A mono destination folds the new centered stereo pan down by 1/sqrt(2).
  for (const item of metrics.results) expect(item.amplitude).toBeCloseTo(10 ** (-18 / 20) * Math.cos((item.balance - item.crossfade) * Math.PI / 2) / Math.SQRT2, 4);
});

test('Four real sources sum independently; post-FX1 fader and sends retain source distortion', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const render = async sourceFx => {
      const context = new OfflineAudioContext(1, 48000, 48000); const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination); engine.setMasterGainDb(0);
      const channel = engine.getChannel('1'); channel.setFx1Parameter('distortionDriveDb', 16); channel.setBlockEnabled('aenv', false);
      if (sourceFx) { await channel.setFx1Type('distortion'); channel.setFx1Enabled(true); channel.setFx1Parameter('distortionWet', 1); }
      else { await engine.setBusEffectType('near', 2, 'distortion'); engine.setBusEffectEnabled('near', 2, true); engine.setBusEffectParameter('near', 2, 'distortionWet', 1); engine.setBusEffectParameter('near', 2, 'distortionDriveDb', 16); }
      engine.setChannelMix('1', { balance: 0 }); engine.setCrossfade(0); engine.gateOn('1');
      for (const [id, frequency] of [['2', 700], ['3', 1100], ['4', 1700]]) {
        const timbre = defaultTimbre(); timbre.settings.osc1.baseFrequencyHz = frequency; timbre.settings.blocksEnabled.aenv = false;
        engine.replaceChannel(id, timbre); engine.setChannelMix(id, { balance: 0, gainDb: -2 }); engine.gateOn(id);
      }
      const fx1 = JSON.stringify(channel.getFx1Settings());
      const suspension = context.suspend(.5); const rendering = context.startRendering(); await suspension;
      if (sourceFx) { engine.setChannelMix('1', { gainDb: -6, balance: .5 }); engine.setCrossfade(.5); }
      await context.resume(); const samples = (await rendering).getChannelData(0);
      const amplitude = (frequency, a, b) => {
        let sin = 0, cos = 0; const start = Math.round(a * 48000), end = Math.round(b * 48000);
        for (let i = start; i < end; i++) { const phase = 2 * Math.PI * frequency * i / 48000; sin += samples[i] * Math.sin(phase); cos += samples[i] * Math.cos(phase); }
        return 2 * Math.hypot(sin, cos) / (end - start);
      };
      const result = { before: amplitude(4000, .2, .4), after: amplitude(4000, .7, .9), others: [700, 1100, 1700].map(hz => amplitude(hz, .2, .4)),
        intermod: amplitude(2600, .2, .4), retained: fx1 === JSON.stringify(channel.getFx1Settings()) };
      engine.dispose(); return result;
    };
    return { source: await render(true), bus: await render(false) };
  });
  expect(metrics.source.before).toBeGreaterThan(.4);
  expect(metrics.source.after / metrics.source.before).toBeCloseTo(10 ** (-6 / 20), 3);
  for (const amplitude of metrics.source.others) expect(amplitude).toBeCloseTo(.1 / Math.SQRT2, 3);
  expect(metrics.source.intermod).toBeLessThan(.002); expect(metrics.source.retained).toBe(true);
  expect(metrics.bus.intermod).toBeGreaterThan(.005); // Positive control: nonlinear processing after summation couples sources.
});

test('Near and Far have independent serial FX2/FX3, and slot mute leaves bus tails while Master mute suppresses them', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const render = async bus => {
      const context = new OfflineAudioContext(1, 24000, 48000); const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination); engine.setMasterGainDb(0);
      engine.setChannelMix('1', { balance: bus === 'near' ? 0 : 1 }); engine.setCrossfade(bus === 'near' ? 0 : 1);
      for (const [slot, time] of [[2, .03], [3, .07]]) {
        await engine.setBusEffectType(bus, slot, 'delay'); engine.setBusEffectParameter(bus, slot, 'delayTimeSec', time);
        engine.setBusEffectEnabled(bus, slot, true);
        engine.setBusEffectParameter(bus, slot, 'delayFeedback', .5); engine.setBusEffectParameter(bus, slot, 'delayWet', 1);
      }
      const source = engine.getChannel('1'); source.setAmplitudeEnvelope({ attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .001 });
      engine.gateOn('1', .02); engine.gateOff('1', .04);
      const suspensions = [context.suspend(.08), context.suspend(.22)]; const rendering = context.startRendering();
      await suspensions[0]; engine.setChannelMix('1', { muted: true }); await context.resume();
      await suspensions[1]; engine.setMasterMuted(true); await context.resume();
      const samples = (await rendering).getChannelData(0);
      const peak = (a, b) => Math.max(...samples.slice(Math.round(a * 48000), Math.round(b * 48000)).map(Math.abs));
      const result = { preDelay: peak(.03, .09), tail: peak(.12, .15), muted: peak(.26, .49), untouched: engine.getBusSettings(bus === 'near' ? 'far' : 'near').effects.map(fx => fx.type) };
      engine.dispose(); return result;
    };
    return Promise.all([render('near'), render('far')]);
  });
  for (const item of metrics) {
    expect(item.preDelay).toBeLessThan(.0001); expect(item.tail).toBeGreaterThan(.01); expect(item.muted).toBe(0); expect(item.untouched).toEqual(['chorus', 'reverb']);
  }
});

test('Load and replacement remain silent with AEnv bypass; invalid preparation preserves the live graph and Auto', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts'); const { defaultTimbre } = await import('/src/model/documents.ts');
    const context = new OfflineAudioContext(1, 24000, 48000); const engine = new AudioEngine(context);
    engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination); engine.setMasterGainDb(0);
    const timbre = defaultTimbre(); timbre.settings.blocksEnabled.aenv = false;
    engine.replaceChannel('1', timbre);
    const suspension = context.suspend(.2); const rendering = context.startRendering(); await suspension;
    engine.gateOn('1'); await context.resume(); const samples = (await rendering).getChannelData(0);
    const peak = (a, b) => Math.max(...samples.slice(Math.round(a * 48000), Math.round(b * 48000)).map(Math.abs));
    const before = peak(.05, .15), after = peak(.3, .4); engine.dispose();
    const live = new AudioEngine(); live.startAuto('1');
    const old = live.getChannel('1'); const snapshot = live.createSession('Keep');
    const invalid = structuredClone(snapshot); delete invalid.channels[0].timbre.settings.fx1;
    let failed = false; try { await live.applySession(invalid); } catch { failed = true; }
    const kept = live.getChannel('1') === old && old.isAutoTriggerRunning();
    const invalidPan = structuredClone(snapshot); invalidPan.channels[0].pan = Number.NaN;
    let panRejected = false; try { await live.applySession(invalidPan); } catch { panRejected = true; }
    const keptAfterPan = live.getChannel('1') === old && old.isAutoTriggerRunning() && live.getChannelMix('1').pan === 0;
    const originalCreateGain = live.context.createGain.bind(live.context);
    live.context.createGain = () => { throw new Error('injected preparation failure'); };
    let preparedFailure = false; try { await live.applySession(snapshot); } catch { preparedFailure = true; }
    live.context.createGain = originalCreateGain;
    const keptAfterFailure = live.getChannel('1') === old && old.isAutoTriggerRunning();
    live.replaceChannel('1', defaultTimbre()); const retiredStopped = !old.isAutoTriggerRunning();
    const superseded = live.getChannel('1'); const pending = superseded.setFx1Type('chorus');
    live.clearChannel('1'); await pending;
    await new Promise(resolve => setTimeout(resolve, 40));
    const listenersCleared = old.gateListeners.size === 0;
    await live.close();
    return { before, after, failed, kept, panRejected, keptAfterPan, preparedFailure, keptAfterFailure, retiredStopped, listenersCleared };
  });
  expect(result.before).toBe(0); expect(result.after).toBeGreaterThan(.08);
  for (const key of ['failed', 'kept', 'panRejected', 'keptAfterPan', 'preparedFailure', 'keptAfterFailure', 'retiredStopped', 'listenersCleared']) expect(result[key], key).toBe(true);
});

test('Four Auto schedulers and Manual ownership are independent; session restore clears playback and allows later start', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts'); const { defaultTimbre } = await import('/src/model/documents.ts');
    const engine = new AudioEngine(); await engine.start();
    for (const id of ['2', '3', '4']) { const t = defaultTimbre(); t.settings.osc1.baseFrequencyHz = Number(id) * 1000; engine.replaceChannel(id, t); }
    for (const id of ['1', '2', '3', '4']) engine.startAuto(id);
    const allAuto = engine.getChannelIds().every(id => engine.getChannel(id).isAutoTriggerRunning());
    engine.gateOn('1'); engine.gateOn('2'); const manualEvents = [];
    const unsubscribe = engine.getChannel('1').addGateScheduleListener(event => manualEvents.push(event.kind));
    engine.startAuto('1'); engine.gateOff('1');
    const protectedAuto = engine.getChannel('1').isAutoTriggerRunning() && manualEvents.at(-1) === 'on';
    const othersRunning = ['3', '4'].every(id => engine.getChannel(id).isAutoTriggerRunning());
    const session = engine.createSession('Four'); unsubscribe(); await engine.applySession(session);
    const stopped = engine.getChannelIds().every(id => !engine.getChannel(id).isAutoTriggerRunning());
    engine.startAuto('4'); const restarted = engine.getChannel('4').isAutoTriggerRunning(); await engine.close();
    return { allAuto, protectedAuto, othersRunning, stopped, restarted };
  });
  expect(Object.values(result).every(Boolean)).toBe(true);
});

test('Repeated send/crossfade/level changes remain continuous, and valid session restore keeps bypassed sources silent', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const context = new OfflineAudioContext(1, 48000, 48000); const engine = new AudioEngine(context);
    engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination); engine.setMasterGainDb(0);
    engine.getChannel('1').setBlockEnabled('osc1', false);
    // A DC test input at the public post-FX1 output isolates control discontinuities.
    const dc = context.createConstantSource(); dc.offset.value = .25; dc.connect(engine.getChannel('1').output); dc.start(); engine.gateOn('1');
    const bypass = defaultTimbre(); bypass.settings.blocksEnabled.aenv = false; 
    const session = engine.createSession('Restore'); session.channels[0].timbre = bypass;
    const actions = [
      [.1, () => { engine.setChannelMix('1', { balance: 0 }); engine.setCrossfade(0); }],
      [.15, () => { engine.setChannelMix('1', { balance: .2 }); engine.setCrossfade(.2); }],
      [.2, () => { engine.setChannelMix('1', { balance: 1, gainDb: -6 }); engine.setCrossfade(1); }],
      [.25, () => { engine.setChannelMix('1', { balance: .5, gainDb: 0 }); engine.setCrossfade(.5); }],
      [.3, () => engine.setChannelMix('1', { muted: true })],
      [.35, () => engine.setChannelMix('1', { muted: false })],
      [.4, async () => { await engine.applySession(session); dc.stop(); }],
      [.7, () => engine.gateOn('1')]
    ];
    const suspensions = actions.map(([time]) => context.suspend(time)); const rendering = context.startRendering();
    for (let i = 0; i < actions.length; i++) { await suspensions[i]; await actions[i][1](); await context.resume(); }
    const samples = (await rendering).getChannelData(0);
    let jump = 0; for (let i = 4801; i < 19200; i++) jump = Math.max(jump, Math.abs(samples[i] - samples[i - 1]));
    const peak = (a, b) => Math.max(...samples.slice(Math.round(a * 48000), Math.round(b * 48000)).map(Math.abs));
    const result = { jump, silentRestore: peak(.5, .65), restarted: peak(.8, .9), steady: samples[Math.round(.28 * 48000)] };
    dc.disconnect(); engine.dispose(); return result;
  });
  expect(result.jump).toBeLessThan(.005); expect(result.steady).toBeCloseTo(.25 / Math.SQRT2, 4);
  expect(result.silentRestore).toBe(0); expect(result.restarted).toBeCloseTo(10 ** (-18 / 20) / Math.SQRT2, 5);
});

for (const sampleRate of [44100, 48000]) {
  test(`Four-source nominal level retains headroom through the actual compressor at ${sampleRate} Hz`, async ({ page }) => {
    await page.goto('/');
    const peak = await page.evaluate(async sampleRate => {
      const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts'); const { defaultTimbre } = await import('/src/model/documents.ts');
      const context = new OfflineAudioContext(2, sampleRate * 1.5, sampleRate); const engine = new AudioEngine(context);
      for (const id of ['2', '3', '4']) engine.replaceChannel(id, defaultTimbre());
      for (const id of ['1', '2', '3', '4']) engine.gateOn(id);
      const audio = await context.startRendering();
      let peak = 0; for (let channel = 0; channel < audio.numberOfChannels; channel++) for (const sample of audio.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
      engine.dispose(); return peak;
    }, sampleRate);
    expect(peak).toBeGreaterThan(.01); expect(peak).toBeLessThan(.5);
  });
}

test('Rapid FX selection returning to the current type cancels a pending rebuild, including after disposal', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { EffectSlot } = await import('/src/audio/effects/EffectSlot.ts');
    const context = new AudioContext(); const fx = new EffectSlot(context, 'rapid');
    const pending = fx.setType('chorus'); await fx.setType('off'); await pending;
    const type = fx.getSettings().type;
    const disposed = fx.setType('chorus'); fx.dispose(); await disposed;
    const noRebuild = fx.chorusLfo === null; await context.close(); return { type, noRebuild };
  });
  expect(result).toEqual({ type: 'off', noRebuild: true });
});
