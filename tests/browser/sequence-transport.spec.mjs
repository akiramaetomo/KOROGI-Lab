import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page, id = '1') {
  const download = page.waitForEvent('download');
  await page.locator(`#save-${id}`).click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}
async function loadTimbre(page, id, timbre) {
  await page.locator(`#timbre-file-${id}`).setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText(`Loaded timbre ${id}:`);
}
function userRecording(timbre, patternId = 'user-1') {
  return timbre.gatePatterns.find(pattern => pattern.id === patternId).recording;
}

test('Play All aligns mixed Auto and User while skipping an empty User source', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  const user = structuredClone(timbre);
  user.gatePatterns[0].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2, gates: [{ onSec: 0, offSec: .05 }] };
  user.sequence.gateMode = 'user';
  await loadTimbre(page, '2', user);
  const empty = structuredClone(user); empty.gatePatterns[0].recording = null;
  await loadTimbre(page, '3', empty);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.sequenceStarts = [];
    const start = AudioEngine.prototype.startAuto, gate = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.startAuto = function (id, time) { window.sequenceStarts.push({ id, time, kind: 'auto' }); return start.call(this, id, time); };
    AudioEngine.prototype.gateOn = function (id, time) { if (id === '2') window.sequenceStarts.push({ id, time, kind: 'user' }); return gate.call(this, id, time); };
  });
  await page.locator('#play-all').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-3')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-all')).toHaveText('Stop All');
  await expect.poll(() => page.evaluate(() => window.sequenceStarts.length)).toBeGreaterThanOrEqual(2);
  const starts = await page.evaluate(() => window.sequenceStarts.slice(0, 2));
  expect(starts.map(item => item.kind)).toEqual(['auto', 'user']);
  expect(starts[0].time).toBe(starts[1].time);
  await page.locator('#play-all').click();
  await expect(page.locator('#play-all')).toHaveText('Play All');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'false');
});

test('source change, recording another slot, replacement, and saved selection', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  const user = structuredClone(timbre);
  user.gatePatterns[0].recording = { durationSec: .4, selectionStartSec: 0, selectionEndSec: .4, gates: [{ onSec: .03, offSec: .13 }] };
  user.sequence.gateMode = 'user';
  await loadTimbre(page, '2', user);
  await page.locator('#play-2').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#trigger-menu').click();
  await page.locator('#source-user-1').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#play-2').click();
  await page.locator('#play-all').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-toggle').click();
  await page.locator('#select-2').click();
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#source-user-1')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#source-auto').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  expect((await saveTimbre(page, '2')).sequence.gateMode).toBe('auto');
  await page.locator('#source-user-1').click();
  expect((await saveTimbre(page, '2')).sequence.gateMode).toBe('auto');
  await page.locator('#source-recorded').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  const download = page.waitForEvent('download');
  await page.locator('#files-menu').click(); await page.locator('#export-patch').click();
  const session = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(session.channels[1].timbre.sequence).toEqual(user.sequence);
  await loadTimbre(page, '2', timbre);
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#source-auto')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#patch-file').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await expect(page.locator('#source-user-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'false');
});

test('Stop All retains the held Trigger Gate', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await page.locator('#play-all').click();
  await expect(page.locator('#play-all')).toHaveText('Stop All');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await page.locator('#play-all').evaluate(node => node.click());
  await expect(page.locator('#play-all')).toHaveText('Play All');
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await page.mouse.up();
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate off');
});

test('two User sequences loop independently and one slot can stop alone', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const user = await saveTimbre(page);
  user.gatePatterns[0].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2, gates: [{ onSec: 0, offSec: .05 }] };
  user.sequence.gateMode = 'user';
  await loadTimbre(page, '1', user); await loadTimbre(page, '2', user);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.userOns = [];
    const original = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) { window.userOns.push({ id, time }); return original.call(this, id, time); };
  });
  await page.locator('#play-all').click();
  await expect.poll(() => page.evaluate(() => window.userOns.length)).toBeGreaterThanOrEqual(2);
  const starts = await page.evaluate(() => window.userOns.slice(0, 2));
  // Per-slot lookahead timers may reserve simultaneous ONs in either call order.
  expect(starts.map(item => item.id).sort()).toEqual(['1', '2']);
  expect(starts[0].time).toBe(starts[1].time);
  await page.locator('#play-1').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  const before = await page.evaluate(() => window.userOns.filter(item => item.id === '2').length);
  await expect.poll(() => page.evaluate(() => window.userOns.filter(item => item.id === '2').length)).toBeGreaterThan(before);
  await page.locator('#play-all').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'false');
});

