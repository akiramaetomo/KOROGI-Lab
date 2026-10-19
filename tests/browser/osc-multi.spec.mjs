import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openTimbreEditors } from './editor-helpers.mjs';

const TABLE = `| OSC | Frequency (Hz) | Amplitude |
|---|---|---|
| 1 | 246 | 0.167 |
| 2 | 308 | 0.167 |
| 3 | 367 | 0.167 |
| 4 | 418 | 0.167 |
| 5 | 440 | 0.167 |
| 6 | 627 | 0.167 |`;
const HZ = [246, 308, 367, 418, 440, 627];

test('Multi sums partials at Base x ratio, and Base, cent signals and PEnv move all of them by the same ratio', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async hz => {
    const { SourceUnit } = await import('/src/audio/dsp/SourceUnit.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const rate = 48000;
    // Amplitude of a sine at f over [start, start + seconds): exact for whole cycles in the window.
    const amplitude = (data, f, start, seconds) => {
      let re = 0, im = 0; const from = Math.round(start * rate), n = Math.round(seconds * rate);
      for (let i = 0; i < n; i += 1) { const w = 2 * Math.PI * f * (from + i) / rate; re += data[from + i] * Math.cos(w); im += data[from + i] * Math.sin(w); }
      return 2 * Math.hypot(re, im) / n;
    };
    const render = async ({ base = 440, cent = 0, pEnv = 0, type = 'sine' }) => {
      const context = new OfflineAudioContext(1, rate * 2.5, rate);
      const shape = context.createConstantSource(); shape.offset.value = pEnv; shape.start();
      const detune = context.createConstantSource(); detune.offset.value = cent; detune.start();
      const unit = new SourceUnit(context, new WhiteNoiseFactory(context), shape, type, base, [detune], .5,
        hz.map(f => ({ ratio: f / 440, amplitude: .1 })));
      unit.output.connect(context.destination);
      return (await context.startRendering()).getChannelData(0);
    };
    const peaks = (data, scale) => hz.map(f => amplitude(data, f * scale, .25, 2));
    const plain = await render({});
    return {
      plain: peaks(plain, 1), between: amplitude(plain, 280, .25, 2),
      peak: Math.max(...plain.map(Math.abs)),
      base: peaks(await render({ base: 880 }), 2),
      cent: peaks(await render({ cent: 1200 }), 2),
      pEnv: peaks(await render({ pEnv: .5 }), 1.5)
    };
  }, HZ);
  for (const set of [result.plain, result.base, result.cent, result.pEnv])
    for (const value of set) expect(value).toBeCloseTo(.1, 3);
  expect(result.between).toBeLessThan(1e-3);
  expect(result.peak).toBeLessThanOrEqual(.6 + 1e-6);
});

test('Single keeps one oscillator per OSC and Multi restarts every partial together on SYNC', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000); const starts = [];
    const create = context.createOscillator.bind(context);
    context.createOscillator = () => {
      const node = create(); const start = node.start.bind(node);
      node.start = time => { starts.push(time ?? 0); start(time); };
      return node;
    };
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    const single = starts.length;
    starts.length = 0;
    await synth.setOscVoices(1, 'multi', { ...settings.osc1.multi, definition: 'spread', spread: { count: 3, spreadCent: 10 } });
    const multi = starts.length;
    starts.length = 0;
    synth.gateOn(.2);
    const sync = [...starts];
    starts.length = 0;
    // Same count: ratios and amplitudes glide without new oscillators.
    await synth.setOscVoices(1, 'multi', { ...settings.osc1.multi, definition: 'spread', spread: { count: 3, spreadCent: 40 } });
    const glide = starts.length;
    await synth.setOscVoices(1, 'single', synth.getSettings().osc1.multi);
    const back = synth.getSettings().osc1;
    synth.dispose();
    return { single, multi, sync, glide, back: back.voiceMode, kept: back.multi.spread };
  });
  expect(result.single).toBe(2);
  expect(result.multi).toBe(3);
  expect(result.sync).toEqual([.2, .2, .2, .2]);
  expect(result.glide).toBe(0);
  expect(result.back).toBe('single');
  expect(result.kept).toEqual({ count: 3, spreadCent: 40 });
});

async function start(page) {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
}

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

test('OSC card switches Single/Multi, pastes and edits a Table, and saves and reloads it', async ({ page }) => {
  await start(page);
  await openTimbreEditors(page, ['osc1']);
  const card = page.locator('[data-editor-card="osc1"]');
  await expect(page.locator('#osc1-multi')).toBeHidden();
  await card.getByRole('radio', { name: 'Multi' }).click();
  await expect(page.locator('#osc1-multi')).toBeVisible();
  await expect(page.locator('#osc1-multi-status')).toHaveText('7 oscillators of sine.');
  await card.getByRole('radio', { name: 'Table' }).click();
  await page.locator('#osc1-multi-paste').fill(TABLE);
  await page.locator('#osc1-multi-apply-paste').click();
  await expect(page.locator('#osc1-multi-rows .multi-row')).toHaveCount(6);
  await expect(page.locator('#osc1-multi-hz-6')).toHaveValue('627');
  await expect(page.locator('#osc1-multi-sum')).toHaveText('ΣA 1.002');
  await expect(page.locator('#osc1-multi-sum')).toHaveClass(/warning/);
  await page.locator('#osc1-multi-normalize').click();
  await expect(page.locator('#osc1-multi-sum')).toHaveText('ΣA 1.000');
  await expect(page.locator('#osc1-multi-sum')).not.toHaveClass(/warning/);
  await page.locator('#osc1-multi-hz-1').fill('220');
  await page.locator('#osc1-multi-hz-1').dispatchEvent('change');
  await page.getByRole('button', { name: 'Remove OSC1 Multi 6' }).click();
  await expect(page.locator('#osc1-multi-rows .multi-row')).toHaveCount(5);
  // Base keeps the ratios: doubling it doubles every row.
  await page.locator('#osc1-frequency').fill('880');
  await page.locator('#osc1-frequency').dispatchEvent('change');
  await expect(page.locator('#osc1-multi-hz-1')).toHaveValue('440');
  await expect(page.locator('#osc1-multi-hz-5')).toHaveValue('880');
  await page.locator('#osc1-multi-paste').fill('100 abc');
  await page.locator('#osc1-multi-apply-paste').click();
  await expect(page.locator('#osc1-multi-status')).toContainText('Row 1');
  await expect(page.locator('#osc1-multi-status')).toHaveClass(/warning/);
  await expect(page.locator('#osc1-multi-rows .multi-row')).toHaveCount(5);

  const timbre = await saveTimbre(page);
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v20');
  expect(timbre.settings.osc1.voiceMode).toBe('multi');
  expect(timbre.settings.osc1.multi.definition).toBe('table');
  expect(timbre.settings.osc1.multi.partials.map(item => item.ratio * 440)).toEqual([220, 308, 367, 418, 440].map(hz => expect.closeTo(hz, 6)));
  expect(timbre.settings.osc2.voiceMode).toBe('single');

  await card.getByRole('radio', { name: 'Single' }).click();
  await expect(page.locator('#osc1-multi')).toBeHidden();
  await page.locator('#timbre-file-1').setInputFiles({ name: 'multi.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  await expect(page.locator('#osc1-multi')).toBeVisible();
  await expect(page.locator('#osc1-multi-rows .multi-row')).toHaveCount(5);
  await expect(page.locator('#osc1-multi-hz-2')).toHaveValue('616');
});
