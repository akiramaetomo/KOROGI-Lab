import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function savedTimbre(page, id = '1') {
  const save = page.locator(`#save-${id}`); await expect(save).toBeEnabled();
  if (await save.isHidden()) { await page.locator(`#select-${id}`).click(); await expect(save).toBeVisible(); }
  const download = page.waitForEvent('download');
  await save.click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function loadTimbre(page, id, timbre) {
  await page.locator(`#timbre-file-${id}`).setInputFiles({ name: `timbre-${id}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText(`Loaded timbre ${id}:`);
}

/** Records every started triangle oscillator so the click schedule can be checked numerically. */
async function watchClicks(page) {
  await page.addInitScript(() => {
    window.clickStarts = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when = 0) {
      if (this.type === 'triangle') window.clickStarts.push({ when, hz: this.frequency.value, now: this.context.currentTime });
      return start.call(this, when);
    };
  });
}

test('Grid lines follow the Pattern bars only in Bars, and entering Bars offers bars from the recorded seconds', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  const timbre = await savedTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 6, selectionStartSec: 0, selectionEndSec: 6, gates: [{ onSec: 0, offSec: .1 }] };
  await loadTimbre(page, '1', timbre);
  await page.locator('#trigger-menu').click();
  await page.locator('#source-user-1').click();
  await expect(page.locator('#record-grid')).toBeHidden();
  // 6 s at 120 BPM reads as 3 bars; declining keeps the current 1 bar.
  const offer = new Promise(resolve => page.once('dialog', async dialog => { resolve(dialog.message()); await dialog.dismiss(); }));
  await page.locator('#time-mode-bars').click();
  expect(await offer).toContain('Timbre 1 · Pattern 1: 1 → 3 bars');
  await expect(page.locator('#record-grid')).toBeVisible();
  await expect(page.locator('#record-grid')).toHaveAttribute('data-bars', '1');
  await page.locator('#sequence-stretch-bars').selectOption('2');
  await expect(page.locator('#record-grid')).toHaveAttribute('data-bars', '2');
  // 2 bars at 120 BPM = 4 s of the 6 s recording.
  await page.locator('#gate-apply-bars').click();
  await expect(page.locator('#record-end-value')).toHaveText('4.00 s');
  const grid = await page.locator('#record-grid').evaluate(node => ({ width: node.style.width, background: node.style.backgroundImage }));
  expect(Number.parseFloat(grid.width)).toBeCloseTo(400 / 6, 3);
  expect(grid.background).toContain('100% / 2');
  expect(grid.background).toContain('100% / 8');
  // Bars divides the Null Pitch Timeline by the same Pattern bars.
  await expect(page.locator('#pitch-grid')).toHaveAttribute('data-bars', '2');
  await page.locator('#time-mode-seconds').click();
  await expect(page.locator('#pitch-grid')).toBeHidden();
  await expect(page.locator('#record-grid')).toBeHidden();
});

test('a Bars recording clicks pi-po-po-po on the beat, lights the beat lamp and remembers Off', async ({ page }) => {
  await watchClicks(page);
  await page.goto('/'); await expect(page.locator('#record-toggle')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  await page.locator('#trigger-menu').click();
  await page.locator('#source-user-2').click(); await page.locator('#pitch-user-2').click();
  // Seconds has no BPM, so no click.
  await expect(page.locator('#record-click')).toBeHidden();
  await page.locator('#time-mode-bars').click();
  await expect(page.locator('#record-click')).toBeVisible();
  await expect(page.locator('#record-click option')).toHaveText(['Click Off', 'Click 1/4']);
  await expect(page.locator('#record-click')).toHaveValue('1/4');
  await expect(page.locator('#record-grid')).toHaveAttribute('data-bars', '1');
  await expect(page.locator('#record-beat-lamp span')).toHaveCount(4);
  await expect(page.locator('#record-beat-lamp span').first()).toHaveAttribute('data-tone', 'pi');

  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  const steps = new Set();
  for (let index = 0; index < 50 && steps.size < 4; index += 1) {
    const step = await page.locator('#record-beat-lamp').getAttribute('data-step');
    if (step !== '-1') steps.add(step);
    await page.waitForTimeout(60);
  }
  expect([...steps].sort()).toEqual(['0', '1', '2', '3']);
  await expect(page.locator('#record-grid')).toBeVisible();
  // Tones come from the constants file, so tuning the click does not break this test.
  const { tones, pattern } = await page.evaluate(async () => {
    const { METRONOME_PATTERNS, METRONOME_TONES } = await import('/src/config/metronome.ts');
    return { tones: METRONOME_TONES, pattern: METRONOME_PATTERNS['1/4'] };
  });
  const clickHz = new Set(Object.values(tones));
  const clicks = await page.evaluate(hz => window.clickStarts.filter(click => hz.some(value => Math.abs(value - click.hz) < .01)), [...clickHz]);
  expect(clicks.length).toBeGreaterThanOrEqual(4);
  // AudioParam values are float32, so compare at 0.01 Hz.
  const round = hz => Math.round(hz * 100) / 100;
  expect(clicks.slice(0, 4).map(click => round(click.hz))).toEqual(pattern.map(tone => round(tones[tone])));
  // One bar at 120 BPM lasts 2 s and the pattern divides it evenly.
  for (let index = 1; index < 4; index += 1) expect(clicks[index].when - clicks[index - 1].when).toBeCloseTo(2 / pattern.length, 6);
  for (const click of clicks) expect(click.when).toBeGreaterThanOrEqual(click.now - .001);

  await page.locator('#record-click').selectOption('off');
  await expect(page.locator('#record-beat-lamp')).toHaveAttribute('data-step', '-1');
  await expect(page.locator('#record-beat-lamp')).toHaveClass(/off/);
  const before = await page.evaluate(() => window.clickStarts.length);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.clickStarts.length)).toBe(before);
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).not.toContainText('Recording · Loop');
  await page.reload(); await expect(page.locator('#record-toggle')).toBeEnabled();
  await expect(page.locator('#record-click')).toHaveValue('off');
});

test('a backing timbre keeps playing through recording and Play All leaves the recording monitor running', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const backing = await savedTimbre(page);
  backing.sequence.gateMode = 'user';
  backing.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    gates: [0, .5, 1, 1.5].map(onSec => ({ onSec, offSec: onSec + .05 })) };
  await loadTimbre(page, '2', backing);
  await page.locator('#trigger-menu').click();
  await page.locator('#select-1').click();
  await page.locator('#play-2').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#source-user-2').click(); await page.locator('#pitch-user-2').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-all')).toHaveText('■ Stop Loop');
  await page.locator('#play-all').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-all')).toHaveText('▶ Loop');
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#play-all').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await expect(page.locator('#record-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
});
