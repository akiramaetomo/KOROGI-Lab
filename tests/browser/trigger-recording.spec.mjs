import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function savedTimbre(page, id = '1') {
  const save = page.locator(`#save-${id}`); await expect(save).toBeEnabled();
  if (await save.isHidden()) { await page.locator(`#select-${id}`).click(); await expect(save).toBeVisible(); }
  const download = page.waitForEvent('download');
  await save.click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function hold(page, milliseconds) {
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(milliseconds);
  await page.mouse.up();
}

function userRecording(timbre, patternId = 'user-1') {
  return timbre.gatePatterns.find(pattern => pattern.id === patternId).recording;
}

async function dragTimelineHandle(page, selector, valueSec, durationSec) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const handle = await page.locator(selector).boundingBox();
  const timeline = await page.locator('#record-timeline').boundingBox();
  const grabX = selector.includes('end') ? handle.x + 4 : handle.x + handle.width - 4;
  await page.mouse.move(grabX, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(timeline.x + timeline.width * valueSec / durationSec, timeline.y + timeline.height / 2);
  await page.mouse.up();
}

test('records only the large Gate, trims without losing the take, loops and round-trips through timbre/session', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await expect(page.locator('#record-toggle')).toBeEnabled(); await page.locator('#trigger-menu').click();
  await page.locator('#record-length').fill('2');
  await page.locator('#source-user-1').click();
  await page.locator('#record-mode + .segmented-choice [data-value="gate"]').click();
  await expect(page.locator('#record-toggle')).toBeEnabled();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  for (const selector of ['#gate-1', '#play-1', '#trigger', '#select-2']) await expect(page.locator(selector)).toBeDisabled();
  await expect(page.locator('#play-all')).toBeEnabled();
  await hold(page, 230);
  await expect(page.locator('#record-gates span')).toHaveCount(1);
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording complete');
  const timbre = await savedTimbre(page);
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v16');
  expect(userRecording(timbre).gates).toHaveLength(1);
  const gate = userRecording(timbre).gates[0];
  expect(gate.offSec - gate.onSec).toBeGreaterThan(.15);
  expect(userRecording(timbre).durationSec).toBeLessThan(2);

  const start = gate.onSec + .03; const end = gate.offSec - .03;
  await dragTimelineHandle(page, '#record-start-handle', start, userRecording(timbre).durationSec);
  await dragTimelineHandle(page, '#record-end-handle', end, userRecording(timbre).durationSec);
  const trimmed = await savedTimbre(page);
  expect(userRecording(trimmed).gates).toEqual(userRecording(timbre).gates);
  expect(userRecording(trimmed).selectionStartSec).toBeCloseTo(start, 2);
  expect(userRecording(trimmed).selectionEndSec).toBeCloseTo(end, 2);

  await page.evaluate(async () => {
    window.recordedGateOns = 0;
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.originalRecordedGateOn = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (...args) {
      ++window.recordedGateOns;
      return window.originalRecordedGateOn.apply(this, args);
    };
  });
  await page.locator('#source-recorded').click();
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#record-status')).toHaveText('Loop playing');
  await expect(page.locator('#sequence-panel')).toContainText('Stop');
  await expect(page.locator('#gate-1')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.recordedGateOns)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#record-start-handle')).toBeEnabled();
  await expect(page.locator('#record-end-handle')).toBeEnabled();
  const shorterEnd = end - .02;
  await dragTimelineHandle(page, '#record-end-handle', shorterEnd, userRecording(timbre).durationSec);
  const editedWhilePlaying = await savedTimbre(page);
  expect(userRecording(editedWhilePlaying).selectionEndSec).toBeLessThan(userRecording(trimmed).selectionEndSec);
  expect(userRecording(editedWhilePlaying).selectionEndSec).toBeCloseTo(shorterEnd, 1);
  const displayDuration = userRecording(editedWhilePlaying).selectionEndSec - userRecording(editedWhilePlaying).selectionStartSec;
  await expect.poll(() => page.locator('#record-counter').textContent()).toMatch(new RegExp(` / 00:00\\.${String(Math.floor(displayDuration * 100)).padStart(2, '0')}`));
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toContainText('Play');
  const countAtStop = await page.evaluate(() => window.recordedGateOns);
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => window.recordedGateOns)).toBe(countAtStop);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    AudioEngine.prototype.gateOn = window.originalRecordedGateOn;
  });
  await expect(page.locator('#record-status')).toHaveText('Stopped');
  await expect(page.locator('#gate-1')).toBeEnabled();

  await page.locator('#timbre-file-2').setInputFiles({ name: 'recorded.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(trimmed)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 2:');
  expect(userRecording(await savedTimbre(page, '2'))).toEqual(userRecording(trimmed));
  await page.locator('#select-1').click();
  await page.locator('#files-menu').click();
  const sessionDownload = page.waitForEvent('download');
  await page.locator('#export-patch').click();
  const session = JSON.parse(await readFile(await (await sessionDownload).path(), 'utf8'));
  expect(session.formatVersion).toBe('KOROGI-Lab/session-v17');
  expect(userRecording(session.channels[0].timbre)).toEqual(userRecording(editedWhilePlaying));
  expect(session.channels[0].timbre.sequence).toMatchObject({ gateMode: 'user', gateUserId: 'user-1', pitchUserId: 'user-1' });
  expect(userRecording(session.channels[1].timbre)).toEqual(userRecording(trimmed));
  await page.locator('#trigger-menu').click(); await page.locator('#sequence-panel').click();
  await expect(page.locator('#record-status')).toHaveText('Loop playing');
  await page.locator('#patch-file').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await expect(page.locator('#record-status')).toHaveText('Stopped');
  const broken = structuredClone(trimmed); userRecording(broken).gates[0].offSec = 301;
  await page.locator('#timbre-file-1').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(broken)) });
  await expect(page.locator('#patch-status')).toContainText('Timbre import failed:');
  expect(userRecording(await savedTimbre(page))).toEqual(userRecording(editedWhilePlaying));
});

