import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function openSequence(page) {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await page.locator('#sequence-pitch-track').scrollIntoViewIfNeeded();
}

async function probeController(page) {
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.holdProbe = { gateOn: 0, gateOff: 0, pitchOn: 0, pitchOff: 0, engine: null };
    for (const [method, key] of [['controllerGateOn', 'gateOn'], ['controllerGateOff', 'gateOff'],
      ['controllerPitchOn', 'pitchOn'], ['controllerPitchOff', 'pitchOff']]) {
      const original = AudioEngine.prototype[method];
      AudioEngine.prototype[method] = function (...args) {
        window.holdProbe[key] += 1;
        window.holdProbe.engine = this;
        return original.apply(this, args);
      };
    }
  });
}

const count = (page, key) => page.evaluate(name => window.holdProbe[name], key);
const pitchCent = page => page.evaluate(() => window.holdProbe.engine?.getSequencePitchCent('1'));

async function tapTrack(page, ratio, holdMs = 0) {
  const track = page.locator('#sequence-pitch-track');
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  await page.mouse.move(box.x + 28 + (box.width - 56) * ratio, box.y + box.height / 2);
  await page.mouse.down();
  if (holdMs) await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

test('Pitch Hold keeps the released controller Pitch until the next touch or Hold OFF', async ({ page }) => {
  await openSequence(page);
  await probeController(page);
  const hold = page.locator('#sequence-pitch-hold');
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await hold.click();
  await expect(hold).toHaveAttribute('aria-pressed', 'true');
  await tapTrack(page, .9);
  await expect.poll(() => count(page, 'gateOff')).toBe(1);
  await page.waitForTimeout(150);
  expect(await count(page, 'pitchOff')).toBe(0);
  expect(await pitchCent(page)).toBeGreaterThan(100);
  await expect(page.locator('#sequence-pitch-track')).toHaveClass(/pitch-latched/);
  await expect(page.locator('#sequence-separate')).toBeDisabled();

  await tapTrack(page, .1);
  await expect.poll(() => pitchCent(page)).toBeLessThan(-100);
  expect(await count(page, 'pitchOff')).toBe(0);
  expect(await count(page, 'pitchOn')).toBe(1);

  await hold.click();
  await expect(hold).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => count(page, 'pitchOff')).toBe(1);
  await expect.poll(() => pitchCent(page)).toBeCloseTo(0, 0);
  await expect(page.locator('#sequence-pitch-track')).not.toHaveClass(/pitch-latched/);
  await expect(page.locator('#sequence-separate')).toBeEnabled();
});

test('Gate Hold keeps the Gate on and a later press moves only Pitch', async ({ page }) => {
  await openSequence(page);
  await probeController(page);
  const hold = page.locator('#sequence-gate-hold');
  const thumb = page.locator('#record-gate');
  await hold.click();
  await tapTrack(page, .8);
  await expect.poll(() => count(page, 'gateOn')).toBe(1);
  await page.waitForTimeout(100);
  expect(await count(page, 'gateOff')).toBe(0);
  await expect(thumb).toHaveAttribute('aria-pressed', 'true');

  await tapTrack(page, .2, 50);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down('Space'); await page.keyboard.up('Space');
  await page.waitForTimeout(100);
  expect(await count(page, 'gateOn')).toBe(1);
  expect(await count(page, 'gateOff')).toBe(0);
  // Without Pitch Hold the Pitch still returns on release.
  expect(await count(page, 'pitchOff')).toBe(2);

  await hold.click();
  await expect.poll(() => count(page, 'gateOff')).toBe(1);
  await expect(thumb).toHaveAttribute('aria-pressed', 'false');
});

test('Separate holds the left Gate and the Pitch slider independently', async ({ page }) => {
  await openSequence(page);
  await probeController(page);
  const separate = page.locator('#sequence-separate');
  await separate.click();
  await page.locator('#sequence-gate-hold').click();
  await page.locator('#sequence-pitch-hold').click();
  const gate = page.locator('#sequence-separate-gate');
  const box = await gate.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.up();
  await expect.poll(() => count(page, 'gateOn')).toBe(1);
  await expect(gate).toHaveAttribute('aria-pressed', 'true');
  await tapTrack(page, .9);
  await expect.poll(() => count(page, 'pitchOn')).toBe(1);
  await page.waitForTimeout(100);
  expect(await count(page, 'gateOff')).toBe(0);
  expect(await count(page, 'pitchOff')).toBe(0);
  await expect(separate).toBeDisabled();

  await page.locator('#sequence-gate-hold').click();
  await expect.poll(() => count(page, 'gateOff')).toBe(1);
  expect(await count(page, 'pitchOff')).toBe(0);
  await expect(separate).toBeDisabled();
  await page.locator('#sequence-pitch-hold').click();
  await expect.poll(() => count(page, 'pitchOff')).toBe(1);
  await expect(separate).toBeEnabled();
});

test('held Gate and Pitch keep recording after release, across the loop, until End', async ({ page }) => {
  await openSequence(page);
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-length').fill('1');
  await page.locator('#sequence-gate-hold').click();
  await page.locator('#sequence-pitch-hold').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await tapTrack(page, .9, 40);
  await page.waitForTimeout(1250);
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#sequence-pitch-track')).not.toHaveClass(/pitch-latched/);
  const saved = await saveTimbre(page);
  // The Gate released in the first lap is still on at the next loop head (a later Overdub Gate owns its overlap).
  const gates = saved.gatePatterns[0].recording.gates;
  expect(gates[0].onSec).toBeCloseTo(0, 3);
  expect(gates[0].offSec).toBeGreaterThan(.15);
  // Without Hold the take would return to Center right after the release.
  const points = saved.pitchPatterns[0].recording.points;
  const valueAt = time => points.filter(point => point.timeSec <= time).at(-1).valueNormalized;
  expect(valueAt(.1)).toBeGreaterThan(.5);
});

test('focus loss and selecting another Timbre release a Hold', async ({ page }) => {
  await openSequence(page);
  await probeController(page);
  await page.locator('#sequence-gate-hold').click();
  await page.locator('#sequence-pitch-hold').click();
  await tapTrack(page, .9);
  await expect.poll(() => count(page, 'gateOn')).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => count(page, 'gateOff')).toBe(1);
  await expect.poll(() => count(page, 'pitchOff')).toBe(1);

  await tapTrack(page, .9);
  await expect.poll(() => count(page, 'gateOn')).toBe(2);
  await page.locator('#select-2').click();
  await expect.poll(() => count(page, 'gateOff')).toBe(2);
  await expect.poll(() => count(page, 'pitchOff')).toBe(2);
  await expect(page.locator('#sequence-gate-hold')).toHaveAttribute('aria-pressed', 'true');
});
