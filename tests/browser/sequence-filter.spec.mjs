import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Sequence Filter Wide and a legacy long Portamento survive save; moving its slider adopts the new limit', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  timbre.formatVersion = 'KOROGI-Lab/timbre-v15';
  timbre.pitchPatterns.forEach(item => { delete item.filterAmountWide; });
  delete timbre.settings.pitchEnvelope.curve; delete timbre.settings.filterEnvelope.amountWide;
  timbre.pitchPatterns[0].pitchMode = { kind: 'stepped', stepsPerSide: 4, portamentoSec: 4.5 };
  await page.locator('#timbre-file-1').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await page.locator('#trigger-menu').click();
  await expect(page.locator('.numeric-control[data-numeric-control="sequence-portamento"] .numeric-value-readout')).toHaveText('4500 ms (legacy)');
  await page.locator('#sequence-filter-wide').click();
  const amount = page.locator('#sequence-filter-amount');
  await amount.evaluate(node => { const slider = node.closest('.numeric-control').querySelector('input[type="range"]');
    slider.value = String(10000 * (7000 + 7200) / 14400); slider.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(amount).toHaveValue('7000');
  const savedDownload = page.waitForEvent('download'); await page.locator('#save-1').click();
  const saved = JSON.parse(await readFile(await (await savedDownload).path(), 'utf8'));
  expect(saved.pitchPatterns[0]).toMatchObject({ filterAmountCent: 7000, filterAmountWide: true });
  expect(saved.pitchPatterns[0].pitchMode.portamentoSec).toBe(4.5);
  await page.locator('#sequence-portamento-coarse').evaluate(node => { node.value = '10000'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#sequence-portamento')).toHaveValue('1000');
  await page.locator('#sequence-filter-wide').click();
  await expect(amount).toHaveValue('4800');
});

test('both Filter chains follow independent Sequence Amount with matching rendered frequency response', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const results = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const results = [];
    for (const order of [2, 4]) for (const amount of [-4800, -1200, 0, 1200, 4800]) {
      for (const type of ['lowpass', 'bandpass', 'highpass']) for (const route of ['mod', 'filter1-cutoff']) for (const source of ['sawtooth', 'white-noise']) {
        const render = async reference => {
          const context = new OfflineAudioContext(1, 12000, 48000);
          const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
          settings.osc1.sourceType = source; settings.osc1.baseFrequencyHz = 330;
          settings.osc2.sourceType = 'sawtooth'; settings.osc2.baseFrequencyHz = 220;
          settings.blocksEnabled = { ...settings.blocksEnabled, penv: false, mod: true, osc2: true, filter1: true, filter2: true, fenv: true, aenv: false };
          settings.filterEnvelope = { ...settings.filterEnvelope, amountCent: 600, attackSec: .01, decaySec: .01, sustain: .5 };
          settings.mod.mode = 'am'; settings.mod.amDepth = .5;
          settings.filter2Route = route; settings.filter1CutoffDepthCent = 100;
          for (const key of ['filter1', 'filter2']) settings[key] = { type, order, frequencyHz: 700 * (reference ? 2 ** (amount / 1200) : 1), q: .707 };
          let seed = 7; const random = Math.random;
          Math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
          let channel;
          try { channel = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0); }
          finally { Math.random = random; }
          channel.output.connect(context.destination);
          channel.gateOn(0);
          channel.setSequencePitch(1, 0, reference ? 0 : amount, 0);
          return Array.from((await context.startRendering()).getChannelData(0));
        };
        const actual = await render(false), reference = await render(true);
        let error = 0; for (let i = 2400; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i] - reference[i]));
        results.push({ order, amount, type, route, source, error });
      }
    }
    return results;
  });
  for (const result of results) expect(result.error, JSON.stringify(result)).toBeLessThan(.00002);
});

