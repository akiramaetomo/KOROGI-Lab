import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}
async function loadTimbre(page, timbre) {
  await page.locator('#timbre-file-1').setInputFiles({ name: 'sequence.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
}

test('separate preset states, pitch-only Play, mute, Clear, and manual Trigger', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5,
    gates: [{ onSec: .1, offSec: .2 }] };
  timbre.pitchPatterns[0].recording = { durationSec: .5, selectionStartSec: 0, selectionEndSec: .5,
    points: [{ timeSec: 0, valueNormalized: .25 }, { timeSec: .5, valueNormalized: .25 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await expect(page.locator('#source-user-1 small')).toHaveText('1');
  await expect(page.locator('#pitch-user-1 small')).toHaveText('1');
  await expect(page.locator('#pitch-record-target')).toContainText('Constant Pitch');
  await page.locator('#gate-mute').click();
  await expect(page.locator('#source-user-1 small')).toHaveText('0');
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.sequenceGateOns = 0; window.sequencePitchCalls = 0;
    const gate = AudioEngine.prototype.gateOn, pitch = AudioEngine.prototype.setSequencePitch;
    AudioEngine.prototype.gateOn = function (...args) { ++window.sequenceGateOns; return gate.apply(this, args); };
    AudioEngine.prototype.setSequencePitch = function (...args) { ++window.sequencePitchCalls; return pitch.apply(this, args); };
  });
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.sequencePitchCalls)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.sequenceGateOns)).toBe(0);
  await page.locator('#sequence-panel').click();
  let confirmation;
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.accept(); });
  await page.locator('#gate-clear').click();
  expect(confirmation).toContain('Gate User 1');
  await expect(page.locator('#source-user-1 small')).toHaveText('Null');
  expect((await saveTimbre(page)).pitchPatterns[0].recording).toEqual(timbre.pitchPatterns[0].recording);
  await page.locator('#pitch-mute').click();
  await expect(page.locator('#pitch-user-1 small')).toHaveText('0');
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#patch-status')).toContainText('no Sequence data');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await page.mouse.up();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0]).toMatchObject({ recording: null, muted: false });
  expect(saved.pitchPatterns[0].muted).toBe(true);
});

test('Gate User mute is editable while Auto is selected and never mutes Auto', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: .4, selectionStartSec: 0, selectionEndSec: .4,
    gates: [{ onSec: 0, offSec: .1 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await expect(page.locator('#source-auto')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#gate-mute').click();
  await expect(page.locator('#source-user-1 small')).toHaveText('0');
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#source-recorded').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#patch-status')).toContainText('no Sequence data');
  expect((await saveTimbre(page)).gatePatterns[0].muted).toBe(true);
});

test('Both recording without Trigger or Pitch input preserves both lanes across a loop and restarts', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: .3, selectionStartSec: 0, selectionEndSec: .3,
    gates: [{ onSec: .05, offSec: .12 }] };
  timbre.pitchPatterns[0].recording = { durationSec: .5, selectionStartSec: .1, selectionEndSec: .4,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: .5, valueNormalized: .5 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#sequence-link').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await expect.poll(async () => Number((await page.locator('#record-counter').textContent()).match(/Lap (\d+)/)?.[1] ?? 0),
    { timeout: 3000 }).toBeGreaterThanOrEqual(2);
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('previous Gate and Pitch preserved');
  let saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).toEqual(timbre.gatePatterns[0].recording);
  expect(saved.pitchPatterns[0].recording).toEqual(timbre.pitchPatterns[0].recording);
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#record-toggle').click();
  saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).toEqual(timbre.gatePatterns[0].recording);
});

test('one-take Both recording without input leaves the previous recordings and Gate source intact', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
    gates: [{ onSec: .1, offSec: .2 }] };
  timbre.pitchPatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: .2 }, { timeSec: 1, valueNormalized: .2 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-length').fill('1');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('previous Gate and Pitch preserved');
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).toEqual(timbre.gatePatterns[0].recording);
  expect(saved.pitchPatterns[0].recording).toEqual(timbre.pitchPatterns[0].recording);
  expect(saved.sequence.gateMode).toBe('user');
});

test('Play resets a prior manual Pitch gesture when the selected Pitch User is Null', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const original = AudioEngine.prototype.setSequencePitch;
    AudioEngine.prototype.setSequencePitch = function (...args) {
      window.pitchEngine = this;
      return original.apply(this, args);
    };
  });
  await page.locator('#sequence-pitch-input').fill('0.5');
  await expect.poll(() => page.evaluate(() => window.pitchEngine?.getSequencePitchCent('1') ?? 0)).toBeGreaterThan(0);
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.pitchEngine.getSequencePitchCent('1'))).toBe(0);
});