test('Trigger overlays Auto without losing the manual hold and T repeat survives save', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await expect(page.locator('#record-toggle')).toBeEnabled(); await page.locator('#trigger-menu').click();
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate off');
  await expect(page.locator('#record-gate')).toBeEnabled();
  await hold(page, 75);
  await expect(page.locator('#record-gates span')).toHaveCount(0);
  await page.locator('#ton').fill('100'); await page.locator('#ton').dispatchEvent('change');
  await page.locator('#trepeat').fill('400'); await page.locator('#trepeat').dispatchEvent('change');
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toContainText('Stop');
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await page.evaluate(() => {
    window.gateSamples = [];
    window.sampleGate = true;
    const sample = () => {
      if (!window.sampleGate) return;
      window.gateSamples.push(document.querySelector('#gate-lamp-panel').classList.contains('on'));
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => { window.sampleGate = false; return window.gateSamples; })).not.toContain(false);
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toContainText('Play');
  await page.locator('#ton').fill('500'); await page.locator('#ton').dispatchEvent('change');
  await expect(page.locator('#trepeat')).toHaveValue('400');
  const timbre = await savedTimbre(page);
  expect(timbre.settings.autoTrigger.tonSec).toBeCloseTo(.5);
  expect(timbre.settings.autoTrigger.repeatSec).toBeCloseTo(.4);
  await page.locator('#timbre-file-2').setInputFiles({ name: 'auto.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await page.locator('#select-2').click();
  await expect(page.locator('#trepeat')).toHaveValue('400');
  await page.locator('#play-2').click();
  await expect(page.locator('#sequence-panel')).toContainText('Stop');
  await page.locator('#play-2').click();
  await expect(page.locator('#sequence-panel')).toContainText('Play');
});

test('Trigger stays audible across Loop OFF and stopping Loop preserves the held Gate', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await expect(page.locator('#record-toggle')).toBeEnabled(); await page.locator('#trigger-menu').click();
  const timbre = await savedTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2, gates: [{ onSec: 0, offSec: .05 }] };
  timbre.sequence.gateMode = 'user';
  await page.locator('#timbre-file-1').setInputFiles({ name: 'loop.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await page.locator('#source-user-1').click();
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toContainText('Stop');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await page.waitForTimeout(500);
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await page.locator('#sequence-panel').evaluate(node => node.click());
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate on');
  await page.mouse.up();
  await expect(page.locator('#gate-lamp-panel')).toHaveAttribute('aria-label', 'Gate off');
});

test('a scheduled playback OFF cannot cut the held Trigger envelope', async ({ page }) => {
  await page.goto('/');
  const samples = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const rate = 48000;
    const context = new OfflineAudioContext(1, rate / 2, rate);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.blocksEnabled.osc1 = false; settings.blocksEnabled.osc2 = false;
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.setAmplitudeEnvelope({ attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .05 });
    const source = context.createConstantSource();
    source.connect(synth.ampEnvelope.node); synth.ampEnvelope.node.connect(context.destination); source.start();
    synth.gateOn(.02); synth.gateOff(.2);
    const press = context.suspend(.1), release = context.suspend(.3);
    const rendering = context.startRendering();
    await press; synth.triggerGateOn(); await context.resume();
    await release; synth.triggerGateOff(); await context.resume();
    const data = (await rendering).getChannelData(0);
    return [.18, .24, .28, .36].map(time => data[Math.floor(time * rate)]);
  });
  expect(samples[0]).toBeGreaterThan(.9);
  expect(samples[1]).toBeGreaterThan(.9);
  expect(samples[2]).toBeGreaterThan(.9);
  expect(samples[3]).toBeLessThan(.01);
});

