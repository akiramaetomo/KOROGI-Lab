import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('PEnv percent interpolation and Time/Rate follow the strong and weak reference', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const rate = 48000;
    const render = async (off, timing, mode = 'gate') => {
      const context = new OfflineAudioContext(1, rate, rate);
      const settings = { mode, start: 0, attack: .05, sustain: 0, release: -.05,
        attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: timing };
      const env = new PitchEnvelopeControl(context, settings);
      env.output.connect(context.destination);
      env.gateOn(.1); env.gateOff(.1 + off);
      const data = (await context.startRendering()).getChannelData(0);
      return { logical: [.1, .115, .13, .145, .16, .17].map(t => env.valueAt(t)),
        audio: [.115, .13, .145, .16].map(t => data[Math.round(t * rate)]) };
    };
    return { strongRate: await render(.03, 'rate'), strongTime: await render(.03, 'time'),
      weakRate: await render(.015, 'rate'), weakTime: await render(.015, 'time'),
      longRate: await render(.04, 'rate'), longTime: await render(.04, 'time'),
      shotRate: await render(.015, 'rate', 'one-shot'), shotTime: await render(.015, 'time', 'one-shot') };
  });
  const close = (actual, expected) => expect(actual).toBeCloseTo(expected, 4);
  close(values.strongRate.logical[0], .05);
  close(values.strongRate.logical[1], .025);
  close(values.strongRate.logical[4], -.05);
  close(values.strongTime.logical[1], .025);
  close(values.strongTime.logical[4], -.05);
  close(4000 * (1 + values.strongTime.logical[1]), 4100);
  close(values.weakRate.logical[1], .025);
  close(values.weakRate.logical[2], 0);
  close(values.weakRate.logical[4], -.05);
  close(values.weakTime.logical[2], -.0125);
  close(values.weakTime.logical[3], -.05);
  close(values.weakRate.audio[0], .025);
  close(values.weakRate.audio[1], 0);
  close(values.longRate.logical[5], -.05);
  close(values.longTime.logical[5], -.05);
  close(values.longRate.logical[4], -.033333);
  close(values.longTime.logical[4], -.033333);
  close(values.shotRate.logical[4], -.05);
  close(values.shotTime.logical[4], -.05);
  close(values.shotRate.logical[3], -.025);
  close(values.shotTime.logical[3], -.025);
});

test('PEnv One-shot ignores early OFF, retrigger starts at P0, and zero durations stay finite', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const settings = { mode: 'one-shot', start: -.1, attack: .2, sustain: .1, release: -.2,
      attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'time' };
    const env = new PitchEnvelopeControl(context, settings);
    env.output.connect(context.destination);
    env.gateOn(.1, settings); env.gateOff(.11);
    env.gateOn(.2, { ...settings, attackSec: 0, decaySec: 0, releaseSec: 0 });
    const data = (await context.startRendering()).getChannelData(0);
    return { beforeOff: env.valueAt(.11), afterOff: env.valueAt(.12), end: env.valueAt(.16),
      zero: env.valueAt(.2), finite: data.every(Number.isFinite) };
  });
  expect(values.beforeOff).toBeCloseTo(.16667, 3);
  expect(values.afterOff).toBeCloseTo(.13333, 3);
  expect(values.end).toBeCloseTo(-.2, 4);
  expect(values.zero).toBeCloseTo(-.2, 4);
  expect(values.finite).toBe(true);
});

test('AEnv Rate shortens weak Gate Release and accepts zero time', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const render = async (off, timing) => {
      const rate = 48000;
      const context = new OfflineAudioContext(1, rate, rate);
      const env = new AmplitudeEnvelope(context, { attackSec: .03, decaySec: 0, sustain: 1, releaseSec: .03,
        attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: timing, mode: 'gate' });
      const source = context.createConstantSource(); source.connect(env.node); env.node.connect(context.destination); source.start();
      env.gateOn(.1); env.gateOff(.1 + off);
      const data = (await context.startRendering()).getChannelData(0);
      return [.115, .13, .145, .16].map(t => data[Math.round(t * rate)]);
    };
    return { weakRate: await render(.015, 'rate'), weakTime: await render(.015, 'time'), strongRate: await render(.03, 'rate') };
  });
  expect(values.weakRate[0]).toBeCloseTo(.50005, 3);
  expect(values.weakRate[1]).toBeCloseTo(.0001, 3);
  expect(values.weakTime[1]).toBeCloseTo(.250075, 3);
  expect(values.strongRate[3]).toBeCloseTo(.0001, 3);
});

