import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page, id = '1') {
  if (!(await page.locator(`#save-${id}`).isVisible())) await page.locator(`#select-${id}`).click();
  const download = page.waitForEvent('download');
  await page.locator(`#save-${id}`).click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function setNumber(page, selector, value) {
  await page.locator(selector).evaluate((node, target) => {
    const slider = node.closest('.numeric-control').querySelector('input[type="range"]');
    const min = Number(node.dataset.sliderMin ?? node.dataset.numericMin);
    const max = Number(node.dataset.sliderMax ?? node.dataset.numericMax);
    const position = node.dataset.numericScale === 'log1p' ? Math.log1p(target) / Math.log1p(max)
      : (target - min) / (max - min);
    slider.value = String(position * 10000); slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test('Pitch settings change while recording: a held Pitch takes the new steps, and earlier input keeps its grid', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const controller = ChannelSynth.prototype.setControllerPitch;
    ChannelSynth.prototype.setControllerPitch = function (...args) { window.__sequenceSynth = this; return controller.apply(this, args); };
  });
  await page.locator('#trigger-menu').click();
  await setNumber(page, '#sequence-pitch-scale', 600);
  await page.locator('#sequence-pitch-mode').selectOption('equal');
  await setNumber(page, '#sequence-pitch-steps', 3);
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await page.locator('#record-length').fill('3');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');

  for (const selector of ['#sequence-pitch-mode', '#sequence-pitch-steps', '#sequence-pitch-scale', '#sequence-filter-amount', '#sequence-filter-wide'])
    await expect(page.locator(selector)).toBeEnabled();
  // Play/Rec Speed is the recording clock.
  await expect(page.locator('#sequence-play-speed')).toBeDisabled();

  const input = page.locator('#sequence-pitch-input');
  await input.evaluate(node => { node.value = '.66'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#sequence-pitch-readout')).toHaveText('400 cent');
  await expect.poll(() => page.evaluate(() => window.__sequenceSynth.getSequencePitchCent())).toBeCloseTo(400, 0);
  await page.waitForTimeout(80);
  // Without moving the slider, the held Pitch is heard and recorded on the new grid.
  await setNumber(page, '#sequence-pitch-steps', 2);
  await expect(page.locator('#sequence-pitch-ticks span')).toHaveCount(5);
  await expect(page.locator('#sequence-pitch-readout')).toHaveText('300 cent');
  await expect.poll(() => page.evaluate(() => window.__sequenceSynth.getSequencePitchCent())).toBeCloseTo(300, 0);
  await setNumber(page, '#sequence-filter-amount', 1200);
  await page.waitForTimeout(80);
  await input.dispatchEvent('change');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording complete');

  const saved = await saveTimbre(page);
  const points = saved.pitchPatterns[0].recording.points;
  expect(points.some(point => point.valueNormalized === 2 / 3)).toBe(true);
  expect(points.some(point => point.valueNormalized === .5)).toBe(true);
  expect(saved.pitchPatterns[0].pitchMode).toMatchObject({ kind: 'stepped', stepsPerSide: 2, scale: 'equal' });
  expect(saved.pitchPatterns[0].filterAmountCent).toBe(1200);
});

test('Rec during a Stretch Play All starts on the next bar head: the backing runs on and the target plays until then', async ({ page }) => {
  await page.addInitScript(() => {
    window.clickStarts = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when = 0) {
      if (this.type === 'triangle') window.clickStarts.push(when);
      return start.call(this, when);
    };
  });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const base = await saveTimbre(page);
  const user = gates => {
    const timbre = structuredClone(base);
    timbre.gatePatterns[0].recording = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5, gates };
    timbre.sequence.gateMode = 'user'; timbre.sequence.stretch = true;
    return timbre;
  };
  // 240 BPM: one bar is 1 s. The target has a mid-bar Gate; both loop 1 bar.
  for (const [id, timbre] of [['1', user([{ onSec: 0, offSec: .05 }, { onSec: .25, offSec: .3 }])], ['2', user([{ onSec: 0, offSec: .05 }])]]) {
    await page.locator(`#timbre-file-${id}`).setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
    await expect(page.locator('#patch-status')).toContainText(`Loaded timbre ${id}:`);
  }
  await page.locator('#select-1').click();
  await page.locator('#trigger-menu').click();
  await page.locator('#time-mode-bars').click();
  await page.locator('#sequence-stretch-bpm').fill('240');
  await page.locator('#sequence-stretch-bpm').dispatchEvent('change');
  await page.locator('#record-mode + .segmented-choice [data-value="gate"]').click();
  await page.locator('#record-write-mode + .segmented-choice [data-value="replace"]').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.stretchOns = [];
    const gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.labEngine = this; window.stretchOns.push({ id, time }); return gate.call(this, id, time); };
  });
  await page.locator('#play-all').click();
  const ons = id => page.evaluate(target => window.stretchOns.filter(item => item.id === target && item.time !== undefined).map(item => item.time), id);
  await expect.poll(async () => (await ons('2')).length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  const head = (await ons('2'))[0];
  const now = () => page.evaluate(() => window.labEngine.context.currentTime);
  // Press Rec early in a bar, before the target's mid-bar Gate.
  while (true) { const phase = ((await now()) - head) % 1; if (phase > .05 && phase < .2) break; await page.waitForTimeout(20); }
  const pressed = await now();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording · waiting for the next bar');
  const barHead = head + Math.ceil(pressed - head);
  // A Gate pressed while waiting and held past the bar head is recorded from the start of the selection.
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  while ((await now()) < barHead + .25) await page.waitForTimeout(20);
  await expect(page.locator('#record-status')).toContainText('Recording · Loop · Replace');
  await page.mouse.up();
  await expect.poll(async () => (await ons('2')).length, { timeout: 5000 }).toBeGreaterThanOrEqual(Math.round(barHead - head) + 3);
  await page.locator('#record-toggle').click();
  await page.locator('#play-all').click();

  // The backing never restarted: its bar heads stay 1 s apart.
  const backing = await ons('2');
  for (let index = 1; index < backing.length; index += 1) expect(backing[index] - backing[index - 1]).toBeCloseTo(1, 6);
  // The target's old playback kept its mid-bar Gate after Rec was pressed.
  expect((await ons('1')).some(time => time > pressed && Math.abs(time - (barHead - .5)) < 1e-6)).toBe(true);
  // Clicks begin on the bar head.
  const clicks = (await page.evaluate(() => window.clickStarts)).filter(time => time > pressed);
  expect(clicks[0]).toBeCloseTo(barHead, 6);
  const saved = await saveTimbre(page, '1');
  const recorded = saved.gatePatterns[0].recording.gates;
  expect(recorded).toHaveLength(1);
  expect(recorded[0].onSec).toBe(0);
  expect(recorded[0].offSec).toBeGreaterThan(.1);
});

