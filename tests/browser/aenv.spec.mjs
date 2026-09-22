import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('one AEnv curve choice controls all three phases and fits at tablet widths', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await page.locator('#flow-aenv').click();
  await expect(page.locator('#aenv-curve')).toBeHidden();
  await expect(page.locator('#aenv-curve + .segmented-choice [role="radio"]')).toHaveCount(2);
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 768 });
    await page.locator('#flow-aenv').click();
    await expect(page.locator('.aenv-curve-control')).toBeVisible();
    const placement = await page.locator('.aenv-curve-control').evaluate(control => {
      const bounds = control.getBoundingClientRect();
      const fieldset = control.closest('fieldset').getBoundingClientRect();
      const inputs = control.parentElement.previousElementSibling.getBoundingClientRect();
      const buttons = [...control.querySelectorAll('[role="radio"]')];
      const first = buttons[0].getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width, fieldLeft: fieldset.left, fieldRight: fieldset.right,
        top: bounds.top, inputsBottom: inputs.bottom, firstLeft: first.left, firstWidth: first.width,
        heights: buttons.map(button => button.getBoundingClientRect().height),
        textFits: buttons.every(button => button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight) };
    });
    expect(placement.left).toBeGreaterThanOrEqual(placement.fieldLeft);
    expect(placement.right).toBeLessThanOrEqual(placement.fieldRight);
    expect(placement.top).toBeGreaterThanOrEqual(placement.inputsBottom);
    expect(placement.firstLeft - placement.left).toBeLessThan(5);
    expect(placement.width).toBeLessThanOrEqual(240);
    expect(placement.heights).toEqual([28, 28]);
    expect(placement.firstWidth).toBeGreaterThan(100);
    expect(placement.textFits).toBe(true);
  }
  await page.locator('#aenv-curve + .segmented-choice [data-value="linear"]').click();
  await expect(page.locator('#aenv-curve')).toHaveValue('linear');
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.settings.ampEnvelope).toMatchObject({
    attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear'
  });
});

test('one-shot mode keeps Gate timing while Auto repeat becomes independent', async ({ page }) => {
  await page.goto('/');
  await page.locator('#flow-aenv').click();
  await page.locator('#aenv-mode + .segmented-choice [data-value="one-shot"]').click();
  await page.locator('[data-panel-target="triggering"]').first().click();
  await expect(page.locator('[data-numeric-control="ton"]')).toBeVisible();
  expect(Number(await page.locator('[data-numeric-control="ton"]').evaluate(node => getComputedStyle(node).opacity))).toBeLessThan(1);
  await expect(page.locator('#ton')).toBeDisabled();
  await expect(page.locator('#ton-coarse')).toBeDisabled();
  await expect(page.locator('#ton-one-shot-status')).toHaveText('AEnv One Shot Mode');
  await expect(page.locator('#ton-one-shot-status')).toBeVisible();
  await expect(page.locator('[data-numeric-control="ton"] .numeric-caption')).toContainText('Ton');
  await expect(page.locator('[data-numeric-control="ton"] .numeric-caption')).not.toContainText('Auto');
  await page.locator('#trepeat').fill('20');
  await page.locator('#trepeat').dispatchEvent('change');
  await expect(page.locator('#trepeat')).toHaveValue('20');
  const first = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await first).path(), 'utf8'));
  expect(timbre.settings.ampEnvelope.mode).toBe('one-shot');
  expect(timbre.settings.autoTrigger).toMatchObject({ tonSec: .25, toffSec: .25, oneShotRepeatSec: .02 });
  await page.locator('#flow-aenv').click();
  await page.locator('#aenv-mode + .segmented-choice [data-value="gate"]').click();
  await page.locator('[data-panel-target="triggering"]').first().click();
  await expect(page.locator('[data-numeric-control="ton"]')).toBeVisible();
  await expect(page.locator('#ton')).toBeEnabled();
  await expect(page.locator('#ton-one-shot-status')).toBeHidden();
  await expect(page.locator('#trepeat')).toHaveValue('500');
});

