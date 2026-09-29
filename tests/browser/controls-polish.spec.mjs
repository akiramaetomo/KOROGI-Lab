import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openTimbreEditors } from './editor-helpers.mjs';

test('Sequence and FEnv Wide sit beside Amount while PEnv Scale is slider-only and survives reload', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  const curveLabel = page.locator('.pitch-scale-choice > span');
  await expect(curveLabel).toBeVisible(); await expect(curveLabel).toHaveText('Pitch curve');
  const sequence = page.locator('[data-numeric-control="sequence-filter-amount"]');
  await expect(sequence.locator('.numeric-heading > *')).toHaveCount(3);
  await expect(sequence.locator('.numeric-heading > *').nth(1)).toHaveAttribute('id', 'sequence-filter-wide');
  await expect(page.locator('#sequence-filter-amount')).toBeHidden();
  await page.locator('#sequence-filter-wide').click();
  await page.locator('#sequence-filter-amount-coarse').evaluate(node => { node.value = '10000'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(sequence.locator('.numeric-value-readout')).toHaveText('7200 cent');

  await openTimbreEditors(page, ['fenv']);
  const fenv = page.locator('[data-numeric-control="fenv-amount"]');
  await expect(fenv.locator('.numeric-heading > *')).toHaveCount(3);
  await expect(fenv.locator('.numeric-heading > *').nth(1)).toHaveAttribute('id', 'fenv-amount-wide');
  await expect(page.locator('#fenv-amount')).toBeHidden();
  await page.locator('#fenv-amount-wide').click();
  await page.locator('#fenv-amount-coarse').evaluate(node => { node.value = '10000'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(fenv.locator('.numeric-value-readout')).toHaveText('7200 cent');

  await openTimbreEditors(page, ['penv']);
  const scale = page.locator('[data-numeric-control="penv-scale"]');
  await expect(page.locator('#penv-scale')).toBeHidden();
  await expect(scale.locator('.numeric-caption')).toHaveText('Scale 0..1');
  for (const [slider, value, label] of [['0', '0', '0'], ['10000', '1', '1'], ['5000', '0.5', '0.5']]) {
    await page.locator('#penv-scale-coarse').evaluate((node, next) => { node.value = next; node.dispatchEvent(new Event('input', { bubbles: true })); }, slider);
    await expect(page.locator('#penv-scale')).toHaveValue(value);
    await expect(scale.locator('.numeric-value-readout')).toHaveText(label);
  }
  await page.locator('#penv-scale-coarse').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.locator('#penv-scale').inputValue()).not.toBe('0.5');
  await page.locator('#penv-scale-coarse').evaluate(node => { node.value = '5000'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.settings.pitchEnvelope.scale).toBe(.5);
  expect(timbre.settings.filterEnvelope).toMatchObject({ amountCent: 7200, amountWide: true });
  expect(timbre.pitchPatterns[0]).toMatchObject({ filterAmountCent: 7200, filterAmountWide: true });
  await page.locator('#timbre-file-1').setInputFiles({ name: 'controls.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#penv-scale')).toHaveValue('0.5');
  await expect(scale.locator('.numeric-value-readout')).toHaveText('0.5');
  await expect(page.locator('#fenv-amount-wide')).toHaveAttribute('aria-pressed', 'true');
});

for (const viewport of [{ width: 1180, height: 820 }, { width: 360, height: 800 }]) {
  test(`Amount headings and PEnv Scale remain readable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
    await page.locator('#trigger-menu').click();
    await expect(page.locator('.pitch-scale-choice > span')).toBeVisible();
    const positions = await page.locator('[data-numeric-control="sequence-filter-amount"]').evaluate(node => {
      const heading = node.querySelector('.numeric-heading');
      return { caption: heading.querySelector('.numeric-caption').getBoundingClientRect(),
        wide: heading.querySelector('.range-wide-toggle').getBoundingClientRect(),
        readout: heading.querySelector('.numeric-value-readout').getBoundingClientRect(),
        slider: node.querySelector('.numeric-slider-axes').getBoundingClientRect() };
    });
    expect(positions.wide.x).toBeGreaterThanOrEqual(positions.caption.right);
    expect(positions.readout.x).toBeGreaterThanOrEqual(positions.wide.right);
    expect(positions.slider.y).toBeGreaterThanOrEqual(positions.readout.bottom);
    await openTimbreEditors(page, ['fenv']);
    const fenv = page.locator('[data-numeric-control="fenv-amount"]');
    await expect(fenv.locator('.numeric-value-readout')).toBeVisible();
    await expect(page.locator('#fenv-amount-coarse')).toBeVisible();
    await openTimbreEditors(page, ['penv']);
    await expect(page.locator('[data-numeric-control="penv-scale"] .numeric-value-readout')).toBeVisible();
    await expect(page.locator('#penv-scale-coarse')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });
}
