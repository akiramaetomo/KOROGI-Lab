import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page, id = '1') {
  if (!(await page.locator(`#save-${id}`).isVisible())) await page.locator(`#select-${id}`).click();
  const download = page.waitForEvent('download');
  await page.locator(`#save-${id}`).click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}
async function loadTimbre(page, id, timbre) {
  await page.locator(`#timbre-file-${id}`).setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText(`Loaded timbre ${id}:`);
}

test('Bars fits every timbre to its bars and Play All keeps them together; files carry the time mode (ADR 0010)', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  const base = await saveTimbre(page);
  expect(base.sequence.stretch).toBe(false);
  const user = length => {
    const timbre = structuredClone(base);
    timbre.gatePatterns[0].recording = { durationSec: length, selectionStartSec: 0, selectionEndSec: length, gates: [{ onSec: 0, offSec: .05 }] };
    timbre.sequence.gateMode = 'user';
    return timbre;
  };
  await loadTimbre(page, '1', user(.5));
  await loadTimbre(page, '2', user(.75));
  await page.locator('#select-1').click();
  await page.locator('#trigger-menu').click();
  // Seconds: tape-like, no BPM and no bars frame.
  await expect(page.locator('#time-mode-seconds')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#header-bpm')).toBeHidden();
  await expect(page.locator('#sequence-stretch-group')).toBeHidden();
  await expect(page.locator('#sequence-play-speed')).toBeEnabled();
  // The longest Pattern 1 recording (0.75 s at 120 BPM) rounds to the 1 bar it already has, so nothing is asked.
  await page.locator('#time-mode-bars').click();
  await expect(page.locator('#time-mode-bars')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sequence-stretch-group')).toBeVisible();
  await expect(page.locator('#sequence-play-speed')).toBeDisabled();
  // 240 BPM: one bar is 1 s. The 0.5 s selection plays at half speed.
  await page.locator('#header-bpm').fill('240');
  await page.locator('#header-bpm').dispatchEvent('change');
  await expect(page.locator('#sequence-stretch-bpm')).toHaveValue('240');
  await expect(page.locator('#sequence-stretch-readout')).toHaveText('Pattern 1 · 1.00 s · ×0.50');

  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.stretchOns = [];
    const gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.stretchOns.push({ id, time }); return gate.call(this, id, time); };
  });
  await page.locator('#play-all').click();
  await expect.poll(() => page.evaluate(() => window.stretchOns.filter(item => item.id === '2').length), { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#loop-drift-warning')).toBeHidden();
  const ons = await page.evaluate(() => window.stretchOns);
  await page.locator('#play-all').click();
  const times = id => ons.filter(item => item.id === id).map(item => item.time);
  const one = times('1'), two = times('2');
  expect(one[0]).toBeCloseTo(two[0], 6);
  for (const lane of [one, two]) for (let index = 1; index < Math.min(3, lane.length); index += 1) expect(lane[index] - lane[index - 1]).toBeCloseTo(1, 6);

  expect((await saveTimbre(page, '1')).sequence.stretch).toBe(true);
  await page.locator('#time-mode-seconds').click();
  await expect(page.locator('#sequence-stretch-group')).toBeHidden();
  expect((await saveTimbre(page, '1')).sequence.stretch).toBe(false);
});

/** Logs Gate ONs (with the engine) and click oscillator starts so the recording clock can be checked numerically. */
async function watchTiming(page) {
  await page.addInitScript(() => {
    window.clickStarts = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when = 0) {
      if (this.type === 'triangle') window.clickStarts.push(when);
      return start.call(this, when);
    };
  });
}
async function hookGateOns(page) {
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.stretchOns = [];
    const gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.labEngine = this; window.stretchOns.push({ id, time }); return gate.call(this, id, time); };
  });
}
const now = page => page.evaluate(() => window.labEngine.context.currentTime);

