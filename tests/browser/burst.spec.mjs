import { test, expect } from '@playwright/test';
import { openTimbreEditors } from './editor-helpers.mjs';
import { readFile } from 'node:fs/promises';

async function edit(page, selector, value) {
  await page.locator(selector).fill(String(value));
  await page.locator(selector).dispatchEvent('change');
}

async function start(page) {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
}

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function loadTimbre(page, timbre) {
  await page.locator('#timbre-file-1').setInputFiles({ name: 'burst-pitch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
}

test('BURST is an independent One-shot Timbre block and round-trips its settings', async ({ page }) => {
  await start(page);
  await page.locator('#flow-burst').click();
  await expect(page.locator('[data-panel="burst"]')).toHaveClass(/active/);
  await expect(page.locator('#burst-enabled')).toBeEnabled();
  await expect(page.locator('[data-editor-card="burst"] .editor-card-heading > #burst-enabled')).toHaveCount(1);
  await expect(page.locator('#burst-pulse-interval')).toHaveValue('25');
  await expect(page.locator('#burst-timing-summary')).toHaveText('AEnv T: 55 ms · Full-group guide: 105 ms');
  await expect(page.locator('#burst-timing-warnings')).toContainText('Retrigger overlap');
  await expect(page.locator('#burst-timing-warnings')).toContainText('Group overlap');
  await expect(page.locator('#burst-pulse-interval-coarse').locator('xpath=..').locator('.numeric-slider-guide'))
    .toHaveAttribute('title', 'AEnv T = 55 ms');
  await expect(page.locator('#burst-group-period-coarse').locator('xpath=..').locator('.numeric-slider-guide'))
    .toHaveAttribute('title', 'Full-group guide = 105 ms');

  await page.locator('#burst-block-enabled').click();
  await expect(page.locator('#aenv-mode')).toHaveValue('one-shot');
  await expect(page.locator('#burst-enabled')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#burst-block-enabled')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('path[data-from="burst"][data-to="aenv"]')).toHaveCSS('opacity', '1');
  await expect(page.locator('#burst-pulse-interval')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#ton')).toBeEnabled();
  await openTimbreEditors(page, ['burst']);
  await edit(page, '#burst-count-min', 1);
  await edit(page, '#burst-count-max', 3);
  await edit(page, '#burst-pulse-interval', 25);
  await edit(page, '#burst-pulse-jitter', 20);
  await edit(page, '#burst-group-period', 100);
  await edit(page, '#burst-group-jitter', 10);
  const timbre = await saveTimbre(page);
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v16');
  expect(timbre.settings.burst).toEqual({ enabled: true, pulseCountMin: 1, pulseCountMax: 3,
    pulseIntervalSec: .025, pulseIntervalJitter: .2, groupPeriodSec: .1, groupPeriodJitter: .1 });

  await page.locator('#flow-aenv').click();
  await page.locator('#aenv-mode + .segmented-choice [data-value="gate"]').click();
  await page.locator('#flow-burst').click();
  await expect(page.locator('#burst-enabled')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#burst-enabled')).toBeEnabled();
  await expect(page.locator('#burst-block-enabled')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('path[data-from="burst"][data-to="aenv"]')).toHaveCSS('opacity', '0.15');
  await expect(page.locator('#burst-count-min')).toHaveValue('1');
  await expect(page.locator('#burst-count-max')).toHaveValue('3');
});

test('BURST controls remain a two-column, three-row grid at supported widths', async ({ page }) => {
  for (const viewport of [{ width: 768, height: 768 }, { width: 1024, height: 768 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport); await start(page); await openTimbreEditors(page, ['burst']);
    const controls = await page.locator('.burst-control-grid > .numeric-control').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect(); return { top: Math.round(rect.top), left: rect.left, width: rect.width };
    }));
    expect(controls).toHaveLength(6);
    const rows = [...new Set(controls.map(control => control.top))];
    expect(rows).toHaveLength(3);
    expect(rows.map(top => controls.filter(control => control.top === top).length)).toEqual([2, 2, 2]);
    expect(Math.min(...controls.map(control => control.width))).toBeGreaterThan(150);
  }
});

test('BURST emits 25 ms three-pulse groups and Auto Ton acts as the phrase window', async ({ page }) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const [{ ChannelSynth }, { WhiteNoiseFactory }, { DEFAULT_CHANNEL_SETTINGS }] = await Promise.all([
      import('/src/audio/core/ChannelSynth.ts'), import('/src/audio/dsp/WhiteNoiseFactory.ts'), import('/src/audio/constants.ts')
    ]);
    const context = new AudioContext(); await context.resume();
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.ampEnvelope.mode = 'one-shot';
    settings.ampEnvelope.attackSec = .002; settings.ampEnvelope.decaySec = .004; settings.ampEnvelope.releaseSec = .004;
    settings.burst.enabled = true; settings.burst.pulseCountMin = 3; settings.burst.pulseCountMax = 3;
    settings.burst.pulseIntervalSec = .025; settings.burst.groupPeriodSec = .1;
    settings.autoTrigger.tonSec = .07; settings.autoTrigger.repeatSec = .1;
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0, 'burst-test');
    const events = [];
    synth.addGateScheduleListener(event => events.push(event));
    const start = context.currentTime + .05;
    synth.startAutoTrigger(start);
    await new Promise(resolve => setTimeout(resolve, 260));
    synth.stopAutoTrigger(); synth.dispose(); await context.close();
    return { start, events };
  });
  const pulses = result.events.filter(event => event.kind === 'on');
  expect(pulses.length).toBeGreaterThanOrEqual(6);
  const relative = pulses.slice(0, 6).map(event => Math.round((event.time - result.start) * 1000));
  expect(relative).toEqual([0, 25, 50, 100, 125, 150]);
  expect(result.events.filter(event => event.kind === 'on' || event.kind === 'off').slice(0, 6).map(event => event.kind))
    .toEqual(['on', 'off', 'on', 'off', 'on', 'off']);
});

