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

async function loadPattern(page) {
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5,
    gates: [{ onSec: .05, offSec: .45 }] };
  timbre.pitchPatterns[0].recording = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5,
    points: [{ timeSec: 0, valueNormalized: .4 }, { timeSec: .5, valueNormalized: .4 }] };
  await page.locator('#timbre-file-1').setInputFiles({ name: 'separate.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  if (!await page.locator('#sequence-separate').isVisible()) await page.locator('#trigger-menu').click();
  return timbre;
}

async function probeController(page) {
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.separateProbe = { gateOn: 0, gateOff: 0, pitchOn: 0, pitchOff: 0, sequencedGateOn: 0,
      events: [], engine: null };
    for (const [method, key] of [['controllerGateOn', 'gateOn'], ['controllerGateOff', 'gateOff'],
      ['controllerPitchOn', 'pitchOn'], ['controllerPitchOff', 'pitchOff']]) {
      const original = AudioEngine.prototype[method];
      AudioEngine.prototype[method] = function (...args) {
        window.separateProbe[key] += 1;
        window.separateProbe.engine = this;
        if (method === 'controllerGateOn' && !window.separateProbe.listening) {
          window.separateProbe.listening = true;
          this.getChannel(args[0]).addGateScheduleListener(event => window.separateProbe.events.push(event));
        }
        return original.apply(this, args);
      };
    }
    const originalGateOn = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (...args) {
      window.separateProbe.sequencedGateOn += 1;
      window.separateProbe.engine = this;
      return originalGateOn.apply(this, args);
    };
  });
}

async function holdTrack(page, ratio = .8) {
  const track = page.locator('#sequence-pitch-track');
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  await page.mouse.move(box.x + 28 + (box.width - 56) * ratio, box.y + box.height / 2);
  await page.mouse.down();
}

test('Separate moves Gate from the slide thumb to an independent button', async ({ page }) => {
  await openSequence(page);
  await probeController(page);
  const separate = page.locator('#sequence-separate');
  const gate = page.locator('#sequence-separate-gate');
  await expect(separate).toHaveText('Separate');
  await expect(separate).toHaveAttribute('aria-pressed', 'false');
  await expect(gate).toBeDisabled();
  await holdTrack(page);
  await expect.poll(() => page.evaluate(() => window.separateProbe.gateOn)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.separateProbe.pitchOn)).toBe(1);
  await page.mouse.up();

  await separate.click();
  await expect(separate).toHaveText('Separate');
  await expect(separate).toHaveAttribute('aria-pressed', 'true');
  await expect(gate).toBeEnabled();
  await expect(page.locator('#record-gate')).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => window.separateProbe.gateOn)).toBe(2);
  await page.keyboard.up('Space');
  await holdTrack(page, .25);
  await expect.poll(() => page.evaluate(() => window.separateProbe.pitchOn)).toBe(2);
  expect(await page.evaluate(() => window.separateProbe.gateOn)).toBe(2);
  await page.keyboard.down('Space');
  await expect.poll(() => page.evaluate(() => window.separateProbe.gateOn)).toBe(3);
  await page.keyboard.up('Space');
  await page.mouse.up();
  await gate.scrollIntoViewIfNeeded();
  const box = await gate.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.separateProbe.gateOn)).toBe(4);
  expect(await page.evaluate(() => window.separateProbe.pitchOn)).toBe(2);
  await page.mouse.up();
});

test('recorded Gate continues while the separated slider owns only Pitch', async ({ page }) => {
  await openSequence(page);
  await loadPattern(page);
  await probeController(page);
  await page.locator('#sequence-separate').click();
  await page.locator('#sequence-panel').click();
  await expect.poll(() => page.evaluate(() => window.separateProbe.sequencedGateOn)).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.separateProbe.sequencedGateOn);
  await holdTrack(page, .9);
  await expect.poll(() => page.evaluate(() => window.separateProbe.engine?.getSequencePitchCent('1'))).toBeGreaterThan(100);
  await expect.poll(() => page.evaluate(() => window.separateProbe.sequencedGateOn), { timeout: 2000 }).toBeGreaterThan(before);
  expect(await page.evaluate(() => window.separateProbe.gateOn)).toBe(0);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.separateProbe.engine?.getSequencePitchCent('1'))).toBeCloseTo(480, 0);
  await page.locator('#sequence-panel').click();
});