test('rebuilding a reserved Gate keeps the ADSR snapshot taken at its original ON', async ({ page }) => {
  await page.goto('/');
  const level = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const rate = 48000;
    const context = new OfflineAudioContext(1, rate / 2, rate);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.blocksEnabled.osc1 = false; settings.blocksEnabled.osc2 = false;
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.setAmplitudeEnvelope({ attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .01 });
    const source = context.createConstantSource();
    source.connect(synth.ampEnvelope.node); synth.ampEnvelope.node.connect(context.destination); source.start();
    synth.gateOn(.2); synth.gateOff(.4);
    const change = context.suspend(.05), press = context.suspend(.1);
    const rendering = context.startRendering();
    await change; synth.setAmplitudeEnvelope({ attackSec: .001, decaySec: .001, sustain: .1, releaseSec: .01 }); await context.resume();
    await press; synth.triggerGateOn(); await context.resume();
    const data = (await rendering).getChannelData(0);
    return data[Math.floor(.23 * rate)];
  });
  expect(level).toBeGreaterThan(.9);
});

test('changing the trim while playing keeps the current cycle and starts the new range at its boundary', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await expect(page.locator('#record-toggle')).toBeEnabled(); await page.locator('#trigger-menu').click();
  const timbre = await savedTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: .8, selectionStartSec: 0, selectionEndSec: .8,
    gates: [{ onSec: .1, offSec: .2 }, { onSec: .55, offSec: .65 }] };
  timbre.sequence.gateMode = 'user';
  await page.locator('#timbre-file-1').setInputFiles({ name: 'two-gates.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await page.locator('#source-user-1').click();
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.scheduledOns = [];
    const original = AudioEngine.prototype.gateOn;
    AudioEngine.prototype.gateOn = function (id, time) {
      window.scheduledOns.push(time);
      return original.call(this, id, time);
    };
  });
  await page.locator('#sequence-panel').click();
  await expect.poll(() => page.evaluate(() => window.scheduledOns.length)).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(150);
  await dragTimelineHandle(page, '#record-start-handle', .3, .8);
  await dragTimelineHandle(page, '#record-end-handle', .7, .8);
  await expect.poll(() => page.evaluate(() => window.scheduledOns.length), { timeout: 2500 }).toBeGreaterThanOrEqual(3);
  const times = await page.evaluate(() => window.scheduledOns.slice(0, 3));
  expect(times[1] - times[0]).toBeCloseTo(.45, 2);
  expect(times[2] - times[0]).toBeCloseTo(.95, 2);
  await page.locator('#sequence-panel').click();
});

test('recording limit closes a held Gate, and an empty recording remains saveable', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await expect(page.locator('#record-toggle')).toBeEnabled(); await page.locator('#trigger-menu').click();
  await page.locator('#record-length').fill('1');
  await page.locator('#source-user-1').click();
  await page.locator('#record-mode + .segmented-choice [data-value="gate"]').click();
  await expect(page.locator('#record-toggle')).toBeEnabled();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect(page.locator('#record-status')).toHaveText('Recording complete', { timeout: 5000 });
  await page.mouse.up();
  const first = await savedTimbre(page);
  expect(userRecording(first).durationSec).toBe(1);
  expect(userRecording(first).gates).toHaveLength(1);
  expect(userRecording(first).gates[0].offSec).toBe(1);
  await expect(page.locator('#gate-1')).not.toHaveClass(/on/);

  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  expect(userRecording(await savedTimbre(page))).toEqual(userRecording(first));
  await page.locator('#record-toggle').click();
  const empty = await savedTimbre(page);
  expect(userRecording(empty)).toEqual(userRecording(first));
  await page.locator('#source-user-1').click();
  await expect(page.locator('#sequence-panel')).toBeEnabled();
  await page.locator('#sequence-panel').click();
  await expect(page.locator('#sequence-panel')).toHaveAttribute('aria-pressed', 'true');
});