test('legacy timbre without mode or one-shot repeat loads as Gate and saves defaults', async ({ page }) => {
  await page.goto('/');
  const first = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const legacy = JSON.parse(await readFile(await (await first).path(), 'utf8'));
  delete legacy.settings.ampEnvelope.mode;
  delete legacy.settings.autoTrigger.oneShotRepeatSec;
  await page.locator('#timbre-file-1').setInputFiles({ name: 'legacy-timbre.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1');
  await page.locator('#flow-aenv').click();
  await expect(page.locator('#aenv-mode + .segmented-choice [data-value="gate"]')).toHaveAttribute('aria-checked', 'true');
  const second = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const saved = JSON.parse(await readFile(await (await second).path(), 'utf8'));
  expect(saved.settings.ampEnvelope.mode).toBe('gate');
  expect(saved.settings.autoTrigger.oneShotRepeatSec).toBeCloseTo(saved.settings.autoTrigger.tonSec + saved.settings.autoTrigger.toffSec);
});

test('one-shot audio follows A-D-R after early OFF and retriggers from the current level', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const rate = 48000;
    const context = new OfflineAudioContext(1, rate * 2, rate);
    const env = new AmplitudeEnvelope(context, { attackSec: .1, decaySec: .2, sustain: .5, releaseSec: .3,
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', mode: 'one-shot' });
    const source = context.createConstantSource(); source.connect(env.node); env.node.connect(context.destination); source.start();
    env.gateOn(.1); env.gateOff(.12); env.gateOff(.35);
    env.gateOn(.5); env.gateOff(.51);
    const data = (await context.startRendering()).getChannelData(0);
    return [.15, .2, .3, .4, .5, .55, .6, .8, 1.1].map(t => data[Math.round(t * rate)]);
  });
  const floor = 1e-4;
  const from = .5 + (floor - .5) / 3;
  const expected = [.50005, 1, .75, .5, from, (from + 1) / 2, 1, .5, floor];
  expected.forEach((value, index) => expect(result[index]).toBeCloseTo(value, 3));
});

test('one-shot keeps its ON snapshot and reaches silence when Sustain is zero', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const rate = 48000;
    const context = new OfflineAudioContext(1, rate, rate);
    const initial = { attackSec: .1, decaySec: .2, sustain: 0, releaseSec: .3,
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', mode: 'one-shot' };
    const env = new AmplitudeEnvelope(context, initial);
    const source = context.createConstantSource(); source.connect(env.node); env.node.connect(context.destination); source.start();
    env.gateOn(.1);
    env.setSettings({ ...initial, mode: 'gate', decaySec: .05, sustain: 1, releaseSec: .01 });
    env.gateOff(.15);
    const data = (await context.startRendering()).getChannelData(0);
    return [.15, .2, .25, .3, .4, .6].map(t => data[Math.round(t * rate)]);
  });
  expect(values[0]).toBeCloseTo(.50005, 3);
  expect(values[1]).toBeCloseTo(1, 3);
  expect(values[2]).toBeCloseTo(.750025, 3);
  expect(values[3]).toBeCloseTo(.50005, 3);
  expect(values.slice(4).every(value => value < .001)).toBe(true);
});

