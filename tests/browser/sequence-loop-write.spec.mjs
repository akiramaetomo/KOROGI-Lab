import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function loadTimbre(page, timbre) {
  await page.locator('#timbre-file-1').setInputFiles({ name: 'loop-write.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  await page.locator('#trigger-menu').click();
}

async function gateFor(page, milliseconds = 100) {
  const gate = page.locator('#record-gate');
  await gate.scrollIntoViewIfNeeded();
  const box = await gate.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(milliseconds);
  await page.mouse.up();
}

test('Replace keeps its new Gate take across an untouched next lap in Bars mode', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  const old = { onSec: .05, offSec: .2 };
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [old] };
  await page.locator('#record-length-mode').evaluate(select => { select.value = 'bars'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await loadTimbre(page, timbre);
  await expect(page.locator('#record-length-mode')).toHaveValue('bars');
  await expect(page.locator('#record-length')).toBeDisabled();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.waitForTimeout(280);
  await gateFor(page);
  await expect(page.locator('#record-counter')).toContainText('Lap 2', { timeout: 3000 });
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.gates).not.toContainEqual(old);
  expect(saved.gatePatterns[0].recording.gates).toHaveLength(1);
});

test('Replace allows an empty first lap and keeps the second-lap take through an empty third lap', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  const old = { onSec: .05, offSec: .2 };
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [old] };
  await page.locator('#record-length-mode').evaluate(select => { select.value = 'bars'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await loadTimbre(page, timbre);
  await expect(page.locator('#record-length-mode')).toHaveValue('bars');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-counter')).toContainText('Lap 2', { timeout: 3000 });
  await page.waitForTimeout(280);
  await gateFor(page);
  await expect(page.locator('#record-counter')).toContainText('Lap 3', { timeout: 3000 });
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.gates).not.toContainEqual(old);
  expect(saved.gatePatterns[0].recording.gates).toHaveLength(1);
});

test('Replace clears the entire selected interval while Overdub locally corrects Gate', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const original = await saveTimbre(page);
  original.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    gates: [{ onSec: 0, offSec: 1.5 }, { onSec: 1.7, offSec: 1.9 }] };
  for (const [mode, expectedCount] of [['replace', 1], ['overdub', 2]]) {
    await loadTimbre(page, original);
    await page.locator(`#record-write-mode + .segmented-choice [data-value="${mode}"]`).click();
    await page.locator('#record-toggle').click();
    await expect(page.locator('#record-status')).toContainText('Recording · Loop');
    await gateFor(page);
    await page.locator('#record-toggle').click();
    const gates = (await saveTimbre(page)).gatePatterns[0].recording.gates;
    expect(gates).toHaveLength(expectedCount);
    if (mode === 'overdub') {
      expect(gates[0]).toMatchObject({ onSec: 0 });
      expect(gates).toContainEqual({ onSec: 1.7, offSec: 1.9 });
    } else expect(gates.some(gate => gate.onSec === 0 || gate.onSec === 1.7)).toBe(false);
  }
});

