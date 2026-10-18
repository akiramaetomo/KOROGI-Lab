import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;

async function saveSession(page) {
  if (!await page.locator('#export-patch').isVisible()) await page.locator('#files-menu').click();
  const download = page.waitForEvent('download');
  await page.locator('#export-patch').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

test('Song clock settings and Pattern copy survive Session round-trip', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  // A new app starts in Bars; the rest of this test checks Seconds.
  await expect(page.locator('#time-mode-bars')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#header-bpm')).toBeVisible();
  await page.locator('#time-mode-seconds').click();
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
  await expect(page.locator('.trigger-user-group .trigger-group-title')).toHaveText('PATTERN / RECORD / PLAY');
  // SONG holds one Frame of whole bars (ADR 0011); Pattern bars live in the Bars box of each timbre.
  await expect(page.locator('#song-frame')).toHaveAttribute('aria-label', 'Frame: bars of every Song section');
  await expect(page.locator('#song-frame option')).toHaveCount(32);
  await expect(page.locator('#song-frame')).toHaveValue('4');
  await expect(page.locator('#copy-from option')).toHaveText(['Pattern 1', 'Pattern 2', 'Pattern 3', 'Pattern 4', 'Pattern 5', 'Pattern 6', 'Pattern 7', 'Pattern 8']);
  await expect(page.locator('#copy-to option')).toHaveText(['Pattern 1', 'Pattern 2', 'Pattern 3', 'Pattern 4', 'Pattern 5', 'Pattern 6', 'Pattern 7', 'Pattern 8']);
  // Seconds shows no BPM; the header shows it only in Bars (ADR 0010).
  await expect(page.locator('#header-bpm')).toBeHidden();
  await expect(page.locator('#record-length-mode')).toBeHidden();
  // New Pattern Length is editable only on a Null Gate and Null Pitch Pattern.
  await expect(page.locator('#record-new-length')).toHaveJSProperty('disabled', true);
  await page.locator('#source-user-2').click(); await page.locator('#pitch-user-2').click();
  await expect(page.locator('#record-new-length')).toHaveJSProperty('disabled', false);
  await page.locator('#source-user-1').click(); await page.locator('#pitch-user-1').click();
  await page.locator('#song-speed-slider').evaluate(input => { input.value = '1.5'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#song-speed')).toHaveValue('1.5');
  await expect(page.locator('#record-length')).toHaveAttribute('aria-label', /^Record length in seconds/);
  await expect(page.locator('#record-length')).toBeDisabled();
  await expect(page.locator('#record-counter')).toContainText('00:01.00');
  await page.locator('#time-mode-bars').click();
  await expect(page.locator('#song-speed-row')).toBeHidden();
  await page.locator('#header-bpm').fill('130'); await page.locator('#header-bpm').dispatchEvent('change');
  // Pattern 4 is Null, so its Pitch Pattern sets the bars in the Bars box.
  await page.locator('#source-user-4').click(); await page.locator('#pitch-user-4').click();
  await page.locator('#sequence-stretch-bars').selectOption('2');
  await page.locator('#source-user-1').click(); await page.locator('#pitch-user-1').click();
  await page.locator('#copy-from').selectOption('user-1');
  // A Null destination is copied without an overwrite question and takes the source bars.
  let confirmation;
  const dialogs = async dialog => { confirmation = dialog.message(); await dialog.accept(); };
  page.on('dialog', dialogs);
  for (const user of ['user-2', 'user-3', 'user-4']) {
    await page.locator('#copy-to').selectOption(user);
    await page.locator('#copy-user').click();
    await expect(page.locator('#patch-status')).toContainText(`Copied Timbre 1 Pattern 1 → Pattern ${user.slice(-1)}.`);
  }
  expect(confirmation).toBeUndefined();
  await expect(page.locator('#patch-status')).toContainText('Bars: 1.');
  await page.locator('#source-user-4').click(); await page.locator('#pitch-user-4').click();
  await expect(page.locator('#sequence-stretch-bars')).toHaveValue('1');
  await page.locator('#copy-to').selectOption('user-3');
  await page.locator('#copy-user').click();
  expect(confirmation).toContain('Overwrite Timbre 1 Pattern 3 with Pattern 1');
  page.off('dialog', dialogs);
  await page.locator('#sequence-stretch-bars').selectOption('2');
  await expect(page.locator('#source-user-4 small')).toHaveText('1');
  await page.locator('#time-mode-seconds').click();
  await expect(page.locator('#song-duration')).toContainText('Seconds total: 2.67 s');
  await expect(page.locator('#song-duration')).not.toContainText('Bars Frame');
  await expect(page.locator('#song-duration')).toContainText('Song: Pattern 1, Pattern 2, Pattern 3, Pattern 4');
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#song-clock')).toContainText('Pattern 1 · 00:00 / 00:00');
  await page.locator('.song-summary').click();
  await expect(page.locator('.song-controls')).not.toHaveAttribute('open');
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.song-summary').click();
  await expect(page.locator('#song-toggle')).toBeVisible();
  await page.locator('#song-toggle').click();
  // Back to Bars: Timbre 1 Pattern 4 (1 s at 130 BPM, 0.54 bar) would read as 1/2 bar; declining keeps its 2 bars.
  const offer = new Promise(resolve => page.once('dialog', async dialog => { resolve(dialog.message()); await dialog.dismiss(); }));
  await page.locator('#time-mode-bars').click();
  expect(await offer).toContain('Timbre 1 · Pattern 4: 2 → 1/2 bars');
  expect(await offer).toContain('Frame: 4 → 1 bars');
  await expect(page.locator('#time-mode-bars')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#song-clock')).toContainText('Pattern 1 · Bar 1');
  await page.locator('#song-toggle').click();
  session = await saveSession(page);
  expect(session.song).toEqual({ bpm: 130, speed: 1.5, frameBars: 4, timingMode: 'bars' });
  expect(session.channels[0].timbre.patternBars).toEqual([1, 1, 1, 2, 1, 1, 1, 1]);
  expect(session.channels[0].timbre.gatePatterns[3].recording).toEqual(session.channels[0].timbre.gatePatterns[0].recording);
  expect(session.channels[0].timbre.pitchPatterns[3].pitchScaleCent).toBe(600);
  await page.locator('#patch-file').setInputFiles({ name: 'song-roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#song-speed')).toHaveValue('1.5');
  await expect(page.locator('#time-mode-bars')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#header-bpm')).toHaveValue('130');
  await expect(page.locator('#song-frame')).toHaveValue('4');
});

test('Pattern copy carries the bars within the timbre and leaves another timbre alone (ADR 0011)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  const recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates: [{ onSec: .2, offSec: .8 }] };
  session.channels[1].timbre = structuredClone(session.channels[0].timbre);
  session.channels[0].timbre.gatePatterns[0].recording = recording;
  session.channels[1].timbre.gatePatterns[2].recording = recording;
  session.channels[0].timbre.patternBars = [2, 1, 1, 1, 1, 1, 1, 1];
  await page.locator('#patch-file').setInputFiles({ name: 'copy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  await page.locator('#copy-from').selectOption('user-1');
  await page.locator('#copy-to').selectOption('user-3');
  // Timbre 2 also has Pattern 3, but the bars are Timbre 1's own: nothing to ask.
  let confirmation;
  const dialogs = async dialog => { confirmation = dialog.message(); await dialog.accept(); };
  page.on('dialog', dialogs);
  await page.locator('#copy-user').click();
  await expect(page.locator('#patch-status')).toContainText('Copied Timbre 1 Pattern 1 → Pattern 3. Bars: 2.');
  page.off('dialog', dialogs);
  expect(confirmation).toBeUndefined();
  const saved = await saveSession(page);
  expect(saved.channels[0].timbre.patternBars).toEqual([2, 1, 2, 1, 1, 1, 1, 1]);
  expect(saved.channels[1].timbre.patternBars).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  expect(saved.channels[0].timbre.gatePatterns[2].recording).toEqual(recording);
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

test('eight Pattern names remain inside SONG without page overflow', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const session = await saveSession(page);
  for (const pattern of session.channels[0].timbre.gatePatterns) {
    pattern.recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .2 }] };
  }
  await page.locator('#patch-file').setInputFiles({ name: 'eight-patterns.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  for (const width of [1180, 1024, 390, 844]) {
    await page.setViewportSize({ width, height: 820 });
    await expect(page.locator('#song-duration')).toContainText('Pattern 1');
    await expect(page.locator('#song-duration')).toContainText('Pattern 8');
    const geometry = await page.locator('.song-controls').evaluate(card => ({
      localWidth: card.clientWidth, contentWidth: card.scrollWidth,
      pageWidth: document.documentElement.scrollWidth, viewport: innerWidth
    }));
    expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.localWidth + 1);
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  }
});

test('Song follows AEnv for three Patterns: enabled Gates rest and bypass continues', async ({ page }) => {
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
      engine.setSongSettings({ bpm: 120, speed: 1, frameBars: 1, timingMode: 'original' });
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

test('live Bars BPM change preserves the sounding Gate and moves its OFF', async ({ page }) => {
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
    engine.setSongSettings({ bpm: 120, speed: 1, frameBars: 1, timingMode: 'bars' });
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
      clock.currentTime = .5; engine.setSongSettings({ ...engine.getSongSettings(), bpm: 240 }); song.updateTiming();
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

test('New Pattern Length is in seconds only and Copy controls stay compact', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  const length = page.locator('#record-length');
  await expect(length).toHaveValue('30');
  // The unit follows the app-wide mode: Seconds records seconds, Bars records the Pattern's bars (ADR 0010).
  await expect(page.locator('#record-length-mode')).toBeHidden();
  await expect(page.locator('#record-bpm')).toBeHidden();
  await expect(length).toHaveAttribute('aria-label', /^Record length in seconds/);
  const sizes = await page.locator('.record-copy').evaluate(node => ({
    group: node.getBoundingClientRect().width,
    destination: node.querySelector('#copy-to').getBoundingClientRect().width
  }));
  expect(sizes.group).toBeLessThan(420);
  expect(sizes.destination).toBeLessThan(130);
});

test('Song Speed stays compact, Bars swaps it for a 30–480 BPM slider, and the Frame is exclusive to Bars', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#song-frame-group')).toHaveAttribute('disabled', '');
  await expect(page.locator('#song-bpm-row')).toBeHidden();
  await expect(page.locator('#song-speed-slider')).toBeVisible();
  await expect(page.locator('#song-toggle')).toHaveText('▶ Chain');
  await expect(page.locator('#copy-user')).toHaveText('Copy Pattern');
  expect(await page.locator('[data-numeric-control="song-speed"]').count()).toBe(0);
  const geometry = await page.locator('.song-controls').evaluate(card => {
    const row = card.querySelector('#song-speed-row').getBoundingClientRect();
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
  await page.locator('#time-mode-bars').click();
  await expect(page.locator('#song-frame-group')).not.toHaveAttribute('disabled', '');
  await expect(page.locator('#song-bpm')).toBeEnabled();
  await expect(page.locator('#header-bpm')).toBeVisible();
  await expect(page.locator('#song-speed-row')).toBeHidden();
  await expect(page.locator('#song-bpm-slider')).toHaveAttribute('min', '30');
  await expect(page.locator('#song-bpm-slider')).toHaveAttribute('max', '480');
  const bpmSlider = await page.locator('#song-bpm-slider').boundingBox();
  expect(bpmSlider.width).toBeGreaterThanOrEqual(150);
  await page.locator('#song-bpm').fill('150'); await page.locator('#song-bpm').dispatchEvent('change');
  await expect(page.locator('#header-bpm')).toHaveValue('150');
  await page.locator('#song-frame').selectOption('2');
  await expect(page.locator('#song-duration')).toContainText('Bars Frame: 2 bars · 3.20 s');
  await expect(page.locator('#song-duration')).not.toContainText('Seconds total');
  // The BPM slider sets the Bars tempo directly; Song Speed does not apply to Bars timing.
  await page.locator('#song-bpm-slider').evaluate(input => { input.value = '480'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#song-bpm')).toHaveValue('480');
  await expect(page.locator('#song-duration')).toContainText('Bars Frame: 2 bars · 1.00 s');
  await page.locator('#song-bpm').fill('30'); await page.locator('#song-bpm').dispatchEvent('change');
  await expect(page.locator('#song-bpm-slider')).toHaveValue('30');
  await expect(page.locator('#song-duration')).toContainText('Bars Frame: 2 bars · 16.00 s');
  await page.locator('#song-bpm').fill('29'); await page.locator('#song-bpm').dispatchEvent('change');
  await expect(page.locator('#patch-status')).toContainText('BPM must be a whole number from 30 to 480.');
  await expect(page.locator('#song-bpm')).toHaveValue('30');
  await page.locator('#time-mode-seconds').click();
  await expect(page.locator('#song-bpm')).toBeHidden();
  await expect(page.locator('#header-bpm')).toBeHidden();
  await expect(page.locator('#song-speed-slider')).toBeVisible();
  await expect(page.locator('#song-frame-group')).toHaveAttribute('disabled', '');
});

test('Song controls fit their groups and the play action uses a red accent', async ({ page }) => {
  for (const width of [1180, 1024, 390]) {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
    await page.locator('#trigger-menu').click();
    const layout = await page.locator('.song-controls').evaluate(card => {
      const bounds = selector => card.querySelector(selector).getBoundingClientRect();
      const song = card.getBoundingClientRect(), group = bounds('#song-frame-group');
      const record = card.parentElement.querySelector('.trigger-user-group').getBoundingClientRect();
      const control = card.parentElement.querySelector('.record-performance').getBoundingClientRect();
      const title = bounds('.song-summary');
      // Copy Pattern lives in PATTERN / RECORD / PLAY, not in SONG.
      const outside = selector => card.parentElement.querySelector(selector).getBoundingClientRect();
      const copy = outside('.record-copy'), from = outside('#copy-from'), to = outside('#copy-to');
      const copyInSong = !!card.querySelector('#copy-user');
      const color = getComputedStyle(card.querySelector('#song-toggle')).backgroundColor;
      return { songLeft: song.left, songTop: song.top, songRight: song.right, songBottom: song.bottom,
        recordTop: record.top, recordRight: record.right, recordBottom: record.bottom, controlTop: control.top,
        copyTop: copy.top, copyBottom: copy.bottom, copyInSong,
        titleLeft: title.left, titleTop: title.top, titleRight: title.right,
        groupRight: group.right, copyRight: copy.right,
        copyWidth: copy.width, fromWidth: from.width, toWidth: to.width, color,
        pageWidth: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    expect(layout.groupRight).toBeLessThanOrEqual(layout.songRight + 1);
    expect(layout.titleLeft).toBeGreaterThanOrEqual(layout.songLeft);
    expect(layout.titleRight).toBeLessThanOrEqual(layout.songRight);
    expect(layout.titleTop).toBeGreaterThanOrEqual(layout.songTop);
    expect(layout.songBottom).toBeLessThan(layout.recordTop);
    expect(layout.songBottom).toBeLessThan(layout.controlTop);
    expect(layout.copyInSong).toBe(false);
    expect(layout.copyTop).toBeGreaterThanOrEqual(layout.recordTop);
    expect(layout.copyBottom).toBeLessThanOrEqual(layout.recordBottom);
    expect(layout.copyRight).toBeLessThanOrEqual(layout.recordRight + 1);
    expect(layout.copyWidth).toBeLessThan(440);
    expect(layout.fromWidth).toBeGreaterThanOrEqual(104);
    expect(layout.toWidth).toBeGreaterThanOrEqual(104);
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport + 1);
    const [red, green, blue] = layout.color.match(/\d+/g).map(Number);
    expect(red).toBeGreaterThan(green);
    expect(red).toBeGreaterThan(blue);
  }
});

test('SONG group folds with keyboard and preserves its controls', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  await page.locator('#trigger-menu').click();
  const song = page.locator('.song-controls');
  const summary = song.locator('summary');
  await expect(song).toHaveAttribute('open', '');
  await page.locator('#song-speed').fill('1.5');
  await page.locator('#song-speed').press('Tab');
  await summary.focus();
  await summary.press('Enter');
  await expect(song).not.toHaveAttribute('open');
  await expect(page.locator('#song-toggle')).toBeHidden();
  await summary.focus();
  await summary.press(' ');
  await expect(song).toHaveAttribute('open', '');
  await expect(page.locator('#song-speed')).toHaveValue('1.5');
});

test('Match Fit to Bars sets linked Gate and Pitch selection lengths atomically', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  const session = await saveSession(page);
  session.channels[0].timbre.gatePatterns[0].recording = { durationSec: 4, selectionStartSec: 1, selectionEndSec: 1.5,
    gates: [{ onSec: 1.1, offSec: 1.4 }] };
  session.channels[0].timbre.pitchPatterns[0].recording = { durationSec: 4, selectionStartSec: .5, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 4, valueNormalized: 0 }] };
  await page.locator('#patch-file').setInputFiles({ name: 'linked-song.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#gate-apply-bars')).toBeDisabled();
  await page.locator('#time-mode-bars').click();
  await page.locator('#sequence-link').click();
  await page.locator('#gate-apply-bars').click();
  await expect(page.locator('#record-end-value')).toHaveText('3.00 s');
  await expect(page.locator('#pitch-end-value')).toHaveText('2.50 s');
  await page.locator('#sequence-stretch-bars').selectOption('2');
  await page.locator('#gate-apply-bars').click();
  await expect(page.locator('#record-status')).toContainText('exceed the');
  await expect(page.locator('#record-end-value')).toHaveText('3.00 s');
  await expect(page.locator('#pitch-end-value')).toHaveText('2.50 s');
});

test('in Bars, a new Pattern records its Pattern bars at the BPM and keeps those bars', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await page.locator('#time-mode-bars').click();
  await page.locator('#header-bpm').fill('240'); await page.locator('#header-bpm').dispatchEvent('change');
  await page.locator('#source-user-2').click(); await page.locator('#pitch-user-2').click();
  await page.locator('#sequence-stretch-bars').selectOption('3');
  await expect(page.locator('#sequence-stretch-readout')).toHaveText('Pattern 2 · 3.00 s');
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toContainText('Recording · Loop');
  await expect(page.locator('#record-counter')).toContainText('/ 00:03.00');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const box = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.waitForTimeout(100); await page.mouse.up();
  await page.locator('#record-toggle').click();
  await expect(page.locator('#record-status')).toHaveText('Recording complete');
  await expect(page.locator('#sequence-stretch-bars')).toHaveValue('3');
  await expect(page.locator('#sequence-stretch-readout')).toHaveText('Pattern 2 · 3.00 s · ×1.00');
  const saved = await saveSession(page);
  expect(saved.channels[0].timbre.patternBars[1]).toBe(3);
  expect(saved.channels[0].timbre.gatePatterns[1].recording.selectionEndSec).toBeCloseTo(3, 6);
});

test('New Pattern Length stays below the controls and switching the time mode keeps panel heights fixed', async ({ page }) => {
  for (const width of [1024, 390, 844]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto('/');
    await expect(page.locator('#play-1')).toBeEnabled();
    await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
    await page.locator('#trigger-menu').click();
    const layout = () => page.locator('.trigger-top-row').evaluate(row => {
      const bounds = selector => row.querySelector(selector).getBoundingClientRect();
      const record = row.querySelector('.trigger-user-group');
      const counter = row.querySelector('#record-counter');
      return { length: bounds('.record-length-label'), counter: bounds('#record-counter'), button: bounds('#record-toggle'), copy: bounds('.record-copy'),
        record: bounds('.trigger-user-group'), control: bounds('.record-performance'),
        recordOverflow: record.scrollWidth > record.clientWidth + 1,
        counterOverflow: counter.scrollWidth > counter.clientWidth + 1,
        counterFont: parseFloat(getComputedStyle(counter).fontSize),
        buttonFont: parseFloat(getComputedStyle(row.querySelector('#record-toggle')).fontSize) };
    });
    const seconds = await layout();
    await expect(page.locator('#record-new-length')).toBeVisible();
    await page.locator('#time-mode-bars').click();
    await expect(page.locator('#sequence-stretch-group')).toBeVisible();
    // Bars hides New Pattern Length in place, as Seconds hides the Bars box.
    await expect(page.locator('#record-new-length')).toBeHidden();
    const bars = await layout();
    // Copy keeps its place inside the panel (the panel itself may move with the controls above it).
    expect(bars.copy.left - bars.record.left).toBeCloseTo(seconds.copy.left - seconds.record.left, 2);
    expect(bars.copy.top - bars.record.top).toBeCloseTo(seconds.copy.top - seconds.record.top, 2);
    for (const state of [seconds, bars]) {
      expect(state.counter.bottom).toBeLessThanOrEqual(state.length.top + 1);
      expect(state.counter.bottom).toBeLessThanOrEqual(state.button.top + 1);
      expect(state.recordOverflow).toBe(false);
      expect(state.counterOverflow).toBe(false);
      expect(state.counterFont).toBeGreaterThanOrEqual(state.buttonFont * 1.25);
    }
    // The bars frame keeps its place in Seconds, so the panel does not jump.
    expect(bars.record.height).toBeCloseTo(seconds.record.height, 2);
    expect(bars.control.height).toBeCloseTo(seconds.control.height, 2);
    await page.locator('#time-mode-seconds').click();
    const restored = await layout();
    expect(restored.record.height).toBeCloseTo(seconds.record.height, 2);
  }
});

test('Song lights the Gate and Pitch buttons of the Pattern it is playing', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  await page.locator('#time-mode-seconds').click(); // These steps begin in Seconds; a new app starts in Bars.
  const session = await saveSession(page);
  for (const index of [0, 1]) {
    session.channels[0].timbre.gatePatterns[index].recording = { durationSec: .6, selectionStartSec: 0, selectionEndSec: .6,
      gates: [{ onSec: .05, offSec: .3 }] };
  }
  await page.locator('#patch-file').setInputFiles({ name: 'song-glow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  const lit = () => page.evaluate(() => [...document.querySelectorAll('.source-choice button[data-song-playing]')].map(button => button.id));
  expect(await lit()).toEqual([]);
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(lit).toEqual(['source-user-1', 'pitch-user-1']);
  await expect(page.locator('#source-user-1')).toHaveAttribute('aria-label', /playing in Chain$/);
  const glow = await page.locator('#source-user-1').evaluate(node => getComputedStyle(node).boxShadow);
  expect(glow).not.toBe('none');
  await expect.poll(lit, { timeout: 2000 }).toEqual(['source-user-2', 'pitch-user-2']);
  await page.locator('#song-toggle').click();
  await expect.poll(lit).toEqual([]);
});

test('Song keeps playing through Pattern edits and plays them from the next section head', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  for (const index of [0, 1]) {
    session.channels[0].timbre.gatePatterns[index].recording = { durationSec: 4, selectionStartSec: 0, selectionEndSec: 1,
      gates: [{ onSec: .1, offSec: .5 }] };
  }
  session.channels[0].timbre.pitchPatterns[0].recording = { durationSec: 4, selectionStartSec: 0, selectionEndSec: 1,
    points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 4, valueNormalized: 1 }] };
  // One-bar sections (2 s at 120 BPM) keep the wait for the next section short.
  session.song.timingMode = 'bars'; session.song.frameBars = 1;
  await page.locator('#patch-file').setInputFiles({ name: 'song-live.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#song-duration')).not.toContainText('Pattern 3');
  await page.locator('#song-toggle').click();
  await expect(page.locator('#song-clock')).toContainText('Pattern 1');
  const playing = page.locator('#song-toggle');
  await page.locator('#sequence-pitch-scale').evaluate(node => {
    const slider = node.closest('.numeric-control').querySelector('input[type="range"]');
    slider.value = '2500'; slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(playing).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#gate-apply-bars').click();
  await expect(page.locator('#record-end-value')).toHaveText('2.00 s');
  await expect(playing).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#sequence-stretch-bars').selectOption('2');
  await expect(playing).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#copy-from').selectOption('user-1'); await page.locator('#copy-to').selectOption('user-3');
  await page.locator('#copy-user').click();
  await expect(page.locator('#patch-status')).toContainText('Copied Timbre 1 Pattern 1 → Pattern 3.');
  await expect(playing).toHaveAttribute('aria-pressed', 'true');
  // The edits started at the next section head: Pattern 2 follows, then the copied Pattern 3.
  await expect(page.locator('#song-clock')).toContainText('Pattern 2', { timeout: 5000 });
  await expect(page.locator('#song-clock')).toContainText('Pattern 3', { timeout: 5000 });
  await playing.click();
});

test('SONG grid chooses each timbre Pattern for Song, skips a Pattern no timbre plays, and is saved', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  const recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .5 }] };
  session.channels[1].timbre = structuredClone(session.channels[0].timbre);
  for (const index of [0, 1, 2]) session.channels[0].timbre.gatePatterns[index].recording = recording;
  for (const index of [0, 1]) session.channels[1].timbre.gatePatterns[index].recording = recording;
  await page.locator('#patch-file').setInputFiles({ name: 'arrange.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  const t1p3 = page.locator('#song-arrange-1-3'), t2p2 = page.locator('#song-arrange-2-2');
  await expect(t1p3).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#song-arrange-2-3')).toHaveAttribute('data-empty', '');
  await expect(page.locator('#song-arrange-3-1')).toBeHidden();
  await expect(page.locator('#song-duration')).toContainText('Song: Pattern 1, Pattern 2, Pattern 3');
  // Pattern 3 is only Timbre 1's: leaving it out removes the section. Pattern 2 stays for Timbre 1 while Timbre 2 rests.
  // The first tap frames a cell; the second turns it on or off.
  await t1p3.click(); await expect(t1p3).toHaveAttribute('aria-pressed', 'true');
  await t1p3.click(); await t2p2.click(); await t2p2.click();
  await expect(t1p3).toHaveAttribute('aria-pressed', 'false');
  await expect(t2p2).toHaveAttribute('aria-label', 'Timbre 2 Frame 2: rests in Chain, Loop uses its Gate and Pitch, tap again to turn on or off');
  await expect(page.locator('#song-duration')).toHaveText(/Song: Pattern 1, Pattern 2$/);
  await expect(page.locator('.song-arrange-head').nth(2)).not.toHaveAttribute('data-in-song', '');
  await page.locator('#song-toggle').click();
  await expect(page.locator('.song-arrange-head').nth(0)).toHaveAttribute('data-song-playing', '');
  await page.locator('#song-toggle').click();
  const saved = await saveSession(page);
  expect(saved.channels[0].timbre.gatePatterns.map(item => item.inSong)).toEqual([true, true, false, true, true, true, true, true]);
  expect(saved.channels[1].timbre.gatePatterns[1].inSong).toBe(false);
  await page.locator('#patch-file').setInputFiles({ name: 'arrange-roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#song-arrange-1-3')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#song-arrange-2-2')).toHaveAttribute('aria-pressed', 'false');
});

test('a SONG cell opens its timbre and Patterns in SEQUENCE while TIMBRES is hidden; only the framed cell turns on or off', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  const recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .5 }] };
  session.channels[1].timbre = structuredClone(session.channels[0].timbre);
  session.channels[1].timbre.name = 'Second';
  for (const index of [0, 1]) session.channels[1].timbre.gatePatterns[index].recording = recording;
  await page.locator('#patch-file').setInputFiles({ name: 'jump.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#timbres-toggle').click();
  await expect(page.locator('.lab-body')).toHaveAttribute('data-mixer-collapsed', 'true');
  await page.locator('#trigger-menu').click();
  const t2p2 = page.locator('#song-arrange-2-2');
  await expect(page.locator('#select-1')).toHaveAttribute('aria-pressed', 'true');
  await t2p2.click();
  await expect(page.locator('#select-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#source-user-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pitch-user-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(t2p2).toHaveAttribute('data-focus', '');
  await expect(t2p2).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.song-arrange-row[data-selected] .song-arrange-label')).toHaveText('2. Second');
  // Frame n holds Pattern n, so the frame follows the Gate Pattern SEQUENCE edits.
  await page.locator('#source-user-1').click();
  await expect(page.locator('#song-arrange-2-1')).toHaveAttribute('data-focus', '');
  await expect(t2p2).not.toHaveAttribute('data-focus', '');
  await t2p2.click(); await expect(t2p2).toHaveAttribute('aria-pressed', 'true');
  await t2p2.click(); await expect(t2p2).toHaveAttribute('aria-pressed', 'false');
  // An empty cell selects its Pattern for recording but has nothing to turn on.
  const empty = page.locator('#song-arrange-2-5');
  await empty.click(); await expect(page.locator('#source-user-5')).toHaveAttribute('aria-pressed', 'true');
  await empty.click(); await expect(empty).toHaveAttribute('aria-pressed', 'false');
  await expect(empty).toHaveAttribute('aria-label', 'Timbre 2 Frame 5: no recording, Loop uses its Gate and Pitch, selected in SEQUENCE');
  // A recording holds the selected timbre.
  await page.locator('#record-toggle').click(); await expect(page.locator('#record-toggle')).toHaveAttribute('aria-label', 'End Recording');
  await page.locator('#song-arrange-1-1').click();
  await expect(page.locator('#select-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#record-toggle').click();
  const saved = await saveSession(page);
  expect(saved.channels[1].timbre.gatePatterns[1].inSong).toBe(false);
});

test('during Play All a SONG timbre name selects only the timbre, and bars show the Gate and Pitch each timbre plays', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  const recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .5 }] };
  session.channels[1].timbre = structuredClone(session.channels[0].timbre);
  for (const channel of [0, 1]) for (const index of [0, 1]) session.channels[channel].timbre.gatePatterns[index].recording = recording;
  session.channels[1].timbre.sequence = { ...session.channels[1].timbre.sequence, gateMode: 'user', gateUserId: 'user-2', pitchUserId: 'user-3' };
  await page.locator('#patch-file').setInputFiles({ name: 'names.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#timbres-toggle').click();
  await page.locator('#trigger-menu').click();
  // Timbre 1 uses Auto Gate, so only its Pitch bar shows; Timbre 2 plays Gate 2 with Pitch 3.
  await expect(page.locator('#song-arrange-1-1')).toHaveAttribute('data-sequence', 'pitch');
  await expect(page.locator('#song-arrange-2-2')).toHaveAttribute('data-sequence', 'gate');
  await expect(page.locator('#song-arrange-2-3')).toHaveAttribute('data-sequence', 'pitch');
  await expect(page.locator('#song-arrange-2-2')).not.toHaveAttribute('data-sequence-playing', '');
  await page.locator('#play-all').click();
  await expect(page.locator('#song-arrange-2-2')).toHaveAttribute('data-sequence-playing', '');
  await expect(page.locator('#song-arrange-2-3')).toHaveAttribute('data-sequence-playing', '');
  const name = page.locator('#song-arrange-name-2');
  await name.click();
  await expect(page.locator('#select-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(name).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#source-user-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pitch-user-3')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#song-arrange-2-2')).toHaveAttribute('data-sequence-playing', '');
  await expect(page.locator('#play-all')).toHaveAttribute('aria-pressed', 'true');
  // No cell is framed after a name tap: the next cell tap selects, it does not turn a cell off.
  await expect(page.locator('#song-arrange [data-focus]')).toHaveCount(0);
  // A cell tap still switches what that timbre plays.
  await page.locator('#song-arrange-2-1').click();
  await expect(page.locator('#song-arrange-2-1')).toHaveAttribute('data-sequence', 'gate pitch');
  await expect(page.locator('#song-arrange-2-1')).toHaveAttribute('data-sequence-playing', '');
  await page.locator('#play-all').click();
  await expect(page.locator('#song-arrange-2-1')).not.toHaveAttribute('data-sequence-playing', '');
});

test('the header SEQUENCE button opens SEQUENCE, where Loop and Chain stop each other', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  const session = await saveSession(page);
  session.channels[0].timbre.gatePatterns[0].recording = { durationSec: 1, selectionStartSec: 0, selectionEndSec: 1, gates: [{ onSec: .1, offSec: .5 }] };
  await page.locator('#patch-file').setInputFiles({ name: 'loop.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await page.locator('#map-toggle').click(); await page.locator('#timbres-toggle').click();
  const open = page.locator('#sequence-open'), sequence = page.locator('[data-panel="triggering"]');
  await expect(sequence).toBeHidden();
  await open.click();
  await expect(sequence).toBeVisible(); await expect(open).toHaveClass(/active/);
  // Unlike the map node, a second press keeps SEQUENCE open.
  await open.click();
  await expect(sequence).toBeVisible();
  const loop = page.locator('#play-all'), chain = page.locator('#song-toggle');
  await expect(loop).toHaveText('▶ Loop'); await expect(chain).toHaveText('▶ Chain');
  await loop.click();
  await expect(loop).toHaveText('■ Stop Loop'); await expect(loop).toHaveAttribute('aria-pressed', 'true');
  await chain.click();
  await expect(chain).toHaveText('■ Stop Chain'); await expect(loop).toHaveText('▶ Loop');
  await loop.click();
  await expect(loop).toHaveText('■ Stop Loop'); await expect(chain).toHaveText('▶ Chain');
  await loop.click();
  await expect(page.locator('.song-arrange-corner')).toHaveText('In Chain');
});

test('SONG shows no summary line; the grid carries the sections and the playing Pattern', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#trigger-menu').click();
  await expect(page.locator('#song-arrange')).toBeVisible();
  await expect(page.locator('#song-duration')).toBeHidden();
  await expect(page.locator('#song-clock')).toBeHidden();
});