test('PEnv controls and Release choices survive Timbre save and load', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#flow-penv').click();
  await expect(page.locator('[data-numeric-control="penv-attack-time"] .slider-scale span').nth(1)).toHaveText('70 ms');
  for (const [id, value] of [['penv-start', '2'], ['penv-attack-level', '5'], ['penv-sustain-level', '0'],
    ['penv-release-level', '-5'], ['penv-attack-time', '0'], ['penv-decay-time', '30'],
    ['penv-release-time', '30'], ['penv-scale', '0.75']]) {
    if (id === 'penv-scale') await page.locator('#penv-scale-coarse').evaluate(node => { node.value = '7500'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    else { await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).dispatchEvent('change'); }
  }
  await page.locator('#penv-release-timing + .segmented-choice [data-value="rate"]').click();
  await page.locator('#flow-aenv').click();
  await expect(page.locator('[data-numeric-control="release"] .slider-scale span').nth(1)).toHaveText('70 ms');
  await page.locator('#aenv-release-timing + .segmented-choice [data-value="rate"]').click();
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v16');
  expect(timbre.settings.pitchEnvelope).toEqual({ mode: 'gate', start: .02, attack: .05, sustain: 0, release: -.05,
    attackSec: 0, decaySec: .03, releaseSec: .03, scale: .75, releaseTiming: 'rate', curve: 'linear' });
  expect(timbre.settings.ampEnvelope).toMatchObject({ releaseCurve: 'linear', releaseTiming: 'rate' });
  await page.locator('#timbre-file-1').setInputFiles({ name: 'envelope.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1');
  await page.locator('#flow-penv').click();
  await expect(page.locator('#penv-scale')).toHaveValue('0.75');
  await expect(page.locator('#penv-release-timing')).toHaveValue('rate');
});

test('PEnv mode button applies to the next note and survives save and reload independently of AEnv', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#flow-penv').click();
  await page.locator('#penv-mode + .segmented-choice [data-value="one-shot"]').click();
  await expect(page.locator('#penv-mode')).toHaveValue('one-shot');
  await expect(page.locator('#penv-mode + .segmented-choice [data-value="one-shot"]')).toHaveAttribute('aria-checked', 'true');
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.settings.pitchEnvelope.mode).toBe('one-shot');
  expect(timbre.settings.ampEnvelope.mode).toBe('gate');
  await page.locator('#timbre-file-1').setInputFiles({ name: 'independent.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#penv-mode')).toHaveValue('one-shot');
  const result = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const base = { mode: 'gate', start: 0, attack: .05, sustain: 0, release: -.05,
      attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'time' };
    const env = new PitchEnvelopeControl(context, base);
    env.gateOn(.1, base);
    env.setSettings({ ...base, mode: 'one-shot' });
    env.gateOff(.115);
    const first = env.valueAt(.14);
    env.gateOn(.2); env.gateOff(.215);
    return { first, second: env.valueAt(.24) };
  });
  expect(result.first).toBeCloseTo(-.0375, 4);
  expect(result.second).toBeCloseTo(-.016667, 4);
});

test('all four AEnv/PEnv mode combinations deliver OFF only to Gate envelopes', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const output = [];
    for (const ampMode of ['gate', 'one-shot']) for (const pitchMode of ['gate', 'one-shot']) {
      const rate = 48000, context = new OfflineAudioContext(1, rate, rate);
      const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
      settings.blocksEnabled.osc1 = false; settings.blocksEnabled.osc2 = false;
      settings.ampEnvelope = { mode: ampMode, attackSec: 0, decaySec: .03, sustain: .5,
        releaseSec: .03, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: 'time' };
      settings.pitchEnvelope = { mode: pitchMode, start: 0, attack: .05, sustain: 0, release: -.05,
        attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'time' };
      const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
      const source = context.createConstantSource(); source.connect(synth.ampEnvelope.node);
      synth.ampEnvelope.node.connect(context.destination); source.start();
      synth.gateOn(.1); synth.gateOff(.115);
      const rendered = await context.startRendering();
      output.push({ ampMode, pitchMode, pitchAt140: synth.pEnv.valueAt(.14), ampLogicalAt140: synth.ampEnvelope.valueAt(.14),
        ampAt140: rendered.getChannelData(0)[Math.round(.14 * rate)] });
    }
    return output;
  });
  for (const item of results) {
    expect(item.pitchAt140).toBeCloseTo(item.pitchMode === 'gate' ? -.0375 : -.016667, 4);
    expect(item.ampAt140).toBeCloseTo(item.ampLogicalAt140, 3);
  }
  expect(results).toHaveLength(4);
});