test('Pitch edits end at release, Center hold returns to the existing curve, and both lanes monitor', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
    gates: [{ onSec: .12, offSec: .18 }] };
  timbre.pitchPatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: .4 }, { timeSec: 1, valueNormalized: .4 }] };
  await loadTimbre(page, timbre);
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await page.locator('#record-write-mode + .segmented-choice [data-value="overdub"]').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.monitoredGate = 0; window.monitoredPitch = 0;
    const on = AudioEngine.prototype.gateOn, pitch = AudioEngine.prototype.setSequencePitch;
    AudioEngine.prototype.gateOn = function (...args) { ++window.monitoredGate; return on.apply(this, args); };
    AudioEngine.prototype.setSequencePitch = function (...args) { ++window.monitoredPitch; return pitch.apply(this, args); };
  });
  await page.locator('#record-toggle').click();
  await expect.poll(() => page.evaluate(() => window.monitoredGate), { timeout: 3000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.monitoredPitch), { timeout: 3000 }).toBeGreaterThan(0);
  await page.locator('#sequence-pitch-input').fill('0.8');
  await page.locator('#sequence-pitch-input').dispatchEvent('input');
  await page.waitForTimeout(80);
  await page.locator('#sequence-pitch-input').dispatchEvent('change');
  await page.waitForTimeout(100);
  const center = await page.locator('#sequence-pitch-center').boundingBox();
  await page.mouse.move(center.x + center.width / 2, center.y + center.height / 2);
  await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  const points = saved.pitchPatterns[0].recording.points;
  expect(points.some(point => point.valueNormalized === .8)).toBe(true);
  expect(points.some(point => point.valueNormalized === 0)).toBe(true);
  expect(points[0].valueNormalized).toBe(.4);
  expect(points.at(-1).valueNormalized).toBe(.4);
  expect(saved.gatePatterns[0].recording).toEqual(timbre.gatePatterns[0].recording);
});

test('different Gate and Pitch selection lengths record independently without Link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: .1, selectionEndSec: .5, gates: [] };
  timbre.pitchPatterns[0].recording = { durationSec: 1, selectionStartSec: .2, selectionEndSec: .9,
    points: [{ timeSec: 0, valueNormalized: .2 }, { timeSec: 1, valueNormalized: .2 }] };
  await loadTimbre(page, timbre);
  await expect(page.locator('#record-new-length')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#record-length')).toHaveValue('30');
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-counter')).toContainText('Gate');
  await expect(page.locator('#record-counter')).toContainText('Pitch');
  // The two-lane counter stays above the ● ▶ buttons, inside the panel, and clear of the Write buttons.
  const counterBox = await page.locator('.trigger-user-group').evaluate(panel => {
    const counter = panel.querySelector('#record-counter');
    const text = document.createRange(); text.selectNodeContents(counter);
    const box = text.getBoundingClientRect(), panelBox = panel.getBoundingClientRect();
    const write = [...panel.querySelectorAll('#record-write-mode + .segmented-choice button')].at(-1).getBoundingClientRect();
    return { aboveButton: panel.querySelector('#record-toggle').getBoundingClientRect().top - box.bottom,
      insidePanel: panelBox.right - box.right, clearOfWrite: box.left - write.right };
  });
  expect(counterBox.aboveButton).toBeGreaterThanOrEqual(0);
  expect(counterBox.insidePanel).toBeGreaterThanOrEqual(0);
  expect(counterBox.clearOfWrite).toBeGreaterThanOrEqual(0);
  await gateFor(page, 70);
  await page.locator('#sequence-pitch-input').fill('0.7');
  await page.locator('#sequence-pitch-input').dispatchEvent('input');
  await page.waitForTimeout(60);
  await page.locator('#sequence-pitch-input').dispatchEvent('change');
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBe(.1);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBe(.5);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBe(.2);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBe(.9);
  expect(saved.gatePatterns[0].recording.gates.length).toBeGreaterThan(0);
  expect(saved.pitchPatterns[0].recording.points.some(point => point.valueNormalized === .7)).toBe(true);
});

test('Replace listens through an empty lap and End without input preserves both lanes', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
    gates: [{ onSec: .2, offSec: .4 }] };
  timbre.pitchPatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: .5 }, { timeSec: 1, valueNormalized: .5 }] };
  await loadTimbre(page, timbre);
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('listening to old recording');
  await expect(page.locator('#record-counter')).toContainText('Lap 2', { timeout: 3000 });
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).toEqual(timbre.gatePatterns[0].recording);
  expect(saved.pitchPatterns[0].recording).toEqual(timbre.pitchPatterns[0].recording);
});

