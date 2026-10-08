import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}
async function loadTimbre(page, timbre) {
  await page.locator('#timbre-file-1').setInputFiles({ name: 'mute.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
}
const playheads = page => page.evaluate(() => ['#record-playhead', '#pitch-playhead']
  .map(selector => parseFloat(document.querySelector(selector).style.left || '0')));
const gateOns = page => page.evaluate(() => window.muteGateOns);
const pitchCent = page => page.evaluate(() => window.muteEngine.getSequencePitchCent('1'));

async function expectCursorsMoving(page) {
  const first = await playheads(page);
  await page.waitForTimeout(230);
  const second = await playheads(page);
  // Both cursors keep running (not pinned to 0) while their lanes are muted.
  expect(second[0]).not.toBe(first[0]); expect(second[1]).not.toBe(first[1]);
  expect(Math.max(...first, ...second)).toBeGreaterThan(0);
}

test('lane Mute keeps the cursors running and silences Gate and Pitch live in Play and Song', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .6 }] };
  timbre.pitchPatterns[0].pitchScaleCent = 1200;
  timbre.pitchPatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: .5 }, { timeSec: 1, valueNormalized: .5 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.muteGateOns = 0;
    const gateOn = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (...args) { window.muteEngine = this; ++window.muteGateOns; return gateOn.apply(this, args); };
  });

  // Play: mute both lanes while running.
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => gateOns(page)).toBeGreaterThan(0);
  await expect.poll(() => pitchCent(page)).toBeCloseTo(600, 0);
  await page.locator('#gate-mute').click(); await page.locator('#pitch-mute').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pitchCent(page)).toBe(0);
  const mutedOns = await gateOns(page);
  await expectCursorsMoving(page);
  await page.waitForTimeout(1100);
  expect(await gateOns(page)).toBe(mutedOns);
  await page.locator('#pitch-mute').click();
  await expect.poll(() => pitchCent(page)).toBeCloseTo(600, 0);
  await page.locator('#gate-mute').click();
  await expect.poll(() => gateOns(page), { timeout: 2500 }).toBeGreaterThan(mutedOns);
  await page.locator('#sequence-panel').click();

  // Song: Mute applies live without stopping Song; the cursor follows the Song's current Pattern.
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pitchCent(page)).toBeCloseTo(600, 0);
  await page.locator('#gate-mute').click(); await page.locator('#pitch-mute').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => pitchCent(page)).toBe(0);
  const songMutedOns = await gateOns(page);
  await expectCursorsMoving(page);
  await page.waitForTimeout(1100);
  expect(await gateOns(page)).toBe(songMutedOns);
  await page.locator('#gate-mute').click(); await page.locator('#pitch-mute').click();
  await expect.poll(() => gateOns(page), { timeout: 2500 }).toBeGreaterThan(songMutedOns);
  await expect.poll(() => pitchCent(page)).toBeCloseTo(600, 0);
  await page.locator('#song-toggle').click();
});
