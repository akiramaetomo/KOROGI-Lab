// Audit 2026-10-19 (base da0d25d): main.ts handles a tap on the framed SONG cell by toggling inSong without
// checking recorder.isBusy(); the spec (2026-10-18 SONG cell) only says a recording refuses selection changes.
// Expected by reading: during a recording, a second tap on the framed cell of the recording target still turns
// its In Chain on or off. The author accepted this on 2026-10-19 (real-time first), provided the take stays intact.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
// Audit probes run only on request: KOROGI_AUDIT=1, so lab.ps1 check keeps its own baseline.
test.skip(!process.env.KOROGI_AUDIT, 'Audit probe: set KOROGI_AUDIT=1 to run.');

async function saveSession(page) {
  if (!await page.locator('#export-patch').isVisible()) await page.locator('#files-menu').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-patch').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

test('a framed SONG cell still toggles In Chain while its timbre records', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  session.channels[0].timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .5 }] };
  await page.locator('#patch-file').setInputFiles({ name: 'cell.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#sequence-open').click();
  const cell = page.locator('#song-arrange-1-1');
  await cell.click();
  await expect(cell).toHaveAttribute('data-focus', '');
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).toHaveAttribute('aria-label', 'End Recording');
  await cell.click();
  const during = await cell.getAttribute('aria-pressed');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).not.toHaveAttribute('aria-label', 'End Recording');
  const saved = await saveSession(page);
  test.info().annotations.push({ type: 'observed', description: `aria-pressed during recording after tap: ${during}; saved inSong: ${saved.channels[0].timbre.gatePatterns[0].inSong}` });
  expect(during).toBe('false');
  expect(saved.channels[0].timbre.gatePatterns[0].inSong).toBe(false);
});

// Author (2026-10-19): the toggle is wanted, provided the take being recorded stays intact.
test('toggling In Chain during a recording keeps the take being recorded', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  const original = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates: [{ onSec: 1.5, offSec: 1.9 }] };
  session.channels[0].timbre.gatePatterns[0].recording = original;
  await page.locator('#patch-file').setInputFiles({ name: 'take.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#sequence-open').click();
  const cell = page.locator('#song-arrange-1-1');
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).toHaveAttribute('aria-label', 'End Recording');
  // A Gate held early in the first lap replaces the lap's old Gate (Replace).
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // One mouse cannot hold the Gate and tap the cell at once; a held Gate with a second finger is a device check.
  await page.mouse.down(); await page.waitForTimeout(400); await page.mouse.up();
  const before = await page.locator('#record-gates span').count();
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'false');
  const after = await page.locator('#record-gates span').count();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).not.toHaveAttribute('aria-label', 'End Recording');
  const saved = (await saveSession(page)).channels[0].timbre.gatePatterns[0];
  test.info().annotations.push({ type: 'observed', description: `take gates: ${JSON.stringify(saved.recording?.gates)}; drawn before/after tap: ${before}/${after}; inSong: ${saved.inSong}` });
  expect(after).toBe(before);
  expect(saved.inSong).toBe(false);
  expect(saved.recording.gates.length).toBeGreaterThan(0);
  expect(saved.recording.gates).not.toEqual(original.gates);
  // The held Gate (about 0.5 s from the lap start) is in the take.
  expect(saved.recording.gates.some(gate => gate.onSec < 1 && gate.offSec - gate.onSec > .3)).toBe(true);
});