test('Link uses an existing Gate length while a new Pitch lane starts at zero', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .2, selectionEndSec: .6,
    gates: [{ onSec: .1, offSec: .15 }, { onSec: .5, offSec: .55 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#sequence-link').click();
  await expect(page.locator('#sequence-link')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#record-length')).toHaveValue('0.4');
  await expect(page.locator('#record-length')).toBeDisabled();
  await page.locator('#record-mode + .segmented-choice [data-value="both"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#sequence-pitch-input').fill('0.5');
  await page.locator('#sequence-pitch-input').dispatchEvent('input');
  await page.waitForTimeout(80);
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBe(0);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBeCloseTo(.4);
  expect(saved.pitchPatterns[0].recording.durationSec).toBeCloseTo(.4);
  expect(saved.gatePatterns[0].recording.gates).toEqual(timbre.gatePatterns[0].recording.gates);
  expect(saved.sequence.gateMode).toBe('auto');
});

test('Link matches interval lengths while Pitch start remains independent', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .2, selectionEndSec: 1.2, gates: [] };
  timbre.pitchPatterns[0].recording = { durationSec: 1.5, selectionStartSec: .3, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1.5, valueNormalized: 0 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#sequence-link').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('lengths differ');
  await expect(page.locator('#record-log li').first()).toContainText('lengths differ');
  await page.locator('#record-start-handle').focus(); await page.keyboard.press('Home');
  let saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBe(0);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBe(.3);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBe(1.2);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBe(1.5);
  await page.locator('#pitch-start-handle').focus(); await page.keyboard.press('Home');
  saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBe(1.2);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBe(0);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBe(1.2);
  await expect(page.locator('#record-length')).toHaveValue('1.2');
});

test('Length Lock shifts each interval, Link shifts both, and dt tracks edits', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .2, selectionEndSec: .7, gates: [] };
  timbre.pitchPatterns[0].recording = { durationSec: 2, selectionStartSec: .4, selectionEndSec: 1.1,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 2, valueNormalized: 0 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await expect(page.locator('#record-duration-value')).toHaveText('0.50 s');
  await expect(page.locator('#pitch-duration-value')).toHaveText('0.70 s');

  await page.locator('#record-start-handle').focus(); await page.keyboard.press('ArrowRight');
  let saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBeCloseTo(.21);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(.7);
  await expect(page.locator('#record-duration-value')).toHaveText('0.49 s');

  await page.locator('#sequence-length-lock').click();
  await expect(page.locator('#sequence-length-lock')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-end-handle').focus(); await page.keyboard.press('ArrowRight');
  await page.locator('#pitch-start-handle').focus(); await page.keyboard.press('ArrowLeft');
  saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBeCloseTo(.22);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(.71);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBeCloseTo(.39);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBeCloseTo(1.09);
  await expect(page.locator('#record-duration-value')).toHaveText('0.49 s');
  await expect(page.locator('#pitch-duration-value')).toHaveText('0.70 s');

  await page.locator('#sequence-link').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('lengths differ');
  await page.locator('#pitch-end-handle').focus(); await page.keyboard.press('ArrowRight');
  saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBeCloseTo(.23);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(.72);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBeCloseTo(.4);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBeCloseTo(1.1);

  await page.locator('#sequence-length-lock').click();
  await page.locator('#record-end-handle').focus(); await page.keyboard.press('ArrowRight');
  saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBeCloseTo(.23);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(.73);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBeCloseTo(.4);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBeCloseTo(.9);
  await expect(page.locator('#record-duration-value')).toHaveText('0.50 s');
  await expect(page.locator('#pitch-duration-value')).toHaveText('0.50 s');
});

test('linked locked intervals share boundary clamps and pointer movement', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .2, selectionEndSec: .7, gates: [] };
  timbre.pitchPatterns[0].recording = { durationSec: 2, selectionStartSec: .4, selectionEndSec: 1.1,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 2, valueNormalized: 0 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#sequence-link').click(); await page.locator('#sequence-length-lock').click();
  await page.locator('#record-start-handle').focus(); await page.keyboard.press('Home');
  let saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBeCloseTo(0);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBeCloseTo(.2);
  await page.locator('#pitch-end-handle').focus(); await page.keyboard.press('End');
  saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBeCloseTo(1.1);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(1.6);
  expect(saved.pitchPatterns[0].recording.selectionStartSec).toBeCloseTo(1.3);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBeCloseTo(2);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#pitch-end-value')).toHaveText('2.00 s');

  const timeline = await page.locator('#record-timeline').boundingBox();
  const handle = await page.locator('#record-end-handle').boundingBox();
  const fromX = handle.x + handle.width / 2;
  await page.mouse.move(fromX, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(timeline.x + timeline.width * .75, handle.y + handle.height / 2);
  await page.mouse.up();
  saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(1.5, 1);
  expect(saved.pitchPatterns[0].recording.selectionEndSec).toBeCloseTo(1.9, 1);
  await expect(page.locator('#record-duration-value')).toHaveText('0.50 s');
  await expect(page.locator('#pitch-duration-value')).toHaveText('0.70 s');
});

test('Length Lock works with one recorded lane and saves its shifted selection', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .2, selectionEndSec: .7, gates: [] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#sequence-link').click(); await page.locator('#sequence-length-lock').click();
  await page.locator('#record-start-handle').focus(); await page.keyboard.press('ArrowRight');
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBeCloseTo(.21);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBeCloseTo(.71);
  expect(saved.pitchPatterns[0].recording).toBeNull();
  await loadTimbre(page, saved);
  await expect(page.locator('#record-start-value')).toHaveText('0.21 s');
  await expect(page.locator('#record-duration-value')).toHaveText('0.50 s');
  await expect(page.locator('#sequence-length-lock')).toHaveAttribute('aria-pressed', 'true');
});

