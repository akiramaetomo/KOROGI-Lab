import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;

async function saveSession(page) {
  if (!await page.locator('#export-patch').isVisible()) await page.locator('#files-menu').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-patch').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

test('Song clock settings and USER copy survive Session round-trip', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  let session = await saveSession(page);
  expect(session.song.timingMode).toBe('original');
  expect(session.song.speed).toBe(1);
  await expect(page.locator('#lab-build-label')).toContainText(version);
  await expect(page).toHaveTitle(new RegExp(`KOROGI-Lab ${version.replaceAll('.', '\\.')}`));
  session.channels[0].timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .5, selectionEndSec: 1.5,
    gates: [{ onSec: .7, offSec: 1.2 }] };
  session.channels[0].timbre.pitchPatterns[0].pitchScaleCent = 600;
  await page.locator('#patch-file').setInputFiles({ name: 'song.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#song-bpm')).toBeDisabled();
  await page.locator('#record-length-mode').selectOption('bars');
  await page.locator('#record-bpm').fill('130'); await page.locator('#record-bpm').dispatchEvent('change');
  await expect(page.locator('#song-bpm')).toHaveValue('130');
  await page.locator('#song-speed-slider').evaluate(input => { input.value = '1.5'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#song-speed')).toHaveValue('1.5');
  await expect(page.locator('#record-length-unit')).toHaveText('(bars)');
  await page.locator('#record-length').fill('2'); await page.locator('#record-length').dispatchEvent('change');
  await expect(page.locator('#record-counter')).toContainText('00:03.69');
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  await page.locator('#song-user').selectOption('4');
  await page.locator('#song-bars').fill('2'); await page.locator('#song-bars').dispatchEvent('change');
  await page.locator('#copy-from').selectOption('user-1');
  for (const user of ['user-2', 'user-3', 'user-4']) {
    await page.locator('#copy-to').selectOption(user);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#copy-user').click();
  }
  await expect(page.locator('#source-user-4 small')).toHaveText('1');
  await page.locator('.song-timing-field [role="radio"][data-value="original"]').click();
  await expect(page.locator('#song-duration')).toContainText('Seconds total: 2.67 s');
  await expect(page.locator('#song-duration')).not.toContainText('Bars USER');
  await expect(page.locator('#song-duration')).toContainText('Song USER 1, 2, 3, 4');
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#song-clock')).toContainText('User 1 · 00:00 / 00:00');
  await page.locator('#song-toggle').click();
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  await expect(page.locator('#song-timing')).toHaveValue('bars');
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#song-clock')).toContainText('User 1 · Bar 1');
  await page.locator('#song-toggle').click();
  session = await saveSession(page);
  expect(session.song).toEqual({ bpm: 130, speed: 1.5, bars: [1, 1, 1, 2, 1, 1, 1, 1], timingMode: 'bars' });
  expect(session.channels[0].timbre.gatePatterns[3].recording).toEqual(session.channels[0].timbre.gatePatterns[0].recording);
  expect(session.channels[0].timbre.pitchPatterns[3].pitchScaleCent).toBe(600);
  await page.locator('#patch-file').setInputFiles({ name: 'song-roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#song-speed')).toHaveValue('1.5');
  await expect(page.locator('#song-timing')).toHaveValue('bars');
  await expect(page.locator('#song-bars')).toHaveValue('2');
});

test('build identity remains visible on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const label = page.locator('#lab-build-label');
  await expect(label).toContainText(version);
  const bounds = await label.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  const transport = await page.locator('.topbar .transport').boundingBox();
  expect(bounds.y + bounds.height <= transport.y || bounds.x + bounds.width <= transport.x).toBe(true);
});