test('changing Pitch settings during a Stretch recording keeps the monitor on the recording clock', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const target = await saveTimbre(page);
  // A 2.30 s Gate selection fitted to 1 bar (2.00 s at 120 BPM).
  target.gatePatterns[0].recording = { durationSec: 2.3, selectionStartSec: 0, selectionEndSec: 2.3, gates: [{ onSec: 0, offSec: .05 }] };
  target.sequence.gateMode = 'user'; target.sequence.stretch = true;
  await page.locator('#timbre-file-1').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(target)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  await page.locator('#trigger-menu').click();
  await page.locator('#time-mode-bars').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.stretchOns = [];
    const gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.stretchOns.push({ id, time }); return gate.call(this, id, time); };
  });
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  const ons = () => page.evaluate(() => window.stretchOns.filter(item => item.id === '1' && item.time !== undefined).map(item => item.time));
  await expect.poll(async () => (await ons()).length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  await setNumber(page, '#sequence-filter-amount', 1200);
  await page.locator('#sequence-pitch-mode').selectOption('major');
  await expect.poll(async () => (await ons()).length, { timeout: 9000 }).toBeGreaterThanOrEqual(4);
  const times = await ons();
  await page.locator('#record-toggle').click();
  for (let index = 1; index < times.length; index += 1) expect(times[index] - times[index - 1]).toBeCloseTo(2, 6);
});

test('BPM and the time mode stay locked while recording, and a BPM edit then changes nothing', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await page.locator('#time-mode-bars').click();
  await expect(page.locator('#header-bpm')).toBeEnabled();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording');
  for (const selector of ['#header-bpm', '#song-bpm', '#song-bpm-slider', '#sequence-stretch-bpm', '#sequence-stretch-bars', '#time-mode-seconds', '#time-mode-bars'])
    await expect(page.locator(selector)).toBeDisabled();
  // The Frame field is locked through its fieldset.
  await expect(page.locator('#song-frame')).toBeDisabled();
  // Even if an event reaches it, the field leaves the BPM alone.
  await page.locator('#header-bpm').evaluate(node => { node.disabled = false; node.value = '125'; node.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#record-toggle').click();
  await expect(page.locator('#header-bpm')).toBeEnabled();
  await expect(page.locator('#time-mode-seconds')).toBeEnabled();
  // The BPM never changed: unlocking shows 120 again.
  await expect(page.locator('#header-bpm')).toHaveValue('120');
  await expect(page.locator('#sequence-stretch-bpm')).toHaveValue('120');
});

test('in Seconds, a timbre started during a recording starts at once, not on a hidden bar head (ADR 0010)', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  const backing = await saveTimbre(page);
  backing.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: 0, offSec: .05 }] };
  backing.sequence.gateMode = 'user';
  await page.locator('#timbre-file-2').setInputFiles({ name: 'backing.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backing)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 2:');
  await page.locator('#select-1').click();
  await page.locator('#trigger-menu').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.secondsOns = [];
    const settings = AudioEngine.prototype.getSongSettings;
    AudioEngine.prototype.getSongSettings = function () { window.labEngine = this; return settings.call(this); };
    const gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.labEngine = this; window.secondsOns.push({ id, time }); return gate.call(this, id, time); };
  });
  // A new 30 s Pattern: at 120 BPM a hidden bar head would be up to 2 s away.
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.waitForTimeout(500);
  const pressed = await page.evaluate(() => window.labEngine.context.currentTime);
  await page.locator('#play-2').click();
  await expect.poll(() => page.evaluate(() => window.secondsOns.filter(item => item.id === '2').length), { timeout: 3000 }).toBeGreaterThanOrEqual(1);
  const first = await page.evaluate(() => window.secondsOns.find(item => item.id === '2').time);
  // Before the change the first Gate waited for the next 2 s bar head of the recording loop.
  expect(first - pressed).toBeLessThan(.3);
  await page.locator('#record-toggle').click();
  await page.locator('#play-2').click();
});
