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
  return timbre.patterns.find(pattern => pattern.id === patternId).recording;
}

test('Play All aligns mixed Auto and User while skipping an empty User source', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  const user = structuredClone(timbre);
  user.patterns[0].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2, gates: [{ onSec: 0, offSec: .05 }] };
  user.playbackSource = { kind: 'user', patternId: 'user-1' };
  await loadTimbre(page, '2', user);
  const empty = structuredClone(user); empty.patterns[0].recording = null;
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
  user.patterns[0].recording = { durationSec: .4, selectionStartSec: 0, selectionEndSec: .4, gates: [{ onSec: .03, offSec: .13 }] };
  user.playbackSource = { kind: 'user', patternId: 'user-1' };
  await loadTimbre(page, '2', user);
  await page.locator('#play-2').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#trigger-menu').click();
  await page.locator('#source-user-1').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#play-2').click();
  await page.locator('#play-all').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-toggle').click();
  await page.locator('#select-2').click();
  await expect(page.locator('#source-user-1')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#source-auto').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  expect((await saveTimbre(page, '2')).playbackSource).toEqual({ kind: 'auto' });
  await page.locator('#source-user-1').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  const download = page.waitForEvent('download');
  await page.locator('#files-menu').click(); await page.locator('#export-patch').click();
  const session = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(session.channels[1].timbre.playbackSource).toEqual(user.playbackSource);
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
  user.patterns[0].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2, gates: [{ onSec: 0, offSec: .05 }] };
  user.playbackSource = { kind: 'user', patternId: 'user-1' };
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
  expect(starts.map(item => item.id)).toEqual(['1', '2']);
  expect(starts[0].time).toBe(starts[1].time);
  await page.locator('#play-1').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  const before = await page.evaluate(() => window.userOns.filter(item => item.id === '2').length);
  await expect.poll(() => page.evaluate(() => window.userOns.filter(item => item.id === '2').length)).toBeGreaterThan(before);
  await page.locator('#play-all').click();
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'false');
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