test('a Stretch recording laps on the bar: monitor, Pitch lane, click and backing share it, and input is stored in recorded seconds', async ({ page }) => {
  await watchTiming(page);
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const base = await saveTimbre(page);
  // Timbre 1: a 2.30 s Gate and a 1.00 s Pitch selection, both fitted to 1 bar (2.00 s at 120 BPM).
  const target = structuredClone(base);
  target.gatePatterns[0].recording = { durationSec: 2.3, selectionStartSec: 0, selectionEndSec: 2.3, gates: [{ onSec: 0, offSec: .05 }] };
  target.pitchPatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1, valueNormalized: .5 }] };
  target.sequence.gateMode = 'user'; target.sequence.stretch = true;
  const backing = structuredClone(base);
  backing.gatePatterns[0].recording = { durationSec: .75, selectionStartSec: 0, selectionEndSec: .75, gates: [{ onSec: 0, offSec: .05 }] };
  backing.sequence.gateMode = 'user'; backing.sequence.stretch = true;
  await loadTimbre(page, '1', target);
  await loadTimbre(page, '2', backing);
  await page.locator('#select-1').click();
  await page.locator('#trigger-menu').click();
  // A timbre file's Stretch does not set the app-wide mode; Bars does. 2.30 s at 120 BPM rounds to the current 1 bar.
  await page.locator('#time-mode-bars').click();
  await expect(page.locator('#record-grid')).toHaveAttribute('data-bars', '1');
  await expect(page.locator('#record-grid')).toBeVisible();
  await expect(page.locator('#pitch-grid')).toBeVisible();
  await expect(page.locator('#record-new-length')).toBeHidden();

  await hookGateOns(page);
  await page.locator('#play-2').click();
  await expect.poll(() => page.evaluate(() => window.stretchOns.length)).toBeGreaterThanOrEqual(1);
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await expect.poll(() => page.evaluate(() => window.stretchOns.filter(item => item.id === '1').length), { timeout: 6000 }).toBeGreaterThanOrEqual(2);
  const head = (await page.evaluate(() => window.stretchOns.find(item => item.id === '1'))).time;
  // Press mid-lap so the new Gate does not touch the old one at 0.
  while (true) { const phase = ((await now(page)) - head) % 2; if (phase > .6 && phase < 1.1) break; await page.waitForTimeout(40); }
  const counter = await page.locator('#record-counter').textContent();
  const laps = [...counter.matchAll(/Lap (\d+)/g)].map(match => match[1]);
  expect(laps).toHaveLength(2);
  expect(laps[0]).toBe(laps[1]);
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await now(page); await page.mouse.down(); const after = await now(page);
  await page.waitForTimeout(150); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.stretchOns.filter(item => item.id === '1' && item.time !== undefined).length), { timeout: 8000 }).toBeGreaterThanOrEqual(4);
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording complete');

  const ons = await page.evaluate(() => window.stretchOns);
  await page.locator('#play-2').click();
  // The monitor laps every 2.00 s (not 2.30 s), on the backing timbre's bar heads.
  const monitor = ons.filter(item => item.id === '1' && item.time !== undefined).map(item => item.time);
  const heads = monitor.filter(time => Math.abs(((time - head) % 2 + 2) % 2) < 1e-6 || Math.abs(((time - head) % 2) - 2) < 1e-6);
  expect(heads.length).toBeGreaterThanOrEqual(3);
  for (let index = 1; index < heads.length; index += 1) expect(heads[index] - heads[index - 1]).toBeCloseTo(2, 6);
  const backingOns = ons.filter(item => item.id === '2' && item.time >= head - 1e-6).map(item => item.time);
  expect(backingOns[0]).toBeCloseTo(head, 6);
  // Clicks keep a steady quarter across lap boundaries: no bar is cut short.
  const clicks = (await page.evaluate(() => window.clickStarts)).filter(time => time >= head - 1e-6).slice(0, 10);
  expect(clicks.length).toBeGreaterThanOrEqual(6);
  for (let index = 1; index < clicks.length; index += 1) expect(clicks[index] - clicks[index - 1]).toBeCloseTo(.5, 6);

  // The input maps back to recorded seconds at 2.30 ÷ 2.00 = 1.15 recorded s per real s.
  const saved = await saveTimbre(page, '1');
  const gates = saved.gatePatterns[0].recording.gates;
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBe(2.3);
  expect(gates).toHaveLength(2);
  const expected = [before, after].map(time => (((time - head) % 2 + 2) % 2) * 1.15);
  expect(gates[1].onSec).toBeGreaterThan(expected[0] - .03);
  expect(gates[1].onSec).toBeLessThan(expected[1] + .03);
  expect(gates[1].offSec - gates[1].onSec).toBeGreaterThan(.1 * 1.15);
});