test('Pitch Replace keeps recorded Gate, and Gate Replace keeps recorded Pitch', async ({ page }) => {
  await openSequence(page);
  const original = await loadPattern(page);
  await probeController(page);
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording');
  await holdTrack(page, .85);
  await page.waitForTimeout(110);
  expect(await page.evaluate(() => window.separateProbe.gateOn)).toBe(0);
  await page.mouse.up();
  await page.locator('#record-toggle').click();
  let saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).toEqual(original.gatePatterns[0].recording);
  expect(saved.pitchPatterns[0].recording).not.toEqual(original.pitchPatterns[0].recording);

  await page.locator('#sequence-separate').click();
  await page.locator('#record-mode + .segmented-choice [data-value="gate"]').click();
  await page.locator('#record-toggle').click();
  const gate = page.locator('#sequence-separate-gate');
  await gate.scrollIntoViewIfNeeded();
  const box = await gate.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
  await page.locator('#record-toggle').click();
  const replaced = await saveTimbre(page);
  expect(replaced.pitchPatterns[0].recording).toEqual(saved.pitchPatterns[0].recording);
  expect(replaced.gatePatterns[0].recording).not.toEqual(saved.gatePatterns[0].recording);
});

test('Separate Both recording writes independent Gate and Pitch while locking the mode', async ({ page }) => {
  await openSequence(page);
  const original = await loadPattern(page);
  await probeController(page);
  await page.locator('#sequence-separate').click();
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording');
  await expect(page.locator('#sequence-separate')).toBeDisabled();
  const button = page.locator('#sequence-separate-gate');
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.locator('#sequence-pitch-input').evaluate(node => {
    node.value = '.8'; node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => [window.separateProbe.gateOn, window.separateProbe.pitchOn])).toEqual([1, 1]);
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.locator('#sequence-pitch-input').dispatchEvent('change');
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).not.toEqual(original.gatePatterns[0].recording);
  expect(saved.pitchPatterns[0].recording).not.toEqual(original.pitchPatterns[0].recording);
  await expect(page.locator('#sequence-separate')).toHaveAttribute('aria-pressed', 'true');
});

test('independent Gate excludes recorded Gate events and resumes the current Gate interval', async ({ page }) => {
  await openSequence(page);
  await loadPattern(page);
  await probeController(page);
  await page.locator('#sequence-separate').click();
  await page.locator('#sequence-panel').click();
  await expect.poll(() => page.evaluate(() => window.separateProbe.sequencedGateOn)).toBeGreaterThan(0);
  const button = page.locator('#sequence-separate-gate');
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBe(1);
  await page.waitForTimeout(650); // More than one complete .5 s Gate cycle.
  expect(await page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const engine = window.separateProbe.engine;
    return engine.getChannel('1').baseGateIsOn(engine.context.currentTime);
  })).toBe(true);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBeGreaterThan(1);
  await page.locator('#sequence-panel').click();
});

test('Play All and Play Song retain their Gate while separated Pitch is held', async ({ page }) => {
  await openSequence(page);
  await loadPattern(page);
  await probeController(page);
  await page.locator('#sequence-separate').click();
  for (const start of ['#play-all', '#song-toggle']) {
    await page.locator(start).click();
    await expect(page.locator(start)).toHaveAttribute('aria-pressed', 'true');
    const before = await page.evaluate(() => window.separateProbe.sequencedGateOn);
    await holdTrack(page, .9);
    await expect.poll(() => page.evaluate(() => window.separateProbe.engine?.getSequencePitchCent('1'))).toBeGreaterThan(100);
    await expect.poll(() => page.evaluate(() => window.separateProbe.sequencedGateOn), { timeout: 2000 }).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.separateProbe.gateOn)).toBe(0);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.separateProbe.engine?.getSequencePitchCent('1'))).toBeCloseTo(480, 0);
    await page.locator(start).click();
  }
});