test('Song follows AEnv for three USERs: enabled Gates rest and bypass continues', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { SongTransport } = await import('/src/ui/SongTransport.ts');
    const rate = 48000;
    const render = async aenvEnabled => {
      const context = new OfflineAudioContext(1, Math.round(rate * 1.3), rate);
      const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      engine.setMasterGainDb(0); engine.setCrossfade(0); engine.setChannelMix('1', { balance: 0 });
      engine.getChannel('1').setAmplitudeEnvelope({ attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .01 });
      engine.getChannel('1').setBlockEnabled('aenv', aenvEnabled);
      engine.setSongSettings({ bpm: 120, speed: 1, bars: Array(8).fill(1), timingMode: 'original' });
      for (const user of ['user-1', 'user-2', 'user-3']) engine.setGateRecording('1', user, {
        durationSec: .4, selectionStartSec: 0, selectionEndSec: .4, gates: [{ onSec: .1, offSec: .3 }]
      });
      const clock = { currentTime: 0, state: 'running' };
      const transportEngine = new Proxy(engine, { get(target, key) {
        if (key === 'context') return clock;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      let tick = () => {};
      const setInterval = window.setInterval, clearInterval = window.clearInterval;
      window.setInterval = callback => { tick = callback; return 1; };
      window.clearInterval = () => {};
      const song = new SongTransport(() => transportEngine, async () => {}, () => {}, () => {});
      try {
        await song.play(); clock.currentTime = 1.3; tick();
        const samples = (await context.startRendering()).getChannelData(0);
        const rms = time => {
          const start = Math.round(time * rate), end = start + Math.round(.08 * rate);
          let power = 0;
          for (let i = start; i < end; i++) power += samples[i] * samples[i];
          return Math.sqrt(power / (end - start));
        };
        return { notes: [.23, .63, 1.03].map(rms), gap: rms(.43) };
      } finally {
        song.stop(); engine.dispose();
        window.setInterval = setInterval; window.clearInterval = clearInterval;
      }
    };
    return { enabled: await render(true), bypass: await render(false) };
  });
  for (const mode of [results.enabled, results.bypass]) for (const level of mode.notes) expect(level).toBeGreaterThan(.01);
  expect(results.enabled.gap).toBeLessThan(.005);
  expect(results.bypass.gap).toBeGreaterThan(.01);
});

test('live Song Speed change preserves the sounding Gate and moves its OFF', async ({ page }) => {
  await page.goto('/');
  const levels = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { SongTransport } = await import('/src/ui/SongTransport.ts');
    const rate = 48000;
    const context = new OfflineAudioContext(1, Math.round(rate * 1.3), rate);
    const engine = new AudioEngine(context);
    engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
    engine.setMasterGainDb(0); engine.setCrossfade(0); engine.setChannelMix('1', { balance: 0 });
    engine.getChannel('1').setAmplitudeEnvelope({ attackSec: .001, decaySec: .001, sustain: 1, releaseSec: .01 });
    engine.getChannel('1').setBlockEnabled('aenv', true);
    engine.setSongSettings({ bpm: 120, speed: 1, bars: Array(8).fill(1), timingMode: 'bars' });
    engine.setGateRecording('1', 'user-1', { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
      gates: [{ onSec: 0, offSec: 1.5 }] });
    const clock = { currentTime: 0, state: 'running' };
    const transportEngine = new Proxy(engine, { get(target, key) {
      if (key === 'context') return clock;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let tick = () => {};
    const setInterval = window.setInterval, clearInterval = window.clearInterval;
    window.setInterval = callback => { tick = callback; return 1; };
    window.clearInterval = () => {};
    const song = new SongTransport(() => transportEngine, async () => {}, () => {}, () => {});
    try {
      await song.play(); clock.currentTime = .04; tick();
      clock.currentTime = .5; engine.setSongSettings({ ...engine.getSongSettings(), speed: 2 }); song.updateTiming();
      clock.currentTime = 1; tick();
      const samples = (await context.startRendering()).getChannelData(0);
      const rms = time => {
        const start = Math.round(time * rate), end = start + Math.round(.05 * rate);
        let power = 0;
        for (let i = start; i < end; i++) power += samples[i] * samples[i];
        return Math.sqrt(power / (end - start));
      };
      return { held: rms(.7), afterOff: rms(1.15) };
    } finally {
      song.stop(); engine.dispose(); window.setInterval = setInterval; window.clearInterval = clearInterval;
    }
  });
  expect(levels.held).toBeGreaterThan(.01);
  expect(levels.afterOff).toBeLessThan(.005);
});

test('Record Unit conversion keeps the intended duration and Copy controls stay compact', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  const length = page.locator('#record-length');
  await expect(length).toHaveValue('30');
  await page.locator('#record-length-mode').selectOption('bars');
  await expect(length).toHaveValue('15');
  await page.locator('#record-length-mode').selectOption('seconds');
  await expect(length).toHaveValue('30');
  await length.fill('1'); await length.dispatchEvent('change');
  await page.locator('#record-length-mode').selectOption('bars');
  await expect(length).toHaveValue('0.5');
  const sizes = await page.locator('.song-copy').evaluate(node => ({
    group: node.getBoundingClientRect().width,
    destination: node.querySelector('#copy-to').getBoundingClientRect().width
  }));
  expect(sizes.group).toBeLessThan(420);
  expect(sizes.destination).toBeLessThan(130);
});