test('Replace starts another full Gate take on a later lap', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    gates: [{ onSec: .02, offSec: .06 }] };
  await loadTimbre(page, timbre);
  await page.locator('#record-toggle').click();
  await gateFor(page, 70);
  await expect(page.locator('#record-counter')).toContainText('Lap 2', { timeout: 3000 });
  await page.waitForTimeout(250);
  await gateFor(page, 70);
  await expect(page.locator('#record-counter')).toContainText('Lap 2');
  await page.locator('#record-toggle').click();
  const gates = (await saveTimbre(page)).gatePatterns[0].recording.gates;
  expect(gates).toHaveLength(1);
  expect(gates[0].onSec).toBeGreaterThan(.1);
  expect(gates[0].onSec).toBeLessThan(1.8);
});

test('repeated same-position Pitch taps in Both update the live curve and restore Overdub Pitch', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates: [] };
  timbre.pitchPatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    points: [{ timeSec: 0, valueNormalized: .4 }, { timeSec: 2, valueNormalized: .4 }] };
  await loadTimbre(page, timbre);
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-write-mode + .segmented-choice [data-value="overdub"]').click();
  await page.locator('#record-toggle').click();
  const curve = page.locator('#pitch-curve-line');
  const before = await curve.getAttribute('points');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const thumb = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await expect.poll(() => curve.getAttribute('points')).not.toBe(before);
  await page.waitForTimeout(75);
  await page.mouse.up();
  await page.waitForTimeout(130);
  await page.mouse.down();
  await page.waitForTimeout(75);
  await page.mouse.up();
  const restored = await curve.getAttribute('points');
  expect(restored).toContain(',50');
  expect(restored).toContain(',30');
  await page.locator('#record-toggle').click();
  const points = (await saveTimbre(page)).pitchPatterns[0].recording.points;
  expect(points.filter(point => point.valueNormalized === 0).length).toBeGreaterThanOrEqual(2);
  expect(points.some(point => point.valueNormalized === .4 && point.timeSec > 0 && point.timeSec < 2)).toBe(true);
  expect(points.at(-1).valueNormalized).toBe(.4);
});

test('Pitch Replace centers the rest of the selected interval and leaves Gate untouched', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    gates: [{ onSec: 1.2, offSec: 1.4 }] };
  timbre.pitchPatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    points: [{ timeSec: 0, valueNormalized: .4 }, { timeSec: 2, valueNormalized: .4 }] };
  await loadTimbre(page, timbre);
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await page.locator('#record-toggle').click();
  await page.locator('#sequence-pitch-input').fill('0.8');
  await page.locator('#sequence-pitch-input').dispatchEvent('input');
  await page.waitForTimeout(80);
  await page.locator('#sequence-pitch-input').dispatchEvent('change');
  await expect(page.locator('#record-status')).toContainText('recording new take');
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).toEqual(timbre.gatePatterns[0].recording);
  expect(saved.pitchPatterns[0].recording.points.some(point => point.valueNormalized === .8)).toBe(true);
  expect(saved.pitchPatterns[0].recording.points.at(-1).valueNormalized).toBe(0);
  await loadTimbre(page, saved);
  expect((await saveTimbre(page)).pitchPatterns[0].recording).toEqual(saved.pitchPatterns[0].recording);
});

test('Replace cancels the old Gate monitor after first input while Overdub keeps it', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    gates: [{ onSec: 1.25, offSec: 1.4 }] };
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.oldMonitorOns = 0;
    const original = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (...args) { ++window.oldMonitorOns; return original.apply(this, args); };
  });
  for (const mode of ['replace', 'overdub']) {
    await loadTimbre(page, timbre);
    await page.locator(`#record-write-mode + .segmented-choice [data-value="${mode}"]`).click();
    await page.locator('#record-gate').scrollIntoViewIfNeeded();
    await page.locator('#record-toggle').click();
    await gateFor(page, 70);
    await page.waitForTimeout(1550);
    const ons = await page.evaluate(() => window.oldMonitorOns);
    if (mode === 'replace') expect(ons).toBe(0);
    else expect(ons).toBeGreaterThan(0);
    await page.locator('#record-toggle').click();
    await page.evaluate(() => { window.oldMonitorOns = 0; });
  }
});