test('recording stores the external phrase Gate rather than generated BURST pulses', async ({ page }) => {
  await start(page);
  await page.locator('#aenv-mode').evaluate(select => {
    select.value = 'one-shot'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#flow-burst').click(); await page.locator('#burst-enabled').click();
  await page.locator('#trigger-menu').click();
  await page.locator('#source-user-1').click(); await edit(page, '#record-length', 1);
  await page.locator('#record-toggle').click();
  await page.locator('#record-gate').dispatchEvent('pointerdown', { pointerId: 41, pointerType: 'touch', button: 0 });
  await page.waitForTimeout(140);
  await page.locator('#record-gate').dispatchEvent('pointerup', { pointerId: 41, pointerType: 'touch', button: 0 });
  await page.locator('#record-toggle').click();
  const timbre = await saveTimbre(page);
  expect(timbre.gatePatterns[0].recording.gates).toHaveLength(1);
  expect(timbre.gatePatterns[0].recording.gates[0].offSec - timbre.gatePatterns[0].recording.gates[0].onSec).toBeGreaterThan(.08);
});

test('BURST Auto phrases and Sequence Pitch run together and round-trip', async ({ page }) => {
  await start(page);
  const timbre = await saveTimbre(page);
  timbre.settings.ampEnvelope.mode = 'one-shot';
  timbre.settings.burst = { enabled: true, pulseCountMin: 3, pulseCountMax: 3,
    pulseIntervalSec: .025, pulseIntervalJitter: 0, groupPeriodSec: .2, groupPeriodJitter: 0 };
  timbre.settings.autoTrigger.tonSec = .15; timbre.settings.autoTrigger.repeatSec = .2;
  timbre.pitchPatterns[2].recording = { durationSec: .2, selectionStartSec: 0, selectionEndSec: .2,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: .1, valueNormalized: 1 }, { timeSec: .2, valueNormalized: 0 }] };
  timbre.pitchPatterns[2].pitchScaleCent = 240; timbre.pitchPatterns[2].pitchMode = { kind: 'smooth', scale: 'equal', portamentoSec: 0 };
  timbre.sequence.pitchUserId = 'user-3';
  await loadTimbre(page, timbre);

  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.phase4PitchEvents = []; window.phase4BurstOns = 0;
    const pitch = AudioEngine.prototype.setSequencePitch;
    AudioEngine.prototype.setSequencePitch = function (id, normalized, scale, filterAmount, time, transition) {
      const cents = normalized * scale;
      if (id === '1') window.phase4PitchEvents.push({ cents, time, transition });
      return pitch.call(this, id, normalized, scale, filterAmount, time, transition);
    };
    const lamp = document.querySelector('#gate-lamp');
    new MutationObserver(() => { if (lamp.classList.contains('on')) window.phase4BurstOns += 1; })
      .observe(lamp, { attributes: true, attributeFilter: ['class'] });
  });
  await page.locator('#play-1').click();
  await expect.poll(() => page.evaluate(() => window.phase4BurstOns)).toBeGreaterThanOrEqual(3);
  await expect.poll(() => page.evaluate(() => window.phase4PitchEvents.some(event => event.cents === 240))).toBe(true);
  await page.locator('#play-1').click();

  const saved = await saveTimbre(page);
  expect(saved.settings.burst).toEqual(timbre.settings.burst);
  expect(saved.pitchPatterns[2].recording).toEqual(timbre.pitchPatterns[2].recording);
  expect(saved.pitchPatterns[2].pitchScaleCent).toEqual(timbre.pitchPatterns[2].pitchScaleCent);
});