test('Manual, Trigger and loop cancellation retain an already started one-shot', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const rate = 48000;
    const render = async (kind) => {
      const context = new OfflineAudioContext(1, rate, rate);
      const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
      settings.blocksEnabled.osc1 = false; settings.blocksEnabled.osc2 = false;
      settings.ampEnvelope = { attackSec: .05, decaySec: .1, sustain: .5, releaseSec: .3,
        attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', mode: 'one-shot' };
      const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
      const source = context.createConstantSource();
      source.connect(synth.ampEnvelope.node); synth.ampEnvelope.node.connect(context.destination); source.start();
      if (kind === 'trigger') { synth.triggerGateOn(); synth.triggerGateOff(); }
      else if (kind === 'auto' || kind === 'auto-stop') {
        synth.startAutoTrigger();
        if (kind === 'auto-stop') synth.stopAutoTrigger();
      }
      else { synth.gateOn(.02); synth.gateOff(.03); if (kind === 'loop-stop') synth.cancelScheduledGatesFrom(.2); }
      const data = (await context.startRendering()).getChannelData(0);
      const levels = [data[Math.round(.25 * rate)], data[Math.round(.55 * rate)]];
      if (kind === 'auto') synth.stopAutoTrigger();
      return levels;
    };
    return { manual: await render('manual'), trigger: await render('trigger'), auto: await render('auto'),
      loopStop: await render('loop-stop'), autoStop: await render('auto-stop') };
  });
  for (const levels of [results.manual, results.trigger, results.auto, results.loopStop]) {
    expect(levels[0]).toBeGreaterThan(.15);
    expect(levels[1]).toBeLessThan(.001);
  }
  expect(results.autoStop.every(level => level < .001)).toBe(true);
});

test('mixed internal AEnv curves survive a time edit until a common choice is made', async ({ page }) => {
  await page.goto('/');
  const first = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await first).path(), 'utf8'));
  Object.assign(timbre.settings.ampEnvelope, { attackCurve: 'linear', decayCurve: 'exponential', releaseCurve: 'linear' });
  await page.locator('#timbre-file-1').setInputFiles({ name: 'mixed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1');
  await page.locator('#flow-aenv').click();
  await expect(page.locator('#aenv-curve-status')).toBeVisible();
  await expect(page.locator('#aenv-curve + .segmented-choice [aria-checked="true"]')).toHaveCount(0);
  await page.locator('#attack').fill('12');
  await page.locator('#attack').dispatchEvent('change');
  const second = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const saved = JSON.parse(await readFile(await (await second).path(), 'utf8'));
  expect(saved.settings.ampEnvelope).toMatchObject({ attackSec: .012,
    attackCurve: 'linear', decayCurve: 'exponential', releaseCurve: 'linear' });
  await page.locator('#aenv-curve + .segmented-choice [data-value="exponential"]').click();
  await expect(page.locator('#aenv-curve-status')).toBeHidden();
  const third = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const unified = JSON.parse(await readFile(await (await third).path(), 'utf8'));
  expect(unified.settings.ampEnvelope).toMatchObject({
    attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential'
  });
});

test('linear AEnv follows gain straight lines through Attack, Decay and Release', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const rate = 48000;
    const context = new OfflineAudioContext(1, rate * 2, rate);
    const envelope = new AmplitudeEnvelope(context, { attackSec: .4, decaySec: .4, sustain: .5, releaseSec: .3,
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' });
    const source = context.createConstantSource();
    source.connect(envelope.node); envelope.node.connect(context.destination); source.start();
    envelope.gateOn(.1); envelope.gateOff(1.2);
    const data = (await context.startRendering()).getChannelData(0);
    return [.3, .7, 1.05, 1.35, 1.5].map(time => data[Math.round(time * rate)]);
  });
  for (const [actual, expected] of values.map((actual, index) => [actual, [.50005, .75, .5, .25005, .0001][index]])) {
    expect(actual).toBeCloseTo(expected, 3);
  }
});