test('Play Song Gate is exclusive while held and returns to its current interval', async ({ page }) => {
  await openSequence(page);
  await loadPattern(page);
  await probeController(page);
  await page.locator('#sequence-separate').click();
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  const button = page.locator('#sequence-separate-gate');
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBe(1);
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const engine = window.separateProbe.engine;
    return engine.getChannel('1').baseGateIsOn(engine.context.currentTime);
  })).toBe(true);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBeGreaterThan(1);
  await page.locator('#song-toggle').click();
});

test('two touches hold independent Gate and Pitch controls together', async ({ page }) => {
  await openSequence(page);
  await probeController(page);
  await page.locator('#sequence-separate').click();
  const gate = await page.locator('#sequence-separate-gate').boundingBox();
  const track = await page.locator('#sequence-pitch-track').boundingBox();
  const touch = await page.context().newCDPSession(page);
  const gatePoint = { x: Math.round(gate.x + gate.width / 2), y: Math.round(gate.y + gate.height / 2), id: 1 };
  const pitchPoint = { x: Math.round(track.x + track.width * .8), y: Math.round(track.y + track.height / 2), id: 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [gatePoint] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [gatePoint, pitchPoint] });
  await expect.poll(() => page.evaluate(() => [window.separateProbe.gateOn, window.separateProbe.pitchOn])).toEqual([1, 1]);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [gatePoint] });
  await expect.poll(() => page.evaluate(() => [window.separateProbe.gateOff, window.separateProbe.pitchOff])).toEqual([1, 0]);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.evaluate(() => window.separateProbe.pitchOff)).toBe(1);
});

test('Auto Gate does not retrigger over an independent controller Gate', async ({ page }) => {
  await openSequence(page);
  await probeController(page);
  await page.locator('#sequence-separate').click();
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'true');
  const button = page.locator('#sequence-separate-gate');
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBe(1);
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length)).toBe(1);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.separateProbe.events.filter(event => event.kind === 'on').length), { timeout: 1500 }).toBeGreaterThan(1);
  await page.locator('#sequence-panel').click();
});

test('Separate keeps Gate and slider reachable without shrinking the Pitch track', async ({ page }) => {
  await openSequence(page);
  await page.locator('#sequence-separate').click();
  for (const width of [390, 820, 1024, 1180]) {
    await page.setViewportSize({ width, height: 820 });
    const bounds = await page.locator('.pitch-performance').evaluate(row => {
      const box = selector => row.querySelector(selector).getBoundingClientRect();
      return { gate: box('#sequence-separate-gate'), track: box('#sequence-pitch-track'), separate: box('#sequence-separate') };
    });
    expect(bounds.gate.width).toBeGreaterThanOrEqual(56);
    expect(bounds.gate.right).toBeLessThan(bounds.track.left);
    expect(bounds.track.width).toBeGreaterThanOrEqual(width >= 1024 ? 540 : 220);
    expect(bounds.separate.width).toBeGreaterThanOrEqual(70);
  }
});

test('separated Pitch thumb shows idle, held, and Gate-only recording states in distinct colors', async ({ page }) => {
  await openSequence(page);
  const thumbColor = () => page.locator('#record-gate').evaluate(node => getComputedStyle(node, '::before').backgroundColor);
  const gateColor = await thumbColor();
  await page.locator('#sequence-separate').click();
  const track = page.locator('#sequence-pitch-track');
  await expect(track).toHaveClass(/pitch-only/);
  const idle = await thumbColor();

  await holdTrack(page, .7);
  await expect(track).toHaveClass(/pitch-held/);
  const held = await thumbColor();
  await page.mouse.up();
  await expect(track).not.toHaveClass(/pitch-held/);
  expect(await thumbColor()).toBe(idle);

  await page.locator('#record-mode + .segmented-choice [data-value="gate"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording');
  await expect(track).toHaveClass(/disabled/);
  const disabled = await thumbColor();
  await page.locator('#record-toggle').click();

  expect(new Set([gateColor, idle, held, disabled]).size).toBe(4);
});
