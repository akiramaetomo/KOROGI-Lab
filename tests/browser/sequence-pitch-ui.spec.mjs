import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function savedTimbre(page, id = '1') {
  const save = page.locator(`#save-${id}`); await expect(save).toBeEnabled();
  if (await save.isHidden()) { await page.locator(`#select-${id}`).click(); await expect(save).toBeVisible(); }
  const download = page.waitForEvent('download'); await save.click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function chooseSegment(page, selectId, value) {
  await page.locator(`${selectId} + .segmented-choice [data-value="${value}"]`).click();
}

async function setNumber(page, selector, value) {
  await page.locator(selector).evaluate((node, target) => {
    const slider = node.closest('.numeric-control').querySelector('input[type="range"]');
    const min = Number(node.dataset.sliderMin ?? node.dataset.numericMin);
    const max = Number(node.dataset.sliderMax ?? node.dataset.numericMax);
    const position = node.dataset.numericScale === 'log1p' ? Math.log1p(target) / Math.log1p(max)
      : (target - min) / (max - min);
    slider.value = String(position * 10000); slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test('Pitch User records and displays a simplified curve while Auto Gate plays', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await page.locator('#trigger-menu').click();
  await expect(page.locator('#pitch-record-target')).toContainText('Null');
  await expect(page.locator('#pitch-curve-line')).toHaveAttribute('points', '');
  await expect(page.locator('#record-mode')).toHaveValue('both');
  await chooseSegment(page, '#record-mode', 'pitch');
  await expect(page.locator('#record-mode + .segmented-choice [data-value="pitch"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#record-mode + .segmented-choice [data-value="gate"]')).toBeEnabled();

  await setNumber(page, '#sequence-pitch-scale', 600);
  await page.locator('#sequence-pitch-mode').selectOption('equal');
  await setNumber(page, '#sequence-pitch-steps', 3);
  await setNumber(page, '#sequence-portamento', 80);
  await expect(page.locator('#sequence-pitch-ticks span')).toHaveCount(7);
  expect(await page.locator('#sequence-pitch-ticks span').evaluateAll(nodes => nodes.every(node => getComputedStyle(node).pointerEvents === 'none'))).toBe(true);
  expect(Number(await page.locator('#sequence-pitch-input').getAttribute('step'))).toBeCloseTo(1 / 3, 10);
  const drag = await page.locator('#sequence-pitch-input').evaluate(node => {
    node.scrollIntoView({ block: 'center', inline: 'end' });
    const rect = node.getBoundingClientRect(); const clip = node.closest('.trigger-editor').getBoundingClientRect();
    const left = Math.max(rect.left, clip.left) + 12; const right = Math.min(rect.right, clip.right) - 12;
    return { left, right, y: (Math.max(rect.top, clip.top) + Math.min(rect.bottom, clip.bottom)) / 2 };
  });
  await page.mouse.move(drag.left, drag.y); await page.mouse.down(); await page.mouse.move(drag.right, drag.y);
  await page.waitForTimeout(180); await page.mouse.up();
  expect(Number(await page.locator('#sequence-pitch-input').inputValue())).toBeGreaterThan(0);
  await page.locator('#sequence-pitch-center').click();
  await page.locator('#record-length').fill('3');
  await page.locator('#record-toggle').click(); await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#sequence-pitch-input').focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#sequence-pitch-readout')).toHaveText('400 cent');
  await page.waitForTimeout(70);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(40); await page.locator('#sequence-pitch-center').click();
  await page.locator('#record-toggle').click(); await expect(page.locator('#record-status')).toHaveText('Recording complete');
  await expect(page.locator('#pitch-curve-line')).not.toHaveAttribute('points', '');
  expect(await page.locator('#pitch-curve-line').evaluate(node => ({ stroke: getComputedStyle(node).stroke,
    width: getComputedStyle(node).strokeWidth }))).toEqual({ stroke: 'rgb(214, 187, 117)', width: '3px' });

  const timbre = await savedTimbre(page); const recording = timbre.pitchPatterns[0].recording;
  expect(recording.points.length).toBeGreaterThanOrEqual(3);
  expect(recording.points[0].timeSec).toBe(0);
  expect(recording.points.at(-1).timeSec).toBe(recording.durationSec);
  expect(recording.points.some(point => point.valueNormalized === 2 / 3)).toBe(true);
  expect(recording.points.some(point => point.valueNormalized === -1 / 3)).toBe(true);
  expect(timbre.pitchPatterns[0].pitchScaleCent).toBe(600);
  expect(timbre.pitchPatterns[0].pitchMode).toEqual({ kind: 'stepped', stepsPerSide: 3, scale: 'equal', portamentoSec: .08 });
  expect(timbre.sequence.recordSpeed).toBe(1); expect(timbre.sequence.playSpeed).toBe(1);
  expect(timbre.gatePatterns[0].recording).toBeNull();
});

test('User Gate and Pitch recording lanes can be replaced independently', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const initial = await savedTimbre(page);
  const oldGate = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5, gates: [{ onSec: .1, offSec: .2 }] };
  const oldPitch = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: .25, valueNormalized: .5 }, { timeSec: .5, valueNormalized: 0 }] };
  initial.gatePatterns[0].recording = oldGate; initial.pitchPatterns[0].recording = oldPitch;
  initial.sequence.recordSpeed = 4; initial.sequence.gateMode = 'user';
  await page.locator('#timbre-file-1').setInputFiles({ name: 'lanes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initial)) });
  await page.locator('#trigger-menu').click();

  await expect(page.locator('#record-mode')).toHaveValue('both');
  await chooseSegment(page, '#record-mode', 'both');
  await expect(page.locator('#record-length')).toBeDisabled(); await page.locator('#record-toggle').click();
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.down('Space'); await page.waitForTimeout(40);
  await page.locator('#sequence-pitch-input').fill('0.6'); await page.locator('#sequence-pitch-input').dispatchEvent('input');
  await page.waitForTimeout(40); await page.keyboard.up('Space'); await page.locator('#record-toggle').click();
  const afterBoth = await savedTimbre(page);
  expect(afterBoth.gatePatterns[0].recording).not.toEqual(oldGate); expect(afterBoth.gatePatterns[0].recording.gates).toHaveLength(1);
  expect(afterBoth.pitchPatterns[0].recording).not.toEqual(oldPitch);

  await chooseSegment(page, '#record-mode', 'gate');
  await page.locator('#record-toggle').click(); await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down('Space'); await page.waitForTimeout(70); await page.locator('#record-toggle').click(); await page.keyboard.up('Space');
  const afterGate = await savedTimbre(page);
  expect(afterGate.gatePatterns[0].recording.gates).toHaveLength(1);
  expect(afterGate.pitchPatterns[0].recording).toEqual(afterBoth.pitchPatterns[0].recording);

  await chooseSegment(page, '#record-mode', 'pitch');
  await page.locator('#record-toggle').click();
  await page.locator('#sequence-pitch-input').fill('0.8'); await page.locator('#sequence-pitch-input').dispatchEvent('input');
  await page.waitForTimeout(60); await page.locator('#sequence-pitch-center').click(); await page.locator('#record-toggle').click();
  const afterPitch = await savedTimbre(page);
  expect(afterPitch.gatePatterns[0].recording).toEqual(afterGate.gatePatterns[0].recording);
  expect(afterPitch.pitchPatterns[0].recording).not.toEqual(oldPitch);
  expect(afterPitch.pitchPatterns[0].recording.points.at(-1).timeSec).toBe(afterPitch.pitchPatterns[0].recording.durationSec);
});