test('Song Speed stays compact and Fit to Bars is exclusive to Bars timing', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#song-bars-group')).toHaveAttribute('disabled', '');
  await expect(page.locator('#song-bpm')).toBeDisabled();
  await expect(page.locator('#song-toggle')).toHaveText('▶ Play Song');
  await expect(page.locator('#copy-user')).toHaveText('Copy Pattern');
  expect(await page.locator('[data-numeric-control="song-speed"]').count()).toBe(0);
  const geometry = await page.locator('.song-controls').evaluate(card => {
    const row = card.querySelector('.song-speed-row').getBoundingClientRect();
    const number = card.querySelector('#song-speed').getBoundingClientRect();
    const slider = card.querySelector('#song-speed-slider').getBoundingClientRect();
    return { cardHeight: card.getBoundingClientRect().height, rowHeight: row.height,
      numberTop: number.top, sliderTop: slider.top, sliderWidth: slider.width };
  });
  expect(geometry.cardHeight).toBeLessThan(230);
  expect(geometry.rowHeight).toBeLessThan(55);
  expect(Math.abs(geometry.numberTop - geometry.sliderTop)).toBeLessThan(16);
  expect(geometry.sliderWidth).toBeGreaterThanOrEqual(150);
  expect(geometry.sliderWidth).toBeLessThanOrEqual(320);
  const timingWidth = await page.locator('.song-timing-field .segmented-choice').evaluate(node => node.getBoundingClientRect().width);
  expect(timingWidth).toBeLessThanOrEqual(135);
  await page.locator('.song-timing-field [role="radio"][data-value="original"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#song-timing')).toHaveValue('bars');
  await expect(page.locator('#song-bpm')).toBeEnabled();
  await page.locator('#record-length-mode').selectOption('bars');
  await page.locator('#song-bpm').fill('150'); await page.locator('#song-bpm').dispatchEvent('change');
  await expect(page.locator('#record-bpm')).toHaveValue('150');
  await page.locator('#song-user').selectOption('3');
  await page.locator('#song-bars').fill('2'); await page.locator('#song-bars').dispatchEvent('change');
  await expect(page.locator('#song-duration')).toContainText('Bars USER 3: 3.20 s');
  await expect(page.locator('#song-duration')).not.toContainText('Seconds total');
  await page.locator('.song-timing-field [role="radio"][data-value="original"]').click();
  await expect(page.locator('#song-bpm')).toBeDisabled();
  await expect(page.locator('#record-bpm')).toBeEnabled();
});