test('Auto delivers Ton OFF to PEnv Gate even when AEnv is One-shot', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.ampEnvelope.mode = 'one-shot';
    settings.pitchEnvelope = { mode: 'gate', start: 0, attack: .05, sustain: 0, release: -.05,
      attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'time' };
    settings.autoTrigger = { tonSec: .015, repeatSec: .1 };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    let tick;
    const oldInterval = globalThis.setInterval, oldClear = globalThis.clearInterval;
    globalThis.setInterval = callback => { tick = callback; return 123; };
    globalThis.clearInterval = () => {};
    try { synth.startAutoTrigger(.1); } finally { globalThis.setInterval = oldInterval; globalThis.clearInterval = oldClear; }
    const pause = context.suspend(.02), rendering = context.startRendering();
    await pause; tick(); await context.resume();
    await rendering;
    return { at115: synth.pEnv.valueAt(.115), at130: synth.pEnv.valueAt(.13), at145: synth.pEnv.valueAt(.145) };
  });
  expect(result.at115).toBeCloseTo(.025, 4);
  expect(result.at130).toBeCloseTo(-.0125, 4);
  expect(result.at145).toBeCloseTo(-.05, 4);
});

test('BURST PEnv Gate releases at the pulse AEnv floor and a later pulse supersedes its OFF', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.ampEnvelope = { mode: 'one-shot', attackSec: 0, decaySec: .01, sustain: .5,
      releaseSec: .01, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: 'time' };
    settings.pitchEnvelope = { mode: 'gate', start: 0, attack: .05, sustain: .02, release: -.05,
      attackSec: 0, decaySec: .01, releaseSec: .01, scale: 1, releaseTiming: 'time' };
    settings.burst = { enabled: true, pulseCountMin: 2, pulseCountMax: 2,
      pulseIntervalSec: .025, pulseIntervalJitter: 0, groupPeriodSec: .1, groupPeriodJitter: 0 };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.gateOn(.1); synth.gateOff(.115);
    return [.119, .125, .13, .145, .15, .16].map(t => synth.pEnv.valueAt(t));
  });
  expect(values[0]).toBeCloseTo(.02, 4);
  expect(values[1]).toBeCloseTo(.05, 4);
  expect(values[2]).toBeCloseTo(.035, 4);
  expect(values[3]).toBeCloseTo(.02, 4);
  expect(values[4]).toBeCloseTo(-.015, 4);
  expect(values[5]).toBeCloseTo(-.05, 4);
});

test('OSC frequency follows percent PEnv and limits the nonpositive endpoint', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const { SourceUnit } = await import('/src/audio/dsp/SourceUnit.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const render = async (level, scale, baseFrequency = 4000) => {
      const rate = 48000;
      const context = new OfflineAudioContext(1, rate / 2, rate);
      const settings = { start: level, attack: level, sustain: level, release: level,
        attackSec: 0, decaySec: 0, releaseSec: 0, scale, releaseTiming: 'time' };
      const env = new PitchEnvelopeControl(context, settings);
      const source = new SourceUnit(context, new WhiteNoiseFactory(context), env.output, 'sine', baseFrequency);
      source.output.connect(context.destination);
      env.gateOn(.1);
      const data = (await context.startRendering()).getChannelData(0);
      const crossings = (a, b) => {
        let count = 0;
        for (let i = Math.round(a * rate) + 1; i < Math.round(b * rate); i++) if (data[i - 1] < 0 && data[i] >= 0) count++;
        return count;
      };
      return { crossings: crossings(.2, .21), sample: data[Math.round(.3 * rate)], finite: data.every(Number.isFinite) };
    };
    return { neutral: await render(1, 0), doubled: await render(1, 1), floor: await render(-1, 1),
      aboveNyquist: await render(1, 1, 20000) };
  });
  expect(result.neutral.crossings).toBeGreaterThanOrEqual(39);
  expect(result.neutral.crossings).toBeLessThanOrEqual(41);
  expect(result.doubled.crossings).toBeGreaterThanOrEqual(79);
  expect(result.doubled.crossings).toBeLessThanOrEqual(81);
  expect(result.floor.sample).toBeCloseTo(Math.sin(2 * Math.PI * .1 * .2), 2);
  expect(result.floor.finite).toBe(true);
  expect(result.aboveNyquist.finite).toBe(true);
});

