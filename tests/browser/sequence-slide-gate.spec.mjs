import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function openSequence(page) {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
}

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function setStopTime(page, milliseconds) {
  await page.locator('.sequence-motion-options > summary').click();
  await expect(page.locator('#sequence-motion-stop')).toBeVisible();
  await page.locator('#sequence-motion-stop').click();
  await page.locator('#sequence-motion-stop').evaluate((node, value) => {
    node.value = String(value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, milliseconds);
  await expect(page.locator('#sequence-motion-stop-value')).toHaveText(`${milliseconds} ms`);
  await page.locator('.sequence-motion-options > summary').click();
}

test('Sequence transport colors and Auto timing follow the selected Gate source', async ({ page }) => {
  await openSequence(page);
  const color = selector => page.locator(selector).evaluate(node => getComputedStyle(node).backgroundColor);
  const songColor = await color('#song-toggle');
  for (const selector of ['#play-all', '#play-1']) {
    expect(await color(selector)).toBe(songColor);
  }
  // Sequence Record／Play use recorder colours: red ● and green ▶, both distinct from the Song buttons.
  const recordColor = await color('#record-toggle'), playColor = await color('#sequence-panel');
  expect(new Set([songColor, recordColor, playColor]).size).toBe(3);
  await page.locator('#play-all').hover();
  const hoverColor = await color('#play-all');
  expect(hoverColor).not.toBe(songColor);
  await page.locator('#song-toggle').hover();
  expect(await color('#song-toggle')).toBe(hoverColor);
  expect(await color('#play-2')).not.toBe(songColor);
  await page.locator('#play-all').click();
  await expect(page.locator('#play-all')).toHaveAttribute('aria-pressed', 'true');
  const activeColor = await color('#play-all');
  expect(activeColor).not.toBe(songColor);
  expect(await color('#play-1')).toBe(activeColor);
  expect(await color('#sequence-panel')).not.toBe(playColor);
  await page.locator('#play-all').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await color('#record-toggle')).not.toBe(recordColor);
  await page.locator('#record-toggle').click();

  const ton = page.locator('#ton'), repeat = page.locator('#trepeat');
  const sliders = page.locator('[data-numeric-control="ton"] input[type="range"], [data-numeric-control="trepeat"] input[type="range"]');
  await expect(ton).toBeEnabled(); await expect(repeat).toBeEnabled();
  await ton.fill('270'); await ton.press('Tab');
  await repeat.fill('610'); await repeat.press('Tab');
  await page.locator('#source-recorded').click();
  await expect(ton).toBeDisabled(); await expect(repeat).toBeDisabled();
  for (const slider of await sliders.all()) await expect(slider).toBeDisabled();
  const disabledOpacity = await page.locator('[data-numeric-control="ton"]').evaluate(node => getComputedStyle(node).opacity);
  expect(Number(disabledOpacity)).toBeLessThan(1);
  await page.locator('#source-auto').click();
  await expect(ton).toBeEnabled(); await expect(repeat).toBeEnabled();
  await expect(ton).toHaveValue('270'); await expect(repeat).toHaveValue('610');
  for (const slider of await sliders.all()) await expect(slider).toBeEnabled();
});

test('Pitch controls retain one row with a wider track and responsive press states', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openSequence(page);
  const options = page.locator('.sequence-motion-options > summary');
  await expect(options).toHaveAttribute('aria-label', 'Options');
  await options.focus(); await options.press('Enter');
  await expect(page.locator('#sequence-motion-stop')).toBeVisible();
  await options.press('Enter');
  await expect(page.locator('#sequence-motion-stop')).toBeHidden();
  const layout = await page.locator('.pitch-performance').evaluate(row => {
    const box = selector => row.querySelector(selector).getBoundingClientRect();
    return { track: box('#sequence-pitch-track'), gate: box('#sequence-separate-gate'), separate: box('#sequence-separate'),
      center: box('#sequence-pitch-center'), motion: box('#sequence-motion'), options: box('.sequence-motion-options > summary') };
  });
  expect(layout.track.width).toBeGreaterThanOrEqual(540);
  expect(layout.gate.right).toBeLessThan(layout.track.left);
  expect(layout.track.right).toBeLessThan(layout.center.left);
  expect(layout.center.top + layout.center.height / 2).toBe(layout.track.top + layout.track.height / 2);
  expect(layout.motion.top).toBe(layout.options.top);
  expect(layout.separate.top + layout.separate.height / 2).toBe(layout.motion.top + layout.motion.height / 2);
  const lock = page.locator('#sequence-length-lock');
  await lock.click();
  const activeBackground = await lock.evaluate(node => getComputedStyle(node).backgroundColor);
  expect(await page.locator('#sequence-motion').evaluate(node => getComputedStyle(node).backgroundColor)).toBe(activeBackground);
  const center = page.locator('#sequence-pitch-center');
  const normalBackground = await center.evaluate(node => getComputedStyle(node).backgroundColor);
  const bounds = await center.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  expect(await center.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(activeBackground);
  await page.mouse.up();
  await page.mouse.move(bounds.x - 10, bounds.y - 10);
  expect(await center.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(normalBackground);
  await center.focus(); await page.keyboard.down('Space');
  expect(await center.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(activeBackground);
  await page.keyboard.up('Space');
  expect(await center.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(normalBackground);
});

test('slide Gate has a large edge-safe target and distinguishes release motion from a stop', async ({ page }) => {
  await openSequence(page);
  await setStopTime(page, 400);
  const pitch = page.locator('#sequence-pitch-input');
  const gate = page.locator('#record-gate');
  const track = page.locator('#sequence-pitch-track');
  for (const value of ['-1', '1', '0']) {
    await pitch.evaluate((node, next) => { node.value = next; node.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    const buttonBox = await gate.boundingBox();
    const trackBox = await track.boundingBox();
    expect(buttonBox.width).toBe(56); expect(buttonBox.height).toBe(56);
    expect(buttonBox.x).toBeGreaterThanOrEqual(trackBox.x - 1);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(trackBox.x + trackBox.width + 1);
  }
  const trackBox = await track.boundingBox();
  const center = await gate.boundingBox();
  const y = center.y + center.height / 2;
  await page.mouse.move(center.x + center.width / 2, y); await page.mouse.down();
  await expect(gate).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(trackBox.x + trackBox.width - 28, y, { steps: 6 }); await page.mouse.up();
  await expect(gate).toHaveAttribute('aria-pressed', 'false');
  expect(Number(await pitch.inputValue())).toBe(0);

  const reset = await gate.boundingBox();
  await page.mouse.move(reset.x + reset.width / 2, y); await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width - 28, y, { steps: 6 });
  await page.waitForTimeout(430); await page.mouse.up();
  expect(Number(await pitch.inputValue())).toBeGreaterThan(.9);

  await page.mouse.move(trackBox.x + 28, y); await page.mouse.down();
  await expect(gate).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
  expect(Number(await pitch.inputValue())).toBeLessThan(-.9);

  await page.locator('#sequence-motion').click();
  await expect(page.locator('#sequence-motion')).toHaveText('Motion OFF');
  const left = await gate.boundingBox();
  await page.mouse.move(left.x + left.width / 2, y); await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width - 28, y, { steps: 6 }); await page.mouse.up();
  expect(Number(await pitch.inputValue())).toBeGreaterThan(.9);
  await page.reload(); await page.locator('#trigger-menu').click();
  await expect(page.locator('#sequence-motion')).toHaveText('Motion OFF');
  await expect(page.locator('#sequence-motion-stop-value')).toHaveText('400 ms');
});

test('Pitch recording retains the immediate return and reloads without a Gate recording', async ({ page }) => {
  await openSequence(page);
  await setStopTime(page, 400);
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await page.locator('#record-length').fill('1');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const gate = await page.locator('#record-gate').boundingBox();
  const track = await page.locator('#sequence-pitch-track').boundingBox();
  const y = gate.y + gate.height / 2;
  await page.mouse.move(gate.x + gate.width / 2, y); await page.mouse.down();
  await page.mouse.move(track.x + track.width - 28, y, { steps: 8 });
  await page.waitForTimeout(30); await page.mouse.up();
  expect(Number(await page.locator('#sequence-pitch-input').inputValue())).toBe(0);
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  const points = saved.pitchPatterns[0].recording.points;
  expect(points.some(point => point.valueNormalized > .5)).toBe(true);
  expect(points.at(-1).valueNormalized).toBe(0);
  expect(points.every((point, index) => index === 0 || point.timeSec > points[index - 1].timeSec)).toBe(true);
  expect(saved.gatePatterns[0].recording).toBeNull();

  await page.locator('#timbre-file-1').setInputFiles({ name: 'slide-gate.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  expect((await saveTimbre(page)).pitchPatterns[0].recording.points).toEqual(points);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.slideGatePlayback = [];
    const original = AudioEngine.prototype.setSequencePitch;
    AudioEngine.prototype.setSequencePitch = function (...args) {
      window.slideGatePlayback.push(args[1]);
      return original.apply(this, args);
    };
  });
  await page.locator('#sequence-panel').click();
  await expect.poll(() => page.evaluate(() => {
    const values = window.slideGatePlayback;
    const peak = values.findIndex(value => value > .5);
    return peak >= 0 && values.slice(peak + 1).some(value => value === 0);
  })).toBe(true);
});

test('one slide Gate gesture records both independent lanes in Both mode', async ({ page }) => {
  await openSequence(page);
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-length').fill('1');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const gate = await page.locator('#record-gate').boundingBox();
  const track = await page.locator('#sequence-pitch-track').boundingBox();
  const y = gate.y + gate.height / 2;
  await page.mouse.move(gate.x + gate.width / 2, y); await page.mouse.down();
  await page.mouse.move(track.x + track.width - 28, y, { steps: 8 });
  await page.waitForTimeout(30); await page.mouse.up();
  await page.locator('#record-toggle').click();
  const timbre = await saveTimbre(page);
  expect(timbre.gatePatterns[0].recording.gates).toHaveLength(1);
  expect(timbre.pitchPatterns[0].recording.points.some(point => point.valueNormalized > .5)).toBe(true);
  expect(timbre.pitchPatterns[0].recording.points.at(-1).valueNormalized).toBe(0);
});

test('dragging Pitch while PC Space holds Gate keeps the Space owner until key release', async ({ page }) => {
  await openSequence(page);
  await page.locator('#sequence-motion').click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down('Space');
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'true');
  const gate = await page.locator('#record-gate').boundingBox();
  const track = await page.locator('#sequence-pitch-track').boundingBox();
  const y = gate.y + gate.height / 2;
  await page.mouse.move(gate.x + gate.width / 2, y); await page.mouse.down();
  await page.mouse.move(track.x + track.width - 28, y, { steps: 6 }); await page.mouse.up();
  expect(Number(await page.locator('#sequence-pitch-input').inputValue())).toBeGreaterThan(.9);
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.up('Space');
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'false');
});

test('slide Gate remains reachable at both ends in iPad and phone-sized layouts', async ({ page }) => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await openSequence(page);
    for (const value of ['-1', '1']) {
      await page.locator('#sequence-pitch-input').evaluate((node, next) => {
        node.value = next; node.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
      await page.locator('#record-gate').scrollIntoViewIfNeeded();
      const gate = await page.locator('#record-gate').boundingBox();
      const track = await page.locator('#sequence-pitch-track').boundingBox();
      expect(gate.width).toBe(56); expect(gate.height).toBe(56);
      expect(gate.x).toBeGreaterThanOrEqual(track.x - 1);
      expect(gate.x + gate.width).toBeLessThanOrEqual(track.x + track.width + 1);
      expect(gate.x + gate.width / 2).toBeGreaterThanOrEqual(0);
      expect(gate.x + gate.width / 2).toBeLessThanOrEqual(viewport.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1);
  }
});

test('pointer cancellation releases the held Gate and restores the starting Pitch', async ({ page }) => {
  await openSequence(page);
  await page.locator('#sequence-pitch-track').evaluate(node => {
    node.addEventListener('pointerdown', event => { window.slideGatePointerId = event.pointerId; }, { once: true });
  });
  const gate = await page.locator('#record-gate').boundingBox();
  const track = await page.locator('#sequence-pitch-track').boundingBox();
  const y = gate.y + gate.height / 2;
  await page.mouse.move(gate.x + gate.width / 2, y); await page.mouse.down();
  await page.mouse.move(track.x + track.width - 28, y, { steps: 6 });
  await page.locator('#sequence-pitch-track').evaluate(node => {
    node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.slideGatePointerId, pointerType: 'mouse' }));
  });
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'false');
  expect(Number(await page.locator('#sequence-pitch-input').inputValue())).toBe(0);
  await page.mouse.up();
});

test('touch tapping the large Gate resumes audio without a delayed held Gate', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openSequence(page);
    const gate = await page.locator('#record-gate').boundingBox();
    const x = gate.x + gate.width / 2, y = gate.y + gate.height / 2;
    await page.touchscreen.tap(x, y);
    await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#status')).toContainText('Audio running');
    await page.touchscreen.tap(x, y);
    await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await context.close();
  }
});

test('loading the held timbre ends its slide Gate before replacing the synth', async ({ page }) => {
  await openSequence(page);
  const timbre = await saveTimbre(page);
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const gate = await page.locator('#record-gate').boundingBox();
  const track = await page.locator('#sequence-pitch-track').boundingBox();
  const y = gate.y + gate.height / 2;
  await page.mouse.move(gate.x + gate.width / 2, y); await page.mouse.down();
  await page.mouse.move(track.x + track.width - 28, y, { steps: 6 });
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#timbre-file-1').setInputFiles({ name: 'replace-held.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre');
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-pressed', 'false');
  expect(Number(await page.locator('#sequence-pitch-input').inputValue())).toBe(0);
  await page.mouse.up();
});
