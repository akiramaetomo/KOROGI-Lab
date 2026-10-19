// Audit 2026-10-19 (base da0d25d): the spec (2026-10-17 Pattern copy, "再生中") says a Stretch loop that is playing
// enters with its new length from the next bar head, but main.ts's #copy-user handler calls transport.stop(id) first
// (unchanged since b08f6b6, 2026-10-03, before Stretch). Expected by reading: in Bars, copying another Pattern of a
// timbre that plays in Loop stops that timbre, while another timbre keeps playing.
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

test('copying a Pattern in Bars while the timbre loops', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  const recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates: [{ onSec: .1, offSec: .5 }] };
  session.channels[1].timbre = structuredClone(session.channels[0].timbre);
  session.channels[0].timbre.gatePatterns[0].recording = recording;
  session.channels[1].timbre.gatePatterns[0].recording = recording;
  await page.locator('#patch-file').setInputFiles({ name: 'copy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await expect(page.locator('#time-mode-bars')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#select-1').click();
  await page.locator('#sequence-open').click();
  await page.locator('#source-user-1').click();
  await page.locator('#play-all').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#copy-from').selectOption('user-1');
  await page.locator('#copy-to').selectOption('user-3');
  await page.locator('#copy-user').click();
  await expect(page.locator('#patch-status')).toContainText('Copied Timbre 1');
  await page.waitForTimeout(300);
  const playing1 = await page.locator('#play-1').getAttribute('aria-pressed');
  const playing2 = await page.locator('#play-2').getAttribute('aria-pressed');
  test.info().annotations.push({ type: 'observed', description: `after copy: timbre 1 playing=${playing1}, timbre 2 playing=${playing2}` });
  expect(playing1).toBe('false');
  expect(playing2).toBe('true');
});
