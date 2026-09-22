import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function panel(page, name) {
  if (name === 'space-effects') {
    const bus = await page.locator('.bus-segment [aria-pressed="true"]').getAttribute('data-bus-choice');
    await page.locator(`#flow-${bus}-fx2`).click();
  } else {
    const target = page.locator(`[data-panel-target="${name}"]`).first();
    await target.click(name === 'voice-effects' ? { position: { x: 8, y: 15 } } : undefined);
  }
}
async function edit(page, selector, value) { await page.locator(selector).fill(String(value)); await page.locator(selector).dispatchEvent('change'); }
async function save(page, id = 'export-patch') {
  if (id === 'export-patch') await panel(page, 'patch');
  const download = page.waitForEvent('download'); await page.locator(`#${id}`).first().click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}
async function file(page, selector, value) { await page.locator(selector).setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) }); }
async function start(page) { await page.goto('/'); }
async function four(page) { await start(page); for (const id of ['2', '3', '4']) { await page.locator(`#select-${id}`).click(); await page.locator(`#standard-${id}`).click(); } await page.locator('#select-1').click(); }

test('Initial slots, empty-source editor, per-timbre editing and common FX selection remain independent', async ({ page }) => {
  await start(page); await expect(page.locator('.mixer-slot')).toHaveCount(8);
  await expect(page.locator('#name-1')).toHaveValue('Standard');
  await expect(page.locator('#name-2')).toBeDisabled();
  await expect(page.locator('#pan-2')).toBeDisabled();
  await expect(page.locator('#save-2')).toBeDisabled();
  await expect(page.locator('#standard-2')).toHaveText('Init');
  await expect(page.locator('.mixer-slot').first().locator('.slot-files button')).toHaveCount(4);
  const slotsGap = await page.locator('.mixer-slots').evaluate(node => getComputedStyle(node).rowGap);
  expect(parseFloat(slotsGap)).toBeCloseTo(9.1, 1);
  await expect(page.locator('#gate-2')).toBeDisabled(); await page.locator('#select-2').click();
  await expect(page.locator('#osc1-frequency')).toBeDisabled(); await expect(page.locator('#master-gain')).toBeEnabled();
  await panel(page, 'space-effects'); await expect(page.locator('#fx1-type')).toBeDisabled(); await expect(page.locator('#fx2-type')).toBeEnabled();
  await page.locator('#effects-far').click(); await page.locator('#fx2-type').selectOption('delay'); await edit(page, '#fx2-delay-time', 432);
  await page.locator('#standard-2').click(); await expect(page.locator('#fx1-type')).toBeEnabled();
  await expect(page.locator('#name-2')).toBeEnabled();
  await expect(page.locator('#save-2')).toBeEnabled();
  await panel(page, 'sources'); await edit(page, '#osc1-frequency', 2100);
  await panel(page, 'output'); await edit(page, '#detune-range', 40);
  await page.locator('#select-1').click(); await expect(page.locator('#detune-range')).toHaveValue('0');
  await panel(page, 'space-effects'); await expect(page.locator('#effects-far')).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('#fx2-delay-time')).toHaveValue('432');
  const value = await save(page);
  expect(value.channels[0].timbre.settings.osc1.baseFrequencyHz).toBe(4000);
  expect(value.channels[1].timbre.settings.osc1.baseFrequencyHz).toBe(2100); expect(value.channels[1].timbre.detuneRangeCent).toBe(40);
  expect(value.channels[0].timbre.detuneRangeCent).toBe(0);
});