test('Rate fallback, scale snapshot, and future cancellation preserve the current PEnv', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const settings = { start: .05, attack: .05, sustain: 0, release: 0,
      attackSec: 0, decaySec: .03, releaseSec: .03, scale: .5, releaseTiming: 'rate' };
    const env = new PitchEnvelopeControl(context, settings);
    env.output.connect(context.destination);
    env.gateOn(.1); env.gateOn(.5, { ...settings, scale: 1 });
    env.preserveCurrent(.12); env.gateOff(.12);
    const data = (await context.startRendering()).getChannelData(0);
    return { atOff: env.valueAt(.12), atEnd: env.valueAt(.15), beforeFuture: data[Math.round(.4 * 48000)],
      afterFuture: data[Math.round(.51 * 48000)] };
  });
  expect(values.atOff).toBeCloseTo(.016667, 4);
  expect(values.atEnd).toBeCloseTo(0, 4);
  expect(values.beforeFuture).toBeCloseTo(0, 4);
  expect(values.afterFuture).toBeCloseTo(0, 4);
});

test('AEnv zero Attack, Decay and Release terminate Gate and One-shot safely', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const render = async mode => {
      const rate = 48000, context = new OfflineAudioContext(1, rate / 2, rate);
      const env = new AmplitudeEnvelope(context, { attackSec: 0, decaySec: 0, sustain: 1, releaseSec: 0,
        attackCurve: 'exponential', decayCurve: 'exponential', releaseCurve: 'exponential', mode });
      const source = context.createConstantSource(); source.connect(env.node); env.node.connect(context.destination); source.start();
      env.gateOn(.1); env.gateOff(.12);
      const data = (await context.startRendering()).getChannelData(0);
      return { on: data[Math.round(.11 * rate)], off: data[Math.round(.13 * rate)], finite: data.every(Number.isFinite) };
    };
    return { gate: await render('gate'), oneShot: await render('one-shot') };
  });
  expect(values.gate.on).toBeCloseTo(1, 3);
  expect(values.gate.off).toBeCloseTo(.0001, 3);
  expect(values.oneShot.on).toBeCloseTo(.0001, 3);
  expect(values.gate.finite && values.oneShot.finite).toBe(true);
});

test('BURST starts a new PEnv One-shot per pulse and display OFF does not release pitch', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.ampEnvelope.mode = 'one-shot';
    settings.burst = { enabled: true, pulseCountMin: 3, pulseCountMax: 3,
      pulseIntervalSec: .025, pulseIntervalJitter: 0, groupPeriodSec: .1, groupPeriodJitter: 0 };
    settings.pitchEnvelope = { mode: 'one-shot', start: 0, attack: .05, sustain: 0, release: -.05,
      attackSec: 0, decaySec: .01, releaseSec: .01, scale: 1, releaseTiming: 'time' };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.gateOn(.02); synth.gateOff(.085);
    return [.02, .03, .036, .045, .055, .07, .08].map(t => synth.pEnv.valueAt(t));
  });
  expect(values[0]).toBeCloseTo(.05, 4);
  expect(values[1]).toBeCloseTo(0, 4);
  expect(values[2]).toBeCloseTo(-.03, 4);
  expect(values[3]).toBeCloseTo(.05, 4);
  expect(values[4]).toBeCloseTo(0, 4);
  expect(values[5]).toBeCloseTo(.05, 4);
  expect(values[6]).toBeCloseTo(0, 4);
});

test('Trigger release does not release PEnv while the base Gate remains held', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const rate = 48000, context = new OfflineAudioContext(1, rate, rate);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.pitchEnvelope = { start: .05, attack: .05, sustain: .05, release: -.05,
      attackSec: 0, decaySec: 0, releaseSec: .05, scale: 1, releaseTiming: 'time' };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.output.connect(context.destination); synth.gateOn(.1);
    const actions = [[.11, null], [.12, () => synth.triggerGateOn()], [.13, () => synth.triggerGateOff()],
      [.145, null], [.16, () => synth.gateOff()], [.185, null], [.21, null]];
    const suspensions = actions.map(([time]) => context.suspend(time));
    const rendering = context.startRendering();
    const values = [];
    for (let index = 0; index < actions.length; index++) {
      await suspensions[index]; actions[index][1]?.();
      if ([0, 3, 4, 5, 6].includes(index)) values.push(synth.pEnv.valueAt(context.currentTime));
      await context.resume();
    }
    await rendering;
    return values;
  });
  expect(values[0]).toBeCloseTo(.05, 4);
  expect(values[1]).toBeCloseTo(.05, 4);
  expect(values[2]).toBeCloseTo(.05, 4);
  expect(values[3]).toBeGreaterThan(-.02);
  expect(values[3]).toBeLessThan(.02);
  expect(values[4]).toBeCloseTo(-.05, 4);
});