test('Filter automation holds, resets and cancels future targets together with OSC', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(2, 48000, 48000);
    const channel = new ChannelSynth(context, new WhiteNoiseFactory(context), structuredClone(DEFAULT_CHANNEL_SETTINGS), 0);
    channel.setSequencePitch(1, 1200, -4800, 0, 1);
    const middle = [channel.getSequencePitchCent(.5), channel.getSequenceFilterCent(.5)];
    channel.setSequencePitch(-1, 2400, 4800, .8, .1);
    channel.holdSequencePitch(.5);
    const held = [channel.getSequencePitchCent(.9), channel.getSequenceFilterCent(.9)];
    channel.resetSequencePitch(.6, .1);
    const merger = context.createChannelMerger(2);
    channel.sequencePitch.output.connect(merger, 0, 0); channel.sequenceFilter.output.connect(merger, 0, 1);
    merger.connect(context.destination);
    const rendered = await context.startRendering();
    return { middle, held, reset: [channel.getSequencePitchCent(.9), channel.getSequenceFilterCent(.9)],
      renderedHold: [rendered.getChannelData(0)[26400], rendered.getChannelData(1)[26400]],
      renderedReset: [rendered.getChannelData(0)[43200], rendered.getChannelData(1)[43200]] };
  });
  expect(values).toEqual({ middle: [600, -2400], held: [600, -2400], reset: [0, 0], renderedHold: [600, -2400], renderedReset: [0, 0] });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 360, height: 800 }, { width: 844, height: 390 }]) {
  test(`Filter Amount persists per User and fits Sequence at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
    await page.locator('#trigger-menu').click();
    const amount = page.locator('#sequence-filter-amount'); await expect(amount).toHaveValue('0');
    await amount.evaluate(node => { const slider = node.closest('.numeric-control').querySelector('input[type="range"]');
      slider.value = '3750'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
    const download = page.waitForEvent('download'); await page.locator('#save-1').click();
    const saved = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    expect(saved.pitchPatterns.map(item => item.filterAmountCent)).toEqual([-1200, 0, 0, 0, 0, 0, 0, 0]);
    await page.locator('#pitch-user-2').click(); await expect(amount).toHaveValue('0');
    await page.locator('#pitch-user-1').click(); await expect(amount).toHaveValue('-1200');
    await page.locator('#timbre-file-1').setInputFiles({ name: 'filter.timbre.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
    await expect(amount).toHaveValue('-1200');
    const metrics = await amount.evaluate(node => {
      const control = node.closest('.numeric-control'); const slider = control.querySelector('input[type=range]');
      return { control: control.getBoundingClientRect().width, slider: slider.getBoundingClientRect().width, scroll: document.documentElement.scrollWidth, width: innerWidth };
    });
    expect(metrics.control).toBeGreaterThanOrEqual(140); expect(metrics.slider).toBeGreaterThanOrEqual(75);
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.width + 1);
    await page.locator('#sequence-filter-amount-coarse').scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('filter-amount.png') });
  });
}

test('manual, recorded and live edited Pitch keep both outputs synchronized across User, mute, clear and stop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const original = ChannelSynth.prototype.setSequencePitch;
    ChannelSynth.prototype.setSequencePitch = function (...args) { window.__sequenceSynth = this; return original.apply(this, args); };
    const controller = ChannelSynth.prototype.setControllerPitch;
    ChannelSynth.prototype.setControllerPitch = function (...args) { window.__sequenceSynth = this; return controller.apply(this, args); };
  });
  await page.locator('#trigger-menu').click();
  const number = async (selector, value) => {
    if (selector === '#sequence-filter-amount' || selector === '#sequence-pitch-steps' || selector === '#sequence-portamento') {
      await page.locator(selector).evaluate((node, target) => {
        const slider = node.closest('.numeric-control').querySelector('input[type="range"]');
        const min = Number(node.dataset.sliderMin ?? node.dataset.numericMin), max = Number(node.dataset.sliderMax ?? node.dataset.numericMax);
        const position = node.dataset.numericScale === 'log1p' ? Math.log1p(target) / Math.log1p(max) : (target - min) / (max - min);
        slider.value = String(position * 10000); slider.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    } else { await page.locator(selector).fill(String(value)); await page.locator(selector).dispatchEvent('change'); }
  };
  const output = () => page.evaluate(() => { const s = window.__sequenceSynth; return [s.getSequencePitchCent(), s.getSequenceFilterCent()]; });
  const initial = await page.evaluate(async () => {
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const timbre = defaultTimbre(); timbre.pitchPatterns[0].pitchScaleCent = 0; return timbre;
  });
  await page.locator('#timbre-file-1').setInputFiles({ name: 'zero-scale.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initial)) });
  await page.locator('#trigger-menu').click();
  await number('#sequence-filter-amount', 1200);
  await page.locator('#sequence-pitch-input').evaluate(node => { node.value = '1'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(output).toEqual([0, 1200]);
  await page.locator('#sequence-pitch-center').click(); await expect.poll(output).toEqual([0, 0]);
  await page.locator('#sequence-pitch-mode').selectOption('equal');
  await number('#sequence-pitch-steps', 2); await number('#sequence-portamento', 50);
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await number('#record-length', 1); await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording');
  await page.locator('#sequence-pitch-input').evaluate(node => { node.value = '.37'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(output).toEqual([0, 600]);
  await page.locator('#record-toggle').click();
  await number('#sequence-pitch-steps', 0);
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const saved = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(saved.pitchPatterns[0].recording.points.some(item => item.valueNormalized === .5)).toBe(true);
  for (const [index, amount] of [[0, 1200], [1, -2400]]) {
    saved.pitchPatterns[index].filterAmountCent = amount;
    saved.pitchPatterns[index].pitchScaleCent = 0;
    saved.pitchPatterns[index].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2, points: [{ timeSec: 0, valueNormalized: 1 }, { timeSec: .2, valueNormalized: 1 }] };
  }
  await page.locator('#timbre-file-1').setInputFiles({ name: 'loop.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await page.locator('#sequence-panel').click(); await expect.poll(output).toEqual([0, 1200]);
  await number('#sequence-filter-amount', 2400); await expect.poll(output).toEqual([0, 2400]);
  await number('#sequence-play-speed', 2); await expect.poll(output).toEqual([0, 2400]);
  await page.locator('#pitch-user-2').click(); await expect.poll(output).toEqual([0, -2400]);
  await page.locator('#pitch-mute').click(); await expect.poll(output).toEqual([0, 0]);
  await page.locator('#pitch-mute').click(); await expect.poll(output).toEqual([0, -2400]);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#pitch-clear').click(); await expect.poll(output).toEqual([0, 0]);
  await page.locator('#pitch-user-1').click(); await expect.poll(output).toEqual([0, 2400]);
  await page.locator('#sequence-panel').click(); await expect.poll(output).toEqual([0, 0]);
});