test('new Timbres default to SYNC and the common OSC1/2 phase mode persists per Timbre', async ({ page }) => {
  await start(page); await panel(page, 'sources');
  await expect(page.locator('#phase-mode + .segmented-choice [data-value="sync"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#phase-mode + .segmented-choice [data-value="free"]').click();
  const timbre = await save(page, 'save-1'); expect(timbre.settings.phaseMode).toBe('free');
  await file(page, '#timbre-file-2', timbre); await page.locator('#select-2').click(); await panel(page, 'sources');
  await expect(page.locator('#phase-mode + .segmented-choice [data-value="free"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#select-3').click(); await page.locator('#standard-3').click(); await panel(page, 'sources');
  await expect(page.locator('#phase-mode + .segmented-choice [data-value="sync"]')).toHaveAttribute('aria-checked', 'true');
});

test('Keys 1–4 support simultaneous Hold, selection changes, Auto takeover, input/IME guards and blur release', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await four(page); await page.locator('#select-1').focus();
  await page.keyboard.down('1'); await page.keyboard.down('2');
  for (const id of ['1', '2']) await expect(page.locator(`[data-slot="${id}"] .slot-gate`)).toHaveClass(/on/);
  await page.locator('#select-3').click(); await page.keyboard.up('1');
  await expect(page.locator('[data-slot="1"] .slot-gate')).not.toHaveClass(/on/);
  await expect(page.locator('[data-slot="2"] .slot-gate')).toHaveClass(/on/);
  await page.locator('#play-2').click(); await page.keyboard.up('2'); await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#play-2').click(); await panel(page, 'sources');
  await page.locator('#osc1-frequency').focus(); await page.keyboard.press('4');
  await expect(page.locator('[data-slot="4"] .slot-gate')).not.toHaveClass(/on/);
  await page.locator('#select-4').focus();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', code: 'Digit4', isComposing: true, bubbles: true })));
  await expect(page.locator('[data-slot="4"] .slot-gate')).not.toHaveClass(/on/);
  await page.keyboard.down('Shift'); await page.keyboard.press('4'); await page.keyboard.up('Shift');
  await expect(page.locator('[data-slot="4"] .slot-gate')).not.toHaveClass(/on/);
  await page.keyboard.down('3'); await page.keyboard.down('4');
  for (const id of ['3', '4']) await expect(page.locator(`[data-slot="${id}"] .slot-gate`)).toHaveClass(/on/);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  for (const id of ['3', '4']) await expect(page.locator(`[data-slot="${id}"] .slot-gate`)).not.toHaveClass(/on/);
  await page.keyboard.up('3'); await page.keyboard.up('4'); expect(errors).toEqual([]);
});

test('Multiple pointer captures retain their source across selection and cancellation, and stale release cannot stop a replacement', async ({ page }) => {
  await four(page);
  const press = async (id, pointerId) => page.locator(`#gate-${id}`).dispatchEvent('pointerdown', { pointerId, pointerType: 'touch', button: 0 });
  // Synthetic pointers cannot be captured natively: isolate ownership from capture here.
  await page.evaluate(() => { window.nativePointerCapture = HTMLButtonElement.prototype.setPointerCapture; HTMLButtonElement.prototype.setPointerCapture = () => {}; });
  await press('1', 11); await press('2', 12);
  for (const id of ['1', '2']) await expect(page.locator(`[data-slot="${id}"] .slot-gate`)).toHaveClass(/on/);
  await page.locator('#select-4').click(); await page.locator('#gate-1').dispatchEvent('pointercancel', { pointerId: 11 });
  await expect(page.locator('[data-slot="1"] .slot-gate')).not.toHaveClass(/on/);
  await expect(page.locator('[data-slot="2"] .slot-gate')).toHaveClass(/on/);
  await page.locator('#select-2').click(); await page.locator('#standard-2').click(); await page.locator('#play-2').click();
  await page.locator('#gate-2').dispatchEvent('pointerup', { pointerId: 12 });
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { HTMLButtonElement.prototype.setPointerCapture = window.nativePointerCapture; });
  const button = page.locator('#gate-3'); await button.scrollIntoViewIfNeeded(); const rect = await button.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down();
  await expect(page.locator('[data-slot="3"] .slot-gate')).toHaveClass(/on/);
  await page.mouse.move(740, 100); await page.mouse.up();
  await expect(page.locator('[data-slot="3"] .slot-gate')).not.toHaveClass(/on/);
});