test('a new Stretch Pattern records the Stretch bars and leaves the shared bar count alone', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#record-toggle')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  await page.locator('#trigger-menu').click();
  await page.locator('#record-length').fill('3'); await page.locator('#record-length').dispatchEvent('change');
  await expect(page.locator('#record-new-length')).toHaveJSProperty('disabled', false);
  await page.locator('#time-mode-bars').click();
  await page.locator('#sequence-stretch-bars').selectOption('2');
  // A Null Pattern has no recorded seconds, so no ratio.
  await expect(page.locator('#sequence-stretch-readout')).toHaveText('Pattern 1 · 4.00 s');
  await expect(page.locator('#record-new-length')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#record-new-length')).toBeHidden();
  await expect(page.locator('#record-grid')).toHaveAttribute('data-bars', '2');
  await expect(page.locator('#record-end-value')).toHaveText('4.00 s');

  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await expect(page.locator('#record-counter')).toContainText('/ 00:04.00');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording complete');
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(4, 6);
  // New Pattern Length (3 s) was not used and did not overwrite Pattern 1's bars.
  await expect(page.locator('#sequence-stretch-bars')).toHaveValue('2');
  await expect(page.locator('#sequence-stretch-readout')).toHaveText('Pattern 1 · 4.00 s · ×1.00');
  await page.locator('#time-mode-seconds').click();
  await expect(page.locator('#record-new-length')).toBeVisible();
  await expect(page.locator('#record-new-length-title')).toHaveText('New Pattern Length (s)');
});

test('a Stretch Pattern switch during Play All waits for the next bar head', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5, gates: [{ onSec: 0, offSec: .05 }] };
  timbre.gatePatterns[1].recording = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5, gates: [{ onSec: .25, offSec: .3 }] };
  timbre.sequence.gateMode = 'user'; timbre.sequence.stretch = true;
  await loadTimbre(page, '1', timbre);
  await page.locator('#select-1').click();
  await page.locator('#trigger-menu').click();
  await page.locator('#time-mode-bars').click();
  await page.locator('#sequence-stretch-bpm').fill('240');
  await page.locator('#sequence-stretch-bpm').dispatchEvent('change');
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.stretchOns = [];
    const gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.stretchOns.push({ id, time, now: this.context.currentTime }); return gate.call(this, id, time); };
  });
  await page.locator('#play-all').click();
  await expect.poll(() => page.evaluate(() => window.stretchOns.length)).toBeGreaterThanOrEqual(1);
  await page.locator('#source-user-2').click();
  await expect(page.locator('#source-user-2')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.stretchOns.length), { timeout: 5000 }).toBeGreaterThanOrEqual(4);
  const ons = await page.evaluate(() => window.stretchOns.map(item => item.time));
  await page.locator('#play-all').click();
  // Pattern 1 sounds on bar heads; Pattern 2 sounds half a bar later. The bar grid itself never moves.
  const start = ons[0];
  const phases = ons.map(time => (time - start) % 1);
  const switched = phases.findIndex(phase => Math.abs(phase - .5) < 1e-6);
  expect(switched).toBeGreaterThan(0);
  expect(phases.slice(0, switched).every(phase => Math.abs(phase) < 1e-6 || Math.abs(phase - 1) < 1e-6)).toBe(true);
  expect(phases.slice(switched).every(phase => Math.abs(phase - .5) < 1e-6)).toBe(true);
});

test('a quarter-bar Pattern loops on the bar grid with a one-bar Pattern; Bars offers fractions in a menu', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  const base = await saveTimbre(page);
  const user = (pattern, length) => {
    const timbre = structuredClone(base);
    timbre.gatePatterns[pattern - 1].recording = { durationSec: length, selectionStartSec: 0, selectionEndSec: length, gates: [{ onSec: 0, offSec: .05 }] };
    timbre.sequence.gateMode = 'user'; timbre.sequence.gateUserId = `user-${pattern}`;
    return timbre;
  };
  await loadTimbre(page, '1', user(1, 2));
  await loadTimbre(page, '2', user(3, .5));
  await page.locator('#select-2').click();
  await page.locator('#trigger-menu').click();
  // 120 BPM: the 2.00 s Pattern 1 stays 1 bar; the 0.50 s Pattern 3 becomes 1/4 bar.
  let confirmation = '';
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
  await page.locator('#time-mode-bars').click();
  expect(confirmation).toContain('Pattern 3: 1 → 1/4 bars');
  expect(confirmation).not.toContain('Pattern 1:');
  await expect(page.locator('#sequence-stretch-bars')).toHaveValue('1/4');
  await expect(page.locator('#sequence-stretch-readout')).toHaveText('Pattern 3 · 0.50 s · ×1.00');

  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.stretchOns = [];
    const gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.stretchOns.push({ id, time }); return gate.call(this, id, time); };
  });
  await page.locator('#play-all').click();
  await expect.poll(() => page.evaluate(() => window.stretchOns.filter(item => item.id === '1').length), { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#loop-drift-warning')).toBeHidden();
  const ons = await page.evaluate(() => window.stretchOns);
  await page.locator('#play-all').click();
  const times = id => ons.filter(item => item.id === id).map(item => item.time);
  const one = times('1'), quarter = times('2');
  expect(quarter[0]).toBeCloseTo(one[0], 6);
  for (let index = 1; index < one.length; index += 1) expect(one[index] - one[index - 1]).toBeCloseTo(2, 6);
  for (let index = 1; index < quarter.length; index += 1) expect(quarter[index] - quarter[index - 1]).toBeCloseTo(.5, 6);
  // Every bar head of the one-bar Pattern meets a quarter-bar lap.
  for (const time of one.filter(time => time <= quarter.at(-1))) expect(quarter.some(item => Math.abs(item - time) < 1e-6)).toBe(true);

  // The Bars menu lists only allowed counts: four fractions, then 1 to 32.
  const bars = page.locator('#sequence-stretch-bars');
  const frame = await page.locator('#song-frame').inputValue();
  const choices = await bars.locator('option').allTextContents();
  expect(choices.slice(0, 6)).toEqual(['1/16', '1/8', '1/4', '1/2', '1', '2']);
  expect(choices.at(-1)).toBe('32');
  expect(choices).not.toContain('1/3');
  await bars.selectOption('1/8');
  await expect(bars).toHaveValue('1/8');
  // Pattern bars belong to the timbre (ADR 0011): the Song Frame keeps its whole bars.
  await expect(page.locator('#song-frame')).toHaveValue(frame);
  await expect(page.locator('#song-frame option')).toHaveCount(32);

  // Quantize takes only the grids that divide the Pattern.
  await page.locator('.gate-quantize-details summary').click();
  await bars.selectOption('1/4');
  await page.locator('#gate-quantize-grid').selectOption('4');
  await expect(page.locator('#gate-quantize')).toBeEnabled();
  await bars.selectOption('1/16');
  await expect(page.locator('#gate-quantize-grid option[value="4"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#gate-quantize-grid option[value="8"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#gate-quantize-grid option[value="16"]')).toHaveJSProperty('disabled', false);
  await expect(page.locator('#gate-quantize')).toBeDisabled();
  await page.locator('#gate-quantize-grid').selectOption('16');
  await expect(page.locator('#gate-quantize')).toBeEnabled();
});

