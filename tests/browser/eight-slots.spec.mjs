import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Eight compact slots expose TRG, Play and Level while one detail panel opens at a time', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(page.locator('.mixer-slot')).toHaveCount(8);
  for (const id of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    for (const control of ['select', 'gate', 'play', 'level']) await expect(page.locator(`#${control}-${id}`)).toBeVisible();
  }
  await expect(page.locator('#slot-details-1')).toBeVisible();
  expect(await page.locator('#select-1').innerText()).toBe('1. Standard');
  await expect(page.locator('#expand-1')).toHaveCount(0);
  await expect(page.locator('#gate-1')).toHaveText('TRG');
  await expect(page.locator('#play-1')).toHaveAttribute('aria-label', 'Play timbre 1');
  const headingOrder = await page.locator('[data-slot="1"] .slot-heading > button').evaluateAll(buttons => buttons.map(button => button.id));
  expect(headingOrder).toEqual(['select-1', 'play-1', 'gate-1']);
  await page.locator('#select-6').click();
  await expect(page.locator('#slot-details-1')).toBeHidden();
  await expect(page.locator('#slot-details-6')).toBeVisible();
  await expect(page.locator('#select-6')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-input-page="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#flow-input-6')).toHaveClass(/selected/);
  await expect(page.locator('[data-input-page="1"]')).toHaveAttribute('data-has-selected', 'true');
  await expect(page.locator('path[data-from^="input-"]')).toHaveCount(8);
  await expect(page.locator('path[data-from="input-6"]')).toHaveCount(2);
  await expect(page.locator('path[data-from="input-1"]')).toHaveCount(0);
  expect(await page.locator('path[data-from="input-5"][data-to="near-input"]').getAttribute('d')).not.toContain(' V ');
  expect(await page.locator('path[data-from="input-8"][data-to="far-input"]').getAttribute('d')).not.toContain(' V ');
  await page.screenshot({ path: testInfo.outputPath('eight-slots-second-page-1024x768.png') });
  await page.locator('#select-6').click();
  await expect(page.locator('#slot-details-6')).toBeHidden();
  await expect(page.locator('#select-6')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#select-6')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('[data-input-page="0"]').click();
  await expect(page.locator('path[data-from="input-1"]')).toHaveCount(2);
  await expect(page.locator('#select-6')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-input-page="0"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-input-page="1"]')).toHaveAttribute('data-has-selected', 'true');
  await expect(page.locator('#flow-input-6')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('eight-slots-1024x768.png') });
});

test('Slots 5 to 8 play together, accept digit Gates and round-trip individual timbres and Sessions', async ({ page }) => {
  await page.goto('/');
  for (const id of ['5', '6', '7', '8']) {
    await page.locator(`#select-${id}`).click();
    await page.locator(`#standard-${id}`).click();
  }
  await page.locator('#name-8').fill('Eighth');
  await page.locator('#name-8').dispatchEvent('change');
  await page.locator('#level-8').evaluate(input => { input.value = '-12'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const timbreDownload = page.waitForEvent('download');
  await page.locator('#save-8').click();
  const timbre = JSON.parse(await readFile(await (await timbreDownload).path(), 'utf8'));
  expect(timbre.name).toBe('Eighth');
  await page.locator('#timbre-file-7').setInputFiles({ name: 'eighth.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#select-7')).toContainText('Eighth');
  await page.locator('#play-all').click();
  for (const id of ['1', '5', '6', '7', '8']) await expect(page.locator(`#play-${id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-8')).toHaveAttribute('aria-label', 'Stop timbre 8');
  await page.locator('#play-all').click();
  await page.locator('#select-8').focus();
  await page.keyboard.down('5'); await page.keyboard.down('8');
  for (const id of ['5', '8']) await expect(page.locator(`#gate-${id}`)).toHaveClass(/on/);
  await page.keyboard.up('5'); await page.keyboard.up('8');
  for (const id of ['5', '8']) await expect(page.locator(`#gate-${id}`)).not.toHaveClass(/on/);
  await page.locator('[data-panel-target="patch"]').first().click();
  const sessionDownload = page.waitForEvent('download');
  await page.locator('#export-patch').click();
  const session = JSON.parse(await readFile(await (await sessionDownload).path(), 'utf8'));
  expect(session.formatVersion).toBe('KOROGI-Lab/session-v8');
  expect(session.channels).toHaveLength(8);
  expect(session.channels[7]).toMatchObject({ id: '8', gainDb: -12, timbre: { name: 'Eighth' } });
  await page.locator('#patch-file').setInputFiles({ name: 'eight.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await expect(page.locator('#select-8')).toContainText('Eighth');
  const oldFour = { ...session, channels: session.channels.slice(0, 4) };
  await page.locator('#patch-file').setInputFiles({ name: 'four.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(oldFour)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  for (const id of ['5', '6', '7', '8']) {
    await expect(page.locator(`#select-${id}`)).toContainText('Empty');
    await expect(page.locator(`#play-${id}`)).toBeDisabled();
  }
});

test('Eight stereo sends add without changing the four-slot gain reference; limited output stays finite', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre, defaultBus, DEFAULT_CHANNEL_MIX, LAB_SLOT_IDS } = await import('/src/model/documents.ts');
    const render = async (count, bus, limiter) => {
      const context = new OfflineAudioContext(2, 12000, 48000);
      const engine = new AudioEngine(context, { formatVersion: 'KOROGI-Lab/session-v8', name: 'Eight', savedAt: '',
        channels: LAB_SLOT_IDS.map((id, i) => ({ id, ...DEFAULT_CHANNEL_MIX, balance: bus === 'near' ? 0 : 1, timbre: i < count ? defaultTimbre() : null })),
        near: defaultBus(), far: defaultBus(), crossfade: bus === 'near' ? 0 : 1, masterGainDb: -18, masterMuted: false });
      if (!limiter) { engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination); }
      for (const id of LAB_SLOT_IDS.slice(0, count)) engine.gateOn(id);
      const audio = await context.startRendering();
      const left = audio.getChannelData(0), right = audio.getChannelData(1);
      let peak = 0, energy = 0, finite = true, stereoError = 0;
      for (let i = 2400; i < left.length; i++) {
        const l = left[i], r = right[i]; finite &&= Number.isFinite(l) && Number.isFinite(r);
        peak = Math.max(peak, Math.abs(l), Math.abs(r)); energy += l * l; stereoError = Math.max(stereoError, Math.abs(l - r));
      }
      engine.dispose(); return { peak, rms: Math.sqrt(energy / (left.length - 2400)), finite, stereoError };
    };
    return { one: await render(1, 'near', false), near: await render(8, 'near', false), far: await render(8, 'far', false), limited: await render(8, 'near', true) };
  });
  for (const value of Object.values(result)) { expect(value.finite).toBe(true); expect(value.peak).toBeGreaterThan(0); expect(value.stereoError).toBeLessThan(.0001); }
  expect(result.near.rms / result.one.rms).toBeCloseTo(8, 1);
  expect(result.far.rms).toBeCloseTo(result.near.rms, 4);
  expect(result.limited.peak).toBeLessThan(1);
});
