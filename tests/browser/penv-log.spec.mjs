import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('PEnv logarithmic ADSR agrees with rendered audio through signed zero and Rate release', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PitchEnvelopeControl } = await import('/src/audio/dsp/PitchEnvelopeControl.ts');
    const context = new OfflineAudioContext(1, 24000, 48000);
    const settings = { mode: 'gate', curve: 'logarithmic', start: -.4, attack: .6,
      sustain: .2, release: -.2, attackSec: .1, decaySec: .1, releaseSec: .1,
      scale: 1, releaseTiming: 'rate' };
    const envelope = new PitchEnvelopeControl(context, settings);
    envelope.output.connect(context.destination);
    envelope.gateOn(0); envelope.gateOff(.2);
    const logical = [.05, .1, .15, .2, .25, .3].map(time => envelope.valueAt(time));
    const audio = (await context.startRendering()).getChannelData(0);
    return { logical, rendered: [.05, .1, .15, .2, .25, .3].map(time => audio[Math.round(time * 48000)]) };
  });
  const midpoint = Math.log1p(4.5) / Math.log(10);
  const expected = [-.4 + midpoint, .6, .6 - .4 * midpoint, .2, .2 - .4 * midpoint, -.2];
  result.logical.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 3));
  result.rendered.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 2));
});

test('PEnv curve choice and FEnv Wide amount survive Timbre save and load', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#flow-penv').click();
  await page.locator('#penv-curve + .segmented-choice [data-value="logarithmic"]').click();
  await page.locator('#flow-fenv').click();
  await page.locator('#fenv-amount-wide').click();
  await page.locator('#fenv-amount-coarse').evaluate(node => { node.value = String(Math.round(7000 / 14400 * 10000 + 5000)); node.dispatchEvent(new Event('input', { bubbles: true })); });
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.settings.pitchEnvelope.curve).toBe('logarithmic');
  expect(timbre.settings.filterEnvelope).toMatchObject({ amountCent: 7000, amountWide: true });
  await page.locator('#timbre-file-1').setInputFiles({ name: 'wide-log.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#fenv-amount-wide')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#penv-curve')).toHaveValue('logarithmic');
  await page.locator('#fenv-amount-wide').click();
  await expect(page.locator('#fenv-amount')).toHaveValue('4800');
});

test('FEnv Wide reaches both signed 7200 cent endpoints in rendered control audio', async ({ page }) => {
  await page.goto('/');
  const values = await page.evaluate(async () => {
    const { FilterEnvelopeControl } = await import('/src/audio/dsp/FilterEnvelopeControl.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const results = [];
    for (const amountCent of [-7200, 7200]) {
      const context = new OfflineAudioContext(1, 9600, 48000);
      const envelope = new FilterEnvelopeControl(context, { ...DEFAULT_CHANNEL_SETTINGS.filterEnvelope,
        amountCent, amountWide: true, attackSec: 0, decaySec: 0, sustain: 1 });
      envelope.output.connect(context.destination); envelope.gateOn(0);
      const logical = envelope.centValueAt(.1);
      const rendered = (await context.startRendering()).getChannelData(0)[4800];
      results.push({ logical, rendered });
    }
    return results;
  });
  expect(values[0].logical).toBeCloseTo(-7200, 4);
  expect(values[0].rendered).toBeCloseTo(-7200, 2);
  expect(values[1].logical).toBeCloseTo(7200, 4);
  expect(values[1].rendered).toBeCloseTo(7200, 2);
});