test('document Space Trigger preserves its press target and ignores edit, repeat and IME events', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await savedTimbre(page);
  await page.locator('#timbre-file-2').setInputFiles({ name: 'slot-2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.spaceGateCalls = [];
    const on = AudioEngine.prototype.controllerGateOn, off = AudioEngine.prototype.controllerGateOff;
    AudioEngine.prototype.controllerGateOn = function (id) { window.spaceGateCalls.push(`on:${id}`); return on.call(this, id); };
    AudioEngine.prototype.controllerGateOff = function (id) { window.spaceGateCalls.push(`off:${id}`); return off.call(this, id); };
  });

  await expect(page.locator('#select-1')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => window.spaceGateCalls)).toEqual(['on:1']);
  await page.locator('#select-2').click(); await page.keyboard.up('Space');
  await expect.poll(() => page.evaluate(() => window.spaceGateCalls)).toEqual(['on:1', 'off:1']);

  await page.locator('#record-length').focus(); await page.keyboard.press('Space');
  await page.locator('body').dispatchEvent('keydown', { code: 'Space', key: ' ', repeat: true });
  await page.locator('body').dispatchEvent('keydown', { code: 'Space', key: ' ', isComposing: true });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.spaceGateCalls)).toEqual(['on:1', 'off:1']);
});
