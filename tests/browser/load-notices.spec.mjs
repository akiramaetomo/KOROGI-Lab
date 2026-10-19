import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('loading a current timbre into a slot does not report the legacy PEnv notice', async ({ page }) => {
  await page.goto('/');
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v20');
  await page.locator('#timbre-file-2').setInputFiles({ name: 'current.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toHaveText(`Loaded timbre 2: ${timbre.name}`);
});

async function saved(page, selector) {
  if (selector === '#export-patch' && !await page.locator(selector).isVisible()) await page.locator('#files-menu').click();
  const download = page.waitForEvent('download');
  await page.locator(selector).click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}
const take = seconds => ({ durationSec: seconds, selectionStartSec: 0, selectionEndSec: seconds, gates: [{ onSec: 0, offSec: seconds / 2 }] });

test('an older Session reports Song sections that now share one Frame, and an older timbre reports bars read from its selections (ADR 0011)', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const session = await saved(page, '#export-patch');
  // session-v20: Pattern 1 played 4 bars and Pattern 2 played 2 bars in Song.
  session.formatVersion = 'KOROGI-Lab/session-v20';
  session.song = { bpm: 120, speed: 1, timingMode: 'bars', bars: [4, 2, 1, 1, 1, 1, 1, 1] };
  const timbre = session.channels[0].timbre;
  timbre.formatVersion = 'KOROGI-Lab/timbre-v17'; delete timbre.patternBars;
  timbre.gatePatterns[0].recording = take(8); timbre.gatePatterns[1].recording = take(4);
  await page.locator('#patch-file').setInputFiles({ name: 'old-song.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Song sections now share one Frame length (4 bars).');
  await expect(page.locator('#song-frame')).toHaveValue('4');
  const migrated = await saved(page, '#export-patch');
  expect(migrated.song.frameBars).toBe(4);
  expect(migrated.channels[0].timbre.patternBars).toEqual([4, 2, 1, 1, 1, 1, 1, 1]);

  // A timbre-v17 file alone: at the Session's 120 BPM, a 0.50 s Gate reads as 1/4 bar and a 4.00 s Gate as 2 bars.
  const old = structuredClone(timbre); old.gatePatterns[0].recording = take(.5);
  await page.locator('#timbre-file-2').setInputFiles({ name: 'old-timbre.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await expect(page.locator('#patch-status')).toContainText('Pattern bars were read from the selections at 120 BPM.');
  await page.locator('#select-2').click();
  const loaded = await saved(page, '#save-2');
  expect(loaded.patternBars).toEqual([.25, 2, 1, 1, 1, 1, 1, 1]);
});