test('leaving Link restores the original one-take length after timeline refresh', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: .2, selectionEndSec: .6,
    gates: [{ onSec: .25, offSec: .3 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#record-length').fill('2');
  await page.locator('#sequence-link').click();
  await expect(page.locator('#record-length')).toHaveValue('0.4');
  await page.locator('#record-end-handle').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#record-length')).toHaveValue('0.41');
  await page.locator('#sequence-link').click();
  await expect(page.locator('#record-length')).toHaveValue('2');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  await page.locator('#record-toggle').click();
});

test('linked Pitch punch loops at its own start and preserves points outside the interval', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: .1, selectionEndSec: .4,
    gates: [{ onSec: .15, offSec: .2 }] };
  timbre.pitchPatterns[0].recording = { durationSec: 1, selectionStartSec: .6, selectionEndSec: .9,
    points: [{ timeSec: 0, valueNormalized: -.5 }, { timeSec: .5, valueNormalized: -.5 },
      { timeSec: .95, valueNormalized: .5 }, { timeSec: 1, valueNormalized: .5 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#sequence-link').click();
  await page.locator('#record-mode + .segmented-choice [data-value="pitch"]').click();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#sequence-pitch-input').fill('0.75');
  await page.locator('#sequence-pitch-input').dispatchEvent('input');
  await expect.poll(async () => Number((await page.locator('#record-counter').textContent()).match(/Lap (\d+)/)?.[1] ?? 0),
    { timeout: 3000 }).toBeGreaterThanOrEqual(2);
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording).toEqual(timbre.gatePatterns[0].recording);
  const pitch = saved.pitchPatterns[0].recording;
  expect(pitch.selectionStartSec).toBe(.6); expect(pitch.selectionEndSec).toBe(.9);
  expect(pitch.points[0]).toEqual({ timeSec: 0, valueNormalized: -.5 });
  expect(pitch.points.at(-1)).toEqual({ timeSec: 1, valueNormalized: .5 });
  expect(pitch.points.some(point => point.timeSec >= .6 && point.timeSec <= .9 && point.valueNormalized === .75)).toBe(true);
});

test('linked Gate recording reaches another lap and monitors the completed take', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .2, selectionEndSec: 1.2,
    gates: [{ onSec: .1, offSec: .15 }, { onSec: .8, offSec: .85 }] };
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#sequence-link').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.monitorGateOns = 0;
    const original = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (...args) { ++window.monitorGateOns; return original.apply(this, args); };
  });
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.waitForTimeout(120); await page.mouse.up();
  await expect(page.locator('#record-counter')).toContainText('Lap 2', { timeout: 3000 });
  await expect.poll(() => page.evaluate(() => window.monitorGateOns), { timeout: 3000 }).toBeGreaterThan(0);
  await page.locator('#record-toggle').click();
  const saved = await saveTimbre(page);
  expect(saved.gatePatterns[0].recording.gates).toContainEqual({ onSec: .1, offSec: .15 });
  expect(saved.gatePatterns[0].recording.gates).not.toContainEqual({ onSec: .8, offSec: .85 });
  expect(saved.gatePatterns[0].recording.selectionStartSec).toBe(.2);
  expect(saved.gatePatterns[0].recording.selectionEndSec).toBe(1.2);
});

test('legacy Pitch Scale is Custom until the five-stop slider is operated', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.pitchPatterns[2].pitchScaleCent = 333;
  await loadTimbre(page, timbre); await page.locator('#trigger-menu').click();
  await page.locator('#pitch-user-3').click();
  await expect(page.locator('#sequence-scale-custom')).toHaveText('Custom 333 cent');
  expect((await saveTimbre(page)).pitchPatterns[2].pitchScaleCent).toBe(333);
  await page.locator('[data-numeric-control="sequence-pitch-scale"] input[type="range"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#sequence-scale-custom')).toBeEmpty();
  expect((await saveTimbre(page)).pitchPatterns[2].pitchScaleCent).toBe(400);
});

test('390px viewport keeps vertical Record modes and horizontal User choices reachable by local scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  const geometry = await page.locator('.trigger-editor').evaluate(editor => {
    const mode = [...editor.querySelectorAll('#record-mode + .segmented-choice button')].map(button => button.getBoundingClientRect());
    const gateUsers = [...editor.querySelectorAll('.source-choice:first-child button')].map(button => button.getBoundingClientRect());
    return { scrollWidth: editor.scrollWidth, clientWidth: editor.clientWidth,
      modeTops: mode.map(rect => rect.top), gateTops: gateUsers.map(rect => rect.top) };
  });
  expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
  expect(new Set(geometry.modeTops).size).toBe(3);
  expect(new Set(geometry.gateTops).size).toBe(1);
  for (const selector of ['#record-toggle', '#sequence-panel', '#record-gate']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await expect(page.locator(selector)).toBeVisible();
  }
});