for (const ton of [0.5, 0.2, 0.1]) {
  for (const sourceType of ['constant', 'sine']) {
    test(`Sustain and Release: Ton=${ton}s, ${sourceType}`, async ({ page }, testInfo) => {
      await page.goto('/');
      const metrics = await page.evaluate(async ({ ton, sourceType }) => {
        const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
        const rate = 48000;
        const context = new OfflineAudioContext(1, rate * 2, rate);
        const envelope = new AmplitudeEnvelope(context, { attackSec: .001, decaySec: .001, sustain: 1, releaseSec: 1 });
        const source = sourceType === 'constant' ? context.createConstantSource() : context.createOscillator();
        if (sourceType === 'sine') source.frequency.value = 4500;
        source.connect(envelope.node);
        envelope.node.connect(context.destination);
        source.start();
        const on = .02, off = on + ton;
        envelope.gateOn(on);
        const suspended = context.suspend(off - .075);
        const rendering = context.startRendering();
        await suspended;
        envelope.gateOff(off); // actual lookahead submission, after Sustain began
        await context.resume();
        const data = (await rendering).getChannelData(0);
        let sustainError = 0, releaseError = 0;
        for (let i = Math.ceil((on + .003) * rate); i < Math.floor((off + 1.01) * rate); i++) {
          const t = i / rate;
          const expectedGain = t < off ? 1 : Math.pow(1e-4, Math.min(1, t - off));
          const carrier = sourceType === 'constant' ? 1 : Math.sin(2 * Math.PI * 4500 * t);
          const error = Math.abs(data[i] - expectedGain * carrier);
          if (t < off) sustainError = Math.max(sustainError, error);
          else releaseError = Math.max(releaseError, error);
        }
        return { sustainError, releaseError, beforeOff: data[Math.round(off * rate) - 1], atOff: data[Math.round(off * rate)], releaseEnd: data[Math.round((off + 1) * rate)] };
      }, { ton, sourceType });
      await testInfo.attach('waveform-metrics', { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
      expect(metrics.sustainError, JSON.stringify(metrics)).toBeLessThan(.001);
      expect(metrics.releaseError, JSON.stringify(metrics)).toBeLessThan(.001);
    });
  }
}

const envelopeCases = [
  { name: 'OFF during Attack', settings: { attackSec: .5, decaySec: .3, sustain: .4, releaseSec: 1 }, off: .25 },
  { name: 'OFF during Decay', settings: { attackSec: .1, decaySec: .5, sustain: .2, releaseSec: 1 }, off: .3 },
  { name: 'retrigger during Release', settings: { attackSec: .1, decaySec: .1, sustain: .4, releaseSec: 1 }, off: .3, retrigger: .5 },
  { name: 'zero Sustain', settings: { attackSec: .1, decaySec: .1, sustain: 0, releaseSec: 1 }, off: .3 },
  { name: 'silence then restart', settings: { attackSec: .1, decaySec: .1, sustain: 1, releaseSec: 1 }, off: .3, silence: .45, retrigger: .5 },
];
for (const scenario of envelopeCases) {
  test(scenario.name, async ({ page }) => {
    await page.goto('/');
    const error = await page.evaluate(async (scenario) => {
      const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
      const context = new OfflineAudioContext(1, 48000 * 2, 48000);
      const envelope = new AmplitudeEnvelope(context, scenario.settings);
      const input = context.createConstantSource();
      input.connect(envelope.node); envelope.node.connect(context.destination); input.start();
      const { attackSec: a, decaySec: d, sustain: s, releaseSec: r } = scenario.settings;
      const floor = 1e-4;
      const rise = (elapsed, start) => elapsed < a ? start ** (1 - elapsed / a)
        : elapsed < a + d ? Math.max(s, floor) ** ((elapsed - a) / d) : Math.max(s, floor);
      const offGain = rise(scenario.off, floor);
      const release = (elapsed) => offGain * (floor / offGain) ** Math.min(1, elapsed / r);
      envelope.gateOn(0);
      envelope.gateOff(scenario.off);
      if (scenario.silence) envelope.silence(scenario.silence);
      if (scenario.retrigger) envelope.gateOn(scenario.retrigger);
      const samples = (await context.startRendering()).getChannelData(0);
      let maxError = 0;
      for (let i = 0; i < samples.length; i++) {
        const t = i / 48000;
        let expected = t < scenario.off ? rise(t, floor) : release(t - scenario.off);
        if (scenario.silence && t >= scenario.silence) expected = 0;
        if (scenario.retrigger && t >= scenario.retrigger) {
          const start = scenario.silence ? floor : release(scenario.retrigger - scenario.off);
          expected = rise(t - scenario.retrigger, start);
        }
        maxError = Math.max(maxError, Math.abs(samples[i] - expected));
      }
      return maxError;
    }, scenario);
    expect(error).toBeLessThan(.001);
  });
}

for (const ton of [.1, .2, .5]) {
  test(`Auto scheduler plus AEnv, Ton=${ton}s`, async ({ page }) => {
    await page.goto('/');
    const metrics = await page.evaluate(async (ton) => {
      const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
      const { AutoTriggerScheduler } = await import('/src/audio/scheduler/AutoTriggerScheduler.ts');
      const rate = 48000;
      const duration = 2 * (ton + 1) + .05;
      const context = new OfflineAudioContext(1, Math.ceil(rate * duration), rate);
      const envelope = new AmplitudeEnvelope(context, { attackSec: .001, decaySec: .001, sustain: 1, releaseSec: 1 });
      const input = context.createConstantSource();
      input.connect(envelope.node); envelope.node.connect(context.destination); input.start();
      const events = [];
      const target = {
        gateOn(time) { events.push({ kind: 'on', time }); envelope.gateOn(time); },
        gateOff(time) { events.push({ kind: 'off', time }); envelope.gateOff(time); }
      };
      // Drive the real lookahead scheduler at audio-clock suspensions, independent
      // of the speed of OfflineAudioContext rendering and wall-clock timers.
      let tick;
      const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
      globalThis.setInterval = (callback) => { tick = callback; return 123; };
      globalThis.clearInterval = () => {};
      const scheduler = new AutoTriggerScheduler(context, target, { tonSec: ton, toffSec: 1 });
      try { scheduler.start(); } finally { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
      const suspensions = [];
      for (let time = .025; time < duration - .1; time += .025) suspensions.push(context.suspend(time));
      const rendering = context.startRendering();
      for (const suspended of suspensions) { await suspended; tick(); await context.resume(); }
      scheduler.stop(false);
      const samples = (await rendering).getChannelData(0);
      let maxError = 0;
      for (let cycle = 0; cycle < 2; cycle++) {
        const on = .02 + cycle * (ton + 1), off = on + ton;
        for (let i = Math.ceil((on + .003) * rate); i < Math.floor((off + .999) * rate); i++) {
          const t = i / rate;
          const expected = t < off ? 1 : 1e-4 ** (t - off);
          maxError = Math.max(maxError, Math.abs(samples[i] - expected));
        }
      }
      return { maxError, events };
    }, ton);
    expect(metrics.maxError).toBeLessThan(.001);
    expect(metrics.events.slice(0, 4).map((event) => event.kind)).toEqual(['on', 'off', 'on', 'off']);
    expect(metrics.events[1].time - metrics.events[0].time).toBeCloseTo(ton, 8);
    expect(metrics.events[2].time - metrics.events[1].time).toBeCloseTo(1, 8);
  });
}

test('AEnv bypass tracks Gates and resumes the current envelope', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const context = new OfflineAudioContext(1, 48000 * 2, 48000);
    const envelope = new AmplitudeEnvelope(context, { attackSec: .001, decaySec: .001, sustain: .5, releaseSec: .2 });
    const input = context.createConstantSource();
    input.connect(envelope.node); envelope.node.connect(context.destination); input.start();
    envelope.setEnabled(false);
    envelope.gateOn(.02); envelope.gateOff(.2);
    const actions = [[.1, true], [.25, false], [.3, true]];
    const suspensions = actions.map(([time]) => context.suspend(time));
    const rendering = context.startRendering();
    for (let i = 0; i < actions.length; i++) {
      await suspensions[i]; envelope.setEnabled(actions[i][1]); await context.resume();
    }
    const samples = (await rendering).getChannelData(0);
    let priorUnityError = 0;
    for (const [a, b] of [[.05, .08], [.27, .29]]) {
      for (let i = a * 48000; i < b * 48000; i++) priorUnityError = Math.max(priorUnityError, Math.abs(samples[i] - 1));
    }
    return { values: [.05, .15, .28, .35].map((time) => samples[Math.round(time * 48000)]), priorUnityError };
  });
  expect(metrics.values[0]).toBeCloseTo(1, 5);
  expect(metrics.values[1]).toBeCloseTo(.5, 5);
  expect(metrics.values[2]).toBeCloseTo(1, 5);
  expect(metrics.values[3]).toBeCloseTo(1e-4, 5);
  expect(metrics.priorUnityError).toBeLessThan(.001);
});