test('PEnv Rate treats a decimal 0.1-point baseline as Rate', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    return [.0999, .1, .1001, -.0999, -.1, -.1001].map(delta => {
      const context = new OfflineAudioContext(1, 48000, 48000 * 2);
      const settings = { mode: 'gate', start: .1, attack: .1, sustain: .05 + delta / 100,
        release: .05, attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'rate' };
      const env = new PitchEnvelopeControl(context, settings);
      env.gateOn(.1); env.gateOff(.1);
      return { delta, at130: env.valueAt(.13), at1600: env.valueAt(1.6) };
    });
  });
  expect(result[0].at130).toBeCloseTo(.05, 5);
  expect(result[1].at130).toBeGreaterThan(.098);
  expect(result[1].at1600).toBeCloseTo(.05, 5);
  expect(result[2].at130).toBeGreaterThan(.098);
  expect(result[3].at130).toBeCloseTo(.05, 5);
  expect(result[4].at130).toBeGreaterThan(.098);
  expect(result[5].at130).toBeGreaterThan(.098);
});

test('canceling an overlapping future PEnv and AEnv note restores the current One-shot tail', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const { AmplitudeEnvelope } = await import('/src/audio/dsp/AmplitudeEnvelope.ts');
    const rate = 48000, context = new OfflineAudioContext(2, rate, rate);
    const pitch = { mode: 'one-shot', start: 0, attack: .05, sustain: 0, release: -.05,
      attackSec: 0, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'time' };
    const amp = { attackSec: 0, decaySec: .03, sustain: .5, releaseSec: .03,
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: 'time', mode: 'one-shot' };
    const p = new PitchEnvelopeControl(context, pitch), a = new AmplitudeEnvelope(context, amp);
    const merger = context.createChannelMerger(2);
    p.output.connect(merger, 0, 0);
    const source = context.createConstantSource(); source.connect(a.node); a.node.connect(merger, 0, 1); source.start();
    merger.connect(context.destination);
    p.gateOn(.1, pitch); a.gateOn(.1);
    p.gateOn(.125, pitch); a.gateOn(.125);
    p.preserveCurrent(.12); a.preserveCurrent(.12);
    const rendered = await context.startRendering();
    return { pitchAt160: p.valueAt(.16), ampAt160: a.valueAt(.16),
      pitchSignalAt160: rendered.getChannelData(0)[Math.round(.16 * rate)],
      ampSignalAt160: rendered.getChannelData(1)[Math.round(.16 * rate)] };
  });
  expect(result.pitchAt160).toBeCloseTo(-.05, 5);
  expect(result.ampAt160).toBeCloseTo(.0001, 5);
  expect(result.pitchSignalAt160).toBeCloseTo(-.05, 5);
  expect(result.ampSignalAt160).toBeCloseTo(.0001, 5);
});

test('releasing only Trigger during nonzero PEnv Attack preserves Decay under a held base Gate', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.pitchEnvelope = { start: 0, attack: .05, sustain: 0, release: -.05,
      attackSec: .03, decaySec: .03, releaseSec: .03, scale: 1, releaseTiming: 'time' };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.gateOn(.1);
    const actions = [[.2, () => synth.triggerGateOn()], [.21, () => synth.triggerGateOff()]];
    const suspensions = actions.map(([time]) => context.suspend(time));
    const rendering = context.startRendering();
    for (let index = 0; index < actions.length; index++) {
      await suspensions[index]; actions[index][1](); await context.resume();
    }
    await rendering;
    return { at230: synth.pEnv.valueAt(.23), at260: synth.pEnv.valueAt(.26) };
  });
  expect(result.at230).toBeCloseTo(.05, 3);
  expect(result.at260).toBeCloseTo(0, 3);
});