test('Seconds Play All warns of drift only when loop periods are not whole multiples', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  const base = await saveTimbre(page);
  const user = length => {
    const timbre = structuredClone(base);
    timbre.gatePatterns[0].recording = { durationSec: length, selectionStartSec: 0, selectionEndSec: length, gates: [{ onSec: 0, offSec: .05 }] };
    timbre.sequence.gateMode = 'user';
    return timbre;
  };
  await loadTimbre(page, '1', user(2));
  await loadTimbre(page, '2', user(.5));
  await expect(page.locator('#time-mode-seconds')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#sequence-open').click(); await page.locator('#play-all').click();
  await expect(page.locator('#play-all')).toHaveAttribute('aria-pressed', 'true');
  // 2.00 s is four 0.50 s laps: no drift.
  await page.waitForTimeout(300);
  await expect(page.locator('#loop-drift-warning')).toBeHidden();
  await page.locator('#play-all').click();
  // 0.503 s drifts 12 ms against 2.00 s every lap.
  await loadTimbre(page, '2', user(.503));
  await page.locator('#play-all').click();
  await expect(page.locator('#loop-drift-warning')).toBeVisible();
  await expect(page.locator('#loop-drift-warning')).toHaveAttribute('title', /Timbre 1 Gate 2\.000 s, Timbre 2 Gate 0\.503 s/);
  await page.locator('#play-all').click();
});

test('the Bars readout notes when Song fits a Pattern longer than the Frame; Play All keeps its bars (ADR 0011)', async ({ page }) => {
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
    await page.locator('#trigger-menu').click();
    await page.locator('#time-mode-bars').click();
    const readout = page.locator('#sequence-stretch-readout'), note = readout.locator('.stretch-song-fit');
    await expect(page.locator('#song-frame')).toHaveValue('4');
    await page.locator('#sequence-stretch-bars').selectOption('8');
    // 8 bars at 120 BPM: Play All loops 16 s; Song fits the Pattern to the 4-bar Frame.
    await expect(readout).toHaveText('Pattern 1 · 16.00 s · Chain: 4 bars');
    await expect(note).toBeVisible();
    const colors = await readout.evaluate(node => [getComputedStyle(node).color, getComputedStyle(node.querySelector('.stretch-song-fit')).color]);
    expect(colors[1]).not.toBe(colors[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.locator('#sequence-stretch-bars').selectOption('4');
    await expect(readout).toHaveText('Pattern 1 · 8.00 s');
    await expect(note).toHaveCount(0);
    // A longer Frame takes the Pattern whole, so the note goes away.
    await page.locator('#sequence-stretch-bars').selectOption('8');
    await page.locator('#song-frame').selectOption('8');
    await expect(readout).toHaveText('Pattern 1 · 16.00 s');
  }
});