test('Manual/Auto ownership cancels pending Gates; Auto stop and restart', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000 * 1.5, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.baseFrequencyHz = 4500;
    settings.ampEnvelope = { attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .2 };
    settings.autoTrigger = { tonSec: .1, toffSec: .05 };
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    channel.output.connect(context.destination);
    const events = []; channel.addGateScheduleListener((event) => events.push(event));
    let tick = () => {};
    const start = () => {
      const set = globalThis.setInterval, clear = globalThis.clearInterval;
      globalThis.setInterval = (callback) => { tick = callback; return 123; };
      globalThis.clearInterval = () => {};
      try { channel.startAutoTrigger(); } finally { globalThis.setInterval = set; globalThis.clearInterval = clear; }
    };
    start();
    const actions = [
      [.05, () => tick()], [.075, () => tick()], [.08, () => channel.gateOn()],
      [.25, () => channel.gateOff()], [.28, start], [.29, () => channel.gateOff()],
      [.325, () => tick()], [.375, () => tick()], [.38, () => channel.stopAutoTrigger()],
      [.7, start], [.75, () => tick()], [.8, () => channel.stopAutoTrigger()]
    ];
    const suspensions = actions.map(([time]) => context.suspend(time));
    const rendering = context.startRendering();
    const actual = {};
    for (let i = 0; i < actions.length; i++) {
      await suspensions[i]; actual[actions[i][0]] = context.currentTime; actions[i][1](); await context.resume();
    }
    const samples = (await rendering).getChannelData(0);
    let heldError = 0, stoppedPeak = 0, restartedPeak = 0;
    for (let i = .1 * 48000; i < .24 * 48000; i++) heldError = Math.max(heldError, Math.abs(samples[i] - 10 ** (-18 / 20) * Math.sin(2 * Math.PI * 4500 * i / 48000)));
    for (let i = .6 * 48000; i < .69 * 48000; i++) stoppedPeak = Math.max(stoppedPeak, Math.abs(samples[i]));
    for (let i = .73 * 48000; i < .79 * 48000; i++) restartedPeak = Math.max(restartedPeak, Math.abs(samples[i]));
    return { heldError, stoppedPeak, restartedPeak, events, actual };
  });
  expect(metrics.heldError).toBeLessThan(.001);
  expect(metrics.stoppedPeak).toBeLessThan(.00011);
  expect(metrics.restartedPeak).toBeGreaterThan(.99 * 10 ** (-18 / 20));
  expect(metrics.events.some((event) => event.kind === 'off' && Math.abs(event.time - metrics.actual[.29]) < .001)).toBe(false);
});

test('Re-enable with Gate OFF retains an already scheduled next note', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const envelope = new AmplitudeEnvelope(context, { attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .2 });
    const input = context.createConstantSource(); input.start(); input.connect(envelope.node); envelope.node.connect(context.destination);
    envelope.setEnabled(false); envelope.gateOn(.02); envelope.gateOff(.1); envelope.gateOn(.25); envelope.gateOff(.4);
    const suspended = context.suspend(.2), rendering = context.startRendering();
    await suspended; envelope.setEnabled(true); await context.resume();
    const samples = (await rendering).getChannelData(0);
    return [.23, .3, .4, .5, .61].map((t) => samples[Math.round(t * 48000)]);
  });
  expect(values[0]).toBeCloseTo(1e-4, 5);
  expect(values[1]).toBeCloseTo(1, 5);
  expect(values[2]).toBeCloseTo(1, 5);
  expect(values[3]).toBeCloseTo(.01, 5);
  expect(values[4]).toBeCloseTo(1e-4, 5);
});