test('Timbre and session round-trip independently; old formats are rejected without changing playback', async ({ page }) => {
  await four(page); await page.locator('#select-2').click();
  await panel(page, 'sources'); await edit(page, '#osc1-frequency', 2200);
  await edit(page, '#name-2', 'Second'); await expect(page.locator('#select-2')).toContainText('Second');
  const timbre = await save(page, 'save-2');
  await expect(page.locator('#select-2')).toHaveAttribute('aria-pressed', 'true');
  await panel(page, 'patch'); await expect(page.locator('#timbre-name, #export-timbre')).toHaveCount(0);
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v7'); expect(timbre).not.toHaveProperty('near'); expect(timbre).not.toHaveProperty('pan');
  await page.locator('#level-2').evaluate(input => { input.value = '-9'; input.dispatchEvent(new Event('input')); });
  await page.locator('#balance-2').evaluate(input => { input.value = '.8'; input.dispatchEvent(new Event('input')); });
  await page.locator('#pan-2').evaluate(input => { input.value = '-.65'; input.dispatchEvent(new Event('input')); });
  await expect(page.locator('#pan-readout-2')).toHaveText('L 65%');
  await page.locator('#mute-2').click(); await panel(page, 'space-effects'); await edit(page, '#near-gain', -5);
  await panel(page, 'space-output'); await edit(page, '#master-gain', -21);
  await edit(page, '#crossfade', 70);
  await page.locator('#master-mute').click(); const saved = await save(page);
  expect(saved.formatVersion).toBe('KOROGI-Lab/session-v8'); expect(saved.channels[1].pan).toBe(-.65);
  await file(page, '#timbre-file-3', timbre); await expect(page.locator('#patch-status')).toContainText('Loaded timbre 3: Second');
  const afterTimbre = await save(page); expect(afterTimbre.near).toEqual(saved.near); expect(afterTimbre.crossfade).toBe(.7);
  expect(afterTimbre.channels[1].pan).toBe(-.65); expect(afterTimbre.channels[2].pan).toBe(0);
  expect(afterTimbre.channels[2].timbre).toEqual(timbre); expect(afterTimbre.channels[1].gainDb).toBe(-9);
  await file(page, '#patch-file', saved); await expect(page.locator('#patch-status')).toContainText('Loaded:');
  const restored = await save(page); delete saved.savedAt; delete restored.savedAt; expect(restored).toEqual(saved);
  for (const id of ['1', '2', '3', '4']) await expect(page.locator(`#play-${id}`)).toHaveAttribute('aria-pressed', 'false');
  const legacy = { formatVersion: 'KOROGI-Lab/0.1-harness-1ch-v4', patchName: 'Old', savedAt: '', globalDetuneRangeCent: 25,
    channel1: { settings: { ...timbre.settings, busAssignment: 'mix2' }, detuneNormalized: .2 }, mix1: { ...saved.near, gainDb: -11 }, mix2: { ...saved.far, gainDb: -13 }, masterGainDb: -23 };
  await page.locator('#play-2').click();
  for (const old of [legacy, { ...timbre, formatVersion: 'KOROGI-Lab/timbre-v1' }]) {
    await file(page, '#timbre-file-4', old); await expect(page.locator('#patch-status')).toContainText('fixed at -18 dB');
    await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  }
  for (const old of [legacy, { ...saved, formatVersion: 'KOROGI-Lab/session-v1' }]) {
    await file(page, '#patch-file', old); await expect(page.locator('#patch-status')).toContainText('fixed at -18 dB');
    await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  }
  const kept = await save(page); delete kept.savedAt; expect(kept).toEqual(saved);
});

test('Malformed slot load and invalid Lab topology preserve live Auto and settings', async ({ page }) => {
  await start(page); await page.locator('#play-1').click(); const original = await save(page);
  const invalid = structuredClone(original.channels[0].timbre); delete invalid.settings.fx1;
  await file(page, '#timbre-file-1', invalid); await expect(page.locator('#patch-status')).toContainText('Timbre import failed:');
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  const badScene = structuredClone(original); badScene.channels[3].id = '5';
  await file(page, '#patch-file', badScene); await expect(page.locator('#patch-status')).toContainText('Import failed:');
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  const after = await save(page); delete original.savedAt; delete after.savedAt; expect(after).toEqual(original);
});

for (const [width, height] of [[1440, 900], [1024, 900], [768, 768]]) {
  test(`Mixer and common output remain reachable at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height }); await four(page);
    if (width === 1440) for (const id of ['1', '2', '3', '4']) await expect(page.locator(`#gate-${id}`)).toBeInViewport();
    for (const id of ['1', '2', '3', '4']) {
      await page.locator(`#level-${id}`).scrollIntoViewIfNeeded(); await expect(page.locator(`#level-${id}`)).toBeInViewport();
      await page.locator(`#play-${id}`).first().click(); await expect(page.locator(`#play-${id}`)).toHaveAttribute('aria-pressed', 'true');
    }
    await panel(page, 'space-output');
    for (const selector of ['#crossfade', '#master-gain', '#master-mute']) { await page.locator(selector).scrollIntoViewIfNeeded(); await expect(page.locator(selector)).toBeInViewport(); }
    await panel(page, 'voice-effects'); await page.locator('#fx1-type').selectOption('distortion');
    await panel(page, 'space-effects'); await page.locator('#fx2-type').selectOption('delay'); await page.locator('#fx3-type').selectOption('reverb');
    await page.locator('#fx3-reverb-decay').scrollIntoViewIfNeeded(); await expect(page.locator('#fx3-reverb-decay')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mixer-${width}x${height}.png`) });
  });
}