test('User Gate and Pitch use independent periods under the same Play Speed', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const user = await saveTimbre(page);
  user.gatePatterns[0].recording = { durationSec: .4, selectionStartSec: 0, selectionEndSec: .4, gates: [{ onSec: 0, offSec: .05 }] };
  user.pitchPatterns[0].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2,
    points: [{ timeSec: 0, valueNormalized: -.5 }, { timeSec: .1, valueNormalized: .5 }, { timeSec: .2, valueNormalized: -.5 }] };
  user.pitchPatterns[0].pitchScaleCent = 200; user.pitchPatterns[0].pitchMode = { kind: 'smooth', scale: 'equal', portamentoSec: 0 };
  user.sequence.recordSpeed = 1; user.sequence.playSpeed = 2; user.sequence.gateMode = 'user';
  await loadTimbre(page, '1', user);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.sequencePhase2 = { gates: [], pitches: [], resets: 0 };
    const gate = AudioEngine.prototype.gateOn;
    const pitch = AudioEngine.prototype.setSequencePitch;
    const reset = AudioEngine.prototype.resetSequencePitch;
    AudioEngine.prototype.gateOn = function (id, time) { if (id === '1') window.sequencePhase2.gates.push(time); return gate.call(this, id, time); };
    AudioEngine.prototype.setSequencePitch = function (id, normalized, scale, filterAmount, time, transition) {
      const cents = normalized * scale;
      if (id === '1') window.sequencePhase2.pitches.push({ cents, time, transition });
      return pitch.call(this, id, normalized, scale, filterAmount, time, transition);
    };
    AudioEngine.prototype.resetSequencePitch = function (id, ...args) {
      if (id === '1') window.sequencePhase2.resets += 1;
      return reset.call(this, id, ...args);
    };
  });
  await page.locator('#play-1').click();
  await expect.poll(() => page.evaluate(() => window.sequencePhase2.gates.length)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => window.sequencePhase2.pitches.filter(item => item.cents === -100 && item.transition === 0).length)).toBeGreaterThanOrEqual(2);
  const timing = await page.evaluate(() => ({
    gates: window.sequencePhase2.gates.slice(0, 2),
    pitchStarts: window.sequencePhase2.pitches.filter(item => item.cents === -100 && item.transition === 0).slice(0, 2),
    firstRamp: window.sequencePhase2.pitches.find(item => item.cents === 100)
  }));
  expect(timing.gates[1] - timing.gates[0]).toBeCloseTo(.2, 4);
  expect(timing.pitchStarts[0].time).toBe(timing.gates[0]);
  expect(timing.pitchStarts[1].time - timing.pitchStarts[0].time).toBeCloseTo(.1, 4);
  expect(timing.firstRamp.transition).toBeCloseTo(.05, 4);
  await page.locator('#play-1').click();
  expect(await page.evaluate(() => window.sequencePhase2.resets)).toBe(1);
});

test('Auto Gate and Pitch receive one common start and source Play Speed', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.pitchPatterns[2].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: .1, valueNormalized: 1 }, { timeSec: .2, valueNormalized: 0 }] };
  timbre.pitchPatterns[2].pitchScaleCent = 300; timbre.pitchPatterns[2].pitchMode = { kind: 'smooth', scale: 'equal', portamentoSec: 0 };
  timbre.sequence.pitchUserId = 'user-3'; timbre.sequence.recordSpeed = 1; timbre.sequence.playSpeed = 2;
  await loadTimbre(page, '1', timbre);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.autoPhase2 = { starts: [], pitches: [] };
    const start = AudioEngine.prototype.startAuto;
    const pitch = AudioEngine.prototype.setSequencePitch;
    AudioEngine.prototype.startAuto = function (id, time, speed) {
      if (id === '1') window.autoPhase2.starts.push({ time, speed });
      return start.call(this, id, time, speed);
    };
    AudioEngine.prototype.setSequencePitch = function (id, normalized, scale, filterAmount, time, transition) {
      const cents = normalized * scale;
      if (id === '1') window.autoPhase2.pitches.push({ cents, time, transition });
      return pitch.call(this, id, normalized, scale, filterAmount, time, transition);
    };
  });
  await page.locator('#play-1').click();
  await expect.poll(() => page.evaluate(() => window.autoPhase2.pitches.filter(item => item.cents === 0 && item.transition === 0).length)).toBeGreaterThanOrEqual(2);
  const result = await page.evaluate(() => ({
    start: window.autoPhase2.starts[0],
    pitchStarts: window.autoPhase2.pitches.filter(item => item.cents === 0 && item.transition === 0).slice(0, 2)
  }));
  expect(result.start.speed).toBe(2);
  expect(result.pitchStarts[0].time).toBe(result.start.time);
  expect(result.pitchStarts[1].time - result.pitchStarts[0].time).toBeCloseTo(.1, 4);
  await page.locator('#play-1').click();
});

test('replacement cancels a Play All start waiting for audio resume in that slot', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.testAudioContext = this; }
    };
  });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page); await loadTimbre(page, '2', timbre);
  await page.evaluate(() => window.testAudioContext.suspend());
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const original = AudioEngine.prototype.start;
    AudioEngine.prototype.start = function () {
      return new Promise(resolve => { window.finishAudioStart = async () => { await original.call(this); resolve(); }; });
    };
  });
  await page.locator('#play-all').click();
  await expect.poll(() => page.evaluate(() => typeof window.finishAudioStart)).toBe('function');
  await loadTimbre(page, '1', timbre);
  await page.evaluate(() => window.finishAudioStart());
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
});