test('Play Speed controls recording clock and retained Pitch playback', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await savedTimbre(page);
  timbre.pitchPatterns[0].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: .1, valueNormalized: 1 }, { timeSec: .2, valueNormalized: 0 }] };
  timbre.pitchPatterns[0].pitchScaleCent = 200;
  timbre.pitchPatterns[0].pitchMode = { kind: 'smooth', scale: 'equal', portamentoSec: 0 };
  timbre.sequence.recordSpeed = 1; timbre.sequence.playSpeed = 2;
  await page.locator('#timbre-file-1').setInputFiles({ name: 'record-speed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.retainedPitchCalls = 0;
    const original = AudioEngine.prototype.setSequencePitch;
    AudioEngine.prototype.setSequencePitch = function (...args) {
      window.retainedPitchCalls += 1;
      return original.apply(this, args);
    };
  });
  await page.locator('#trigger-menu').click();
  await page.locator('#record-length').fill('1');
  await page.locator('#record-mode + .segmented-choice [data-value="gate"]').click();
  const started = await page.evaluate(() => performance.now());
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  await expect.poll(() => page.evaluate(() => window.retainedPitchCalls)).toBeGreaterThan(0);
  await expect(page.locator('#record-status')).toContainText('previous Gate and Pitch preserved', { timeout: 3000 });
  const wallSec = (await page.evaluate(() => performance.now()) - started) / 1000;
  expect(wallSec).toBeGreaterThan(.35);
  expect(wallSec).toBeLessThan(1.2);
  expect(userRecording(await savedTimbre(page))).toBeNull();
});

test('User 1 and User 2 keep independent timelines and expose pointer and keyboard slider semantics', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await page.locator('#trigger-menu').click();
  await expect(page.locator('#record-toggle')).toBeEnabled();
  await expect(page.locator('#record-target')).toContainText('User 1');
  const timbre = await savedTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: .1, selectionEndSec: .8, gates: [{ onSec: .1, offSec: .2 }] };
  timbre.gatePatterns[1].recording = { durationSec: 2, selectionStartSec: .5, selectionEndSec: 1.5, gates: [{ onSec: .6, offSec: .7 }] };
  await page.locator('#timbre-file-1').setInputFiles({ name: 'two-patterns.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#source-user-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#record-start-value')).toHaveText('0.10 s');
  await expect(page.locator('#record-end-value')).toHaveText('0.80 s');
  await page.locator('#source-user-2').click();
  await expect(page.locator('#record-start-value')).toHaveText('0.50 s');
  await expect(page.locator('#record-end-value')).toHaveText('1.50 s');
  await expect(page.locator('#record-start-handle')).toHaveAttribute('role', 'slider');
  await expect(page.locator('#record-start-handle')).toHaveAttribute('aria-valuemax', '2');
  await page.locator('#record-start-handle').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#record-start-value')).toHaveText('0.51 s');
  const saved = await savedTimbre(page);
  expect(userRecording(saved, 'user-1').selectionStartSec).toBe(.1);
  expect(userRecording(saved, 'user-2').selectionStartSec).toBeCloseTo(.51);
});

test('slide Gate and both timeline handles remain reachable at tablet size', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); await expect(page.locator('#record-toggle')).toBeEnabled(); await page.locator('#trigger-menu').click();
  const gate = await page.locator('#record-gate').boundingBox();
  expect(gate.width).toBe(56);
  expect(gate.height).toBe(56);
  expect(await page.locator('#record-gate').evaluate(node => getComputedStyle(node, '::before').width)).toBe('52px');
  for (const selector of ['#record-toggle', '#record-start-handle', '#record-end-handle', '#sequence-panel']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    await expect(page.locator(selector)).toBeVisible();
  }
  const initialHeight = (await page.locator('#record-timeline').boundingBox()).height;
  await page.locator('#panel-divider').focus();
  for (let index = 0; index < 8; index += 1) await page.locator('#panel-divider').press('ArrowUp');
  expect((await page.locator('#record-timeline').boundingBox()).height).toBe(initialHeight);
});