test('Song controls fit their groups and the play action uses a red accent', async ({ page }) => {
  for (const width of [1180, 1024, 390]) {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
    await page.locator('#trigger-menu').click();
    const layout = await page.locator('.song-controls').evaluate(card => {
      const bounds = selector => card.querySelector(selector).getBoundingClientRect();
      const song = card.getBoundingClientRect(), group = bounds('#song-bars-group');
      const copy = bounds('.song-copy'), from = bounds('#copy-from'), to = bounds('#copy-to');
      const color = getComputedStyle(card.querySelector('#song-toggle')).backgroundColor;
      return { songRight: song.right, groupRight: group.right, copyRight: copy.right,
        copyWidth: copy.width, fromWidth: from.width, toWidth: to.width, color,
        pageWidth: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    expect(layout.groupRight).toBeLessThanOrEqual(layout.songRight + 1);
    expect(layout.copyRight).toBeLessThanOrEqual(layout.songRight + 1);
    expect(layout.copyWidth).toBeLessThan(440);
    expect(layout.fromWidth).toBeGreaterThanOrEqual(104);
    expect(layout.toWidth).toBeGreaterThanOrEqual(104);
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport + 1);
    const [red, green, blue] = layout.color.match(/\d+/g).map(Number);
    expect(red).toBeGreaterThan(green);
    expect(red).toBeGreaterThan(blue);
  }
});

test('Fit to Bars sets linked Gate and Pitch selection lengths atomically', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  const session = await saveSession(page);
  session.channels[0].timbre.gatePatterns[0].recording = { durationSec: 4, selectionStartSec: 1, selectionEndSec: 1.5,
    gates: [{ onSec: 1.1, offSec: 1.4 }] };
  session.channels[0].timbre.pitchPatterns[0].recording = { durationSec: 4, selectionStartSec: .5, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 4, valueNormalized: 0 }] };
  await page.locator('#patch-file').setInputFiles({ name: 'linked-song.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#gate-apply-bars')).toBeDisabled();
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  await page.locator('#sequence-link').click();
  await page.locator('#gate-apply-bars').click();
  await expect(page.locator('#record-end-value')).toHaveText('3.00 s');
  await expect(page.locator('#pitch-end-value')).toHaveText('2.50 s');
  await page.locator('#song-bars').fill('2'); await page.locator('#song-bars').dispatchEvent('change');
  await page.locator('#gate-apply-bars').click();
  await expect(page.locator('#record-status')).toContainText('exceeds');
  await expect(page.locator('#record-end-value')).toHaveText('3.00 s');
  await expect(page.locator('#pitch-end-value')).toHaveText('2.50 s');
});

test('a successful Bars recording initializes that USER playback length', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await page.locator('#record-length-mode').selectOption('bars');
  await page.locator('#record-bpm').fill('240'); await page.locator('#record-bpm').dispatchEvent('change');
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  await page.locator('#song-user').selectOption('2');
  await page.locator('#song-bars').fill('3'); await page.locator('#song-bars').dispatchEvent('change');
  await page.locator('#source-user-2').click();
  await page.locator('#record-length').fill('1'); await page.locator('#record-length').dispatchEvent('change');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · One take');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording complete');
  await expect(page.locator('#song-bars')).toHaveValue('1');
  const saved = await saveSession(page);
  expect(saved.song.bars[1]).toBe(1);
});

test('record length, unit, timer and record button occupy separate cells at tablet width', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await page.locator('#trigger-menu').click();
  const boxes = await page.locator('.record-controls').evaluate(node => Object.fromEntries(
    ['.record-length-label', '.record-bars-label', '#record-counter', '#record-toggle'].map(selector => {
      const rect = node.querySelector(selector).getBoundingClientRect();
      return [selector, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
    })
  ));
  expect(boxes['.record-length-label'].bottom).toBeLessThanOrEqual(boxes['.record-bars-label'].top + 1);
  expect(boxes['#record-counter'].bottom).toBeLessThanOrEqual(boxes['#record-toggle'].top + 1);
  expect(boxes['.record-bars-label'].right).toBeLessThanOrEqual(boxes['#record-toggle'].left + 1);
});
