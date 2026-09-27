import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { openTimbreEditors } from './editor-helpers.mjs';

// Match normal browser startup: audio may not run before the first gesture.
test.use({ launchOptions: { args: ['--autoplay-policy=user-gesture-required'] } });

test('sample loaded with FEnv already ON changes the live Filter1 response without a diagnostic tap', async ({ page }, info) => {
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.__sampleContext = this; }
      createDynamicsCompressor() { const node = super.createDynamicsCompressor(); window.__sampleOutput = node; return node; }
    };
  });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await page.locator('#timbre-file-1').setInputFiles('user_presets/FEnv-Sweep-Check.timbre.json');
  await expect(page.locator('#name-1')).toHaveValue('FEnv Sweep Check');
  await page.evaluate(() => {
    const meter = window.__sampleContext.createAnalyser(); meter.fftSize = 2048; meter.smoothingTimeConstant = 0;
    window.__sampleOutput.connect(meter);
    window.__sampleRead = () => {
      const data = new Float32Array(meter.frequencyBinCount); meter.getFloatFrequencyData(data);
      const bin = hz => Math.round(hz * meter.fftSize / window.__sampleContext.sampleRate);
      return Math.max(...data.slice(bin(1000), bin(4000))) - Math.max(...data.slice(bin(180), bin(260)));
    };
  });
  const result = { initialState: await page.evaluate(() => window.__sampleContext.state) };
  for (const enabled of [true, false]) {
    if (!enabled) await page.locator('[data-editor-card="fenv"] [data-block-toggle="fenv"]').click();
    const gate = await page.locator('#gate-1').boundingBox();
    await page.mouse.move(gate.x + gate.width / 2, gate.y + gate.height / 2); await page.mouse.down();
    try {
      await page.waitForTimeout(200); const early = await page.evaluate(() => window.__sampleRead());
      await page.waitForTimeout(1200); const late = await page.evaluate(() => window.__sampleRead());
      result[enabled ? 'on' : 'off'] = { early, late };
    } finally { await page.mouse.up(); }
    await page.waitForTimeout(200);
  }
  await writeFile(info.outputPath('sample-response.json'), JSON.stringify(result, null, 2));
  expect(result.on.early - result.off.early).toBeGreaterThan(15);
  expect(Math.abs(result.on.late - result.off.late)).toBeLessThan(3);
  expect(Math.abs(result.off.early - result.off.late)).toBeLessThan(3);
});

test('UI FEnv Amount reaches the live Filter1 detune after first audio resume', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.__fenvContext = this; }
      createBiquadFilter() {
        const node = super.createBiquadFilter(); (window.__detuneParams ??= []).push(node.detune); return node;
      }
      createGain() {
        const gain = super.createGain(), connect = gain.connect.bind(gain);
        gain.connect = (...args) => {
          if (window.__detuneParams?.includes(args[0])) {
            (window.__detuneSources ??= []).push(gain);
          }
          return connect(...args);
        };
        return gain;
      }
    };
  });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await openTimbreEditors(page, ['fenv']);
  for (const [id, value] of [['fenv-amount', '3600'], ['fenv-attack', '0'], ['fenv-decay', '0'], ['fenv-sustain', '1']]) {
    await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).dispatchEvent('change');
  }
  await page.locator('[data-editor-card="fenv"] [data-block-toggle="fenv"]').click();
  await page.evaluate(() => {
    const meter = window.__fenvContext.createAnalyser(); meter.fftSize = 256;
    window.__detuneSources[2].connect(meter);
    window.__fenvRead = () => { const data = new Float32Array(256); meter.getFloatTimeDomainData(data); return data[128]; };
  });
  const gate = await page.locator('#gate-1').boundingBox();
  await page.mouse.move(gate.x + gate.width / 2, gate.y + gate.height / 2); await page.mouse.down();
  try { await expect.poll(() => page.evaluate(() => window.__fenvRead())).toBeGreaterThan(3500); }
  finally { await page.mouse.up(); }
});

test('UI held TRG renders the audible one-second FEnv sweep', async ({ page }, info) => {
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.__sweepContext = this; }
      createDynamicsCompressor() { const node = super.createDynamicsCompressor(); window.__sweepOutput = node; return node; }
    };
  });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const patch = await page.evaluate(async () => {
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const patch = defaultTimbre('FEnv diagnostic');
    patch.settings.osc1.sourceType = 'sawtooth'; patch.settings.osc1.baseFrequencyHz = 220;
    Object.assign(patch.settings.blocksEnabled, { osc2: false, penv: false, mod: false, filter1: true });
    patch.settings.filter1 = { type: 'lowpass', order: 4, frequencyHz: 400, q: .707 };
    patch.settings.ampEnvelope.sustain = 1;
    return patch;
  });
  await page.locator('#timbre-file-1').setInputFiles({ name: 'diagnostic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await openTimbreEditors(page, ['fenv']);
  for (const [id, value] of [['fenv-amount', '3600'], ['fenv-attack', '5'], ['fenv-decay', '1000'], ['fenv-sustain', '0'], ['fenv-release', '100']]) {
    await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).dispatchEvent('change');
  }
  await page.locator('#fenv-curve + .segmented-choice [data-value="linear"]').click();
  await page.locator('[data-editor-card="fenv"] [data-block-toggle="fenv"]').click();
  patch.settings.blocksEnabled.fenv = true;
  Object.assign(patch.settings.filterEnvelope, { amountCent: 3600, attackSec: .005, decaySec: 1, sustain: 0,
    releaseSec: .1, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' });
  patch.editorLayout = ['filter1', 'fenv'];
  await writeFile(info.outputPath('fenv-diagnostic.json'), JSON.stringify(patch, null, 2));
  await page.evaluate(() => {
    const meter = window.__sweepContext.createAnalyser(); meter.fftSize = 2048; meter.smoothingTimeConstant = 0;
    window.__sweepOutput.connect(meter);
    window.__sweepRead = () => {
      const data = new Float32Array(meter.frequencyBinCount); meter.getFloatFrequencyData(data);
      return Math.max(...data.slice(Math.ceil(1000 * meter.fftSize / window.__sweepContext.sampleRate), Math.floor(4000 * meter.fftSize / window.__sweepContext.sampleRate)));
    };
  });
  const gate = await page.locator('#gate-1').boundingBox();
  await page.mouse.move(gate.x + gate.width / 2, gate.y + gate.height / 2); await page.mouse.down();
  try {
    await page.waitForTimeout(200); const bright = await page.evaluate(() => window.__sweepRead());
    await page.waitForTimeout(1200); const dark = await page.evaluate(() => window.__sweepRead());
    await writeFile(info.outputPath('spectrum.json'), JSON.stringify({ brightDb: bright, darkDb: dark, differenceDb: bright - dark }, null, 2));
    expect(bright - dark).toBeGreaterThan(15);
  } finally { await page.mouse.up(); }
  const samples = await page.evaluate(async settings => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const combined = [];
    // Three two-second notes with half-second gaps: disabled, positive, negative.
    for (const variant of ['off', 'positive', 'negative']) {
      const context = new OfflineAudioContext(1, 120000, 48000), value = structuredClone(settings);
      value.phaseMode = 'sync'; value.blocksEnabled.fenv = variant !== 'off';
      if (variant === 'negative') { value.filter1.frequencyHz = 3200; value.filterEnvelope.amountCent = -3600; }
      const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), value, 0);
      synth.output.connect(context.destination); synth.gateOn(.05); synth.gateOff(2.05);
      const data = (await context.startRendering()).getChannelData(0);
      combined.push(...data); synth.dispose();
    }
    return combined;
  }, patch.settings);
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2));
  await writeFile(info.outputPath('fenv-off-positive-negative.wav'), wav);
});

test('FEnv shares ADSR controls, keeps independent values and round-trips cards/settings', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  await openTimbreEditors(page, ['aenv', 'fenv']);
  await page.locator('#fenv-amount').fill('-2400'); await page.locator('#fenv-amount').dispatchEvent('change');
  await page.locator('#fenv-attack').fill('45'); await page.locator('#fenv-attack').dispatchEvent('change');
  await expect(page.locator('#attack')).toHaveValue('5');
  await page.locator('#fenv-release-timing + .segmented-choice [data-value="rate"]').click();
  await expect(page.locator('#fenv-curve-status')).toBeVisible();
  await expect(page.locator('#aenv-curve-status')).toBeHidden();
  await page.locator('#fenv-mode + .segmented-choice [data-value="one-shot"]').click();
  await expect(page.locator('#aenv-mode')).toHaveValue('gate');
  await page.locator('[data-editor-card="fenv"] [data-block-toggle="fenv"]').click();
  await page.locator('[data-editor-card="fenv"] .editor-card-handle').press('ArrowLeft');
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const value = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(value.formatVersion).toBe('KOROGI-Lab/timbre-v14');
  expect(value.editorLayout).toEqual(['fenv', 'aenv']); expect(value.settings.blocksEnabled.fenv).toBe(true);
  expect(value.settings.filterEnvelope).toMatchObject({ amountCent: -2400, attackSec: .045,
    mode: 'one-shot', releaseTiming: 'rate', releaseCurve: 'linear', attackCurve: 'exponential' });
  await page.locator('#timbre-file-1').setInputFiles({ name: 'fenv.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
  await expect(page.locator('#fenv-amount')).toHaveValue('-2400');
  await page.locator('#fenv-curve + .segmented-choice [data-value="exponential"]').click();
  await expect(page.locator('#fenv-release-timing')).toHaveValue('time');
  await expect(page.locator('#fenv-curve-status')).toBeHidden();
  await page.locator('[data-editor-card="fenv"] .editor-card-close').click();
  await expect(page.locator('[data-flow-block-wrapper="fenv"] [data-block-toggle]')).toHaveAttribute('aria-pressed', 'true');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 },
  { width: 1194, height: 834 }, { width: 360, height: 800 }, { width: 844, height: 390 }]) {
  test(`FEnv and AEnv retain equal ADSR layout at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport); await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
    await openTimbreEditors(page, ['aenv', 'fenv']);
    const result = await page.evaluate(() => {
      const sizes = prefix => ['attack', 'decay', 'sustain', 'release'].map(phase => {
        const id = prefix === 'aenv' ? phase : `${prefix}-${phase}`;
        const rect = document.getElementById(`${id}-coarse`).getBoundingClientRect();
        return { width: rect.width, top: rect.top };
      });
      const fenv = document.querySelector('[data-editor-card="fenv"]');
      const choicesFit = [...fenv.querySelectorAll('.segmented-choice')].every(row => row.scrollWidth <= row.clientWidth + 1);
      const f = document.getElementById('flow-fenv').getBoundingClientRect(), filter = document.getElementById('flow-filter1').getBoundingClientRect();
      return { a: sizes('aenv'), f: sizes('fenv'), choicesFit, wire: { gap: f.top - filter.bottom, dx: filter.x - f.x },
        pageFits: document.documentElement.scrollWidth <= innerWidth };
    });
    expect(result.choicesFit && result.pageFits).toBe(true);
    expect(result.wire.gap).toBeGreaterThan(0); expect(result.wire.dx).toBeCloseTo(0, 1);
    for (let i = 0; i < 4; i++) { expect(result.a[i].width).toBeGreaterThan(65); expect(result.f[i].width).toBeCloseTo(result.a[i].width, 1); }
    expect(new Set(result.f.map(x => x.top)).size).toBe(1);
    await page.locator('#fenv-amount').scrollIntoViewIfNeeded(); await expect(page.locator('#fenv-amount')).toBeVisible();
    await page.screenshot({ path: info.outputPath('fenv-layout.png') });
  });
}

test('rendered signed envelope matches logical curves, weak Release, zero endpoints and bypass', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const results = await page.evaluate(async () => {
    const { FilterEnvelopeControl } = await import('/src/audio/dsp/FilterEnvelopeControl.ts');
    const results = [];
    for (const rate of [44100, 48000]) for (const curve of ['linear', 'exponential'])
      for (const amountCent of [-4800, 0, 4800]) for (const mode of ['gate', 'one-shot']) for (const sustain of [0, .5, 1]) {
        const context = new OfflineAudioContext(1, rate, rate);
        const settings = { amountCent, mode, attackSec: .1, decaySec: .1, sustain, releaseSec: .2,
          attackCurve: curve, decayCurve: curve, releaseCurve: curve, releaseTiming: 'time' };
        const env = new FilterEnvelopeControl(context, settings); env.output.connect(context.destination);
        env.gateOn(.1); env.gateOff(.15);
        const times = [.125, .15, .2, .3, .4, .5, .6];
        const logical = times.map(t => env.centValueAt(t));
        const data = (await context.startRendering()).getChannelData(0);
        const audio = times.map(t => data[Math.round(t * rate)]);
        results.push({ rate, curve, amountCent, mode, logical, audio, finite: data.every(Number.isFinite) });
      }
    for (const timing of ['time', 'rate']) {
      const context = new OfflineAudioContext(1, 48000, 48000);
      const env = new FilterEnvelopeControl(context, { amountCent: -1200, mode: 'gate', attackSec: .1,
        decaySec: 0, sustain: 1, releaseSec: .2, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: timing });
      env.output.connect(context.destination); env.gateOn(.1); env.gateOff(.15);
      const data = (await context.startRendering()).getChannelData(0);
      results.push({ timing, weak: [.15, .2, .25, .35].map(t => data[Math.round(t * 48000)]) });
    }
    const context = new OfflineAudioContext(1, 48000, 48000);
    const env = new FilterEnvelopeControl(context, { amountCent: 1200, mode: 'gate', attackSec: 0,
      decaySec: 0, sustain: 1, releaseSec: 0, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear', releaseTiming: 'time' });
    env.output.connect(context.destination); env.gateOn(.02); env.gateOff(.4);
    const off = context.suspend(.1), on = context.suspend(.2), rendering = context.startRendering();
    await off; env.setEnabled(false); await context.resume(); await on; env.setEnabled(true); await context.resume();
    const data = (await rendering).getChannelData(0);
    return { results, bypass: [.05, .15, .25, .5].map(t => data[Math.round(t * 48000)]) };
  });
  for (const result of results.results) {
    if (result.timing) {
      expect(result.weak[0]).toBeCloseTo(-600, 1); expect(result.weak[1]).toBeCloseTo(result.timing === 'rate' ? -300 : -450, 1);
      expect(result.weak[2]).toBeCloseTo(result.timing === 'rate' ? 0 : -300, 1); expect(result.weak[3]).toBeCloseTo(0, 1);
    } else {
      expect(result.finite).toBe(true);
      for (let i = 0; i < result.audio.length; i++) expect(Math.abs(result.audio[i] - result.logical[i])).toBeLessThan(2);
      expect(result.audio.at(-1)).toBeCloseTo(0, 4);
    }
  }
  expect(results.bypass[0]).toBeCloseTo(1200, 2); expect(results.bypass[1]).toBeCloseTo(0, 4);
  expect(results.bypass[2]).toBeCloseTo(1200, 2); expect(results.bypass[3]).toBeCloseTo(0, 4);
});

test('Filter1 adds FEnv and existing cutoff route on both stages; all filters and endpoints stay finite', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const results = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const render = async (rate, type, order, frequencyHz, amountCent, reference = false, bypass = false) => {
      const context = new OfflineAudioContext(1, Math.round(rate * .3), rate);
      const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS); settings.phaseMode = 'free';
      settings.osc1 = { ...settings.osc1, sourceType: 'sawtooth', baseFrequencyHz: 900 };
      settings.blocksEnabled = { ...settings.blocksEnabled, osc2: false, aenv: false, filter1: !bypass, fenv: true };
      settings.filter1 = { type, order, frequencyHz: reference ? frequencyHz * 2 ** ((amountCent + 150) / 1200) : frequencyHz, q: .707 };
      settings.filter2Route = 'filter1-cutoff'; settings.filter1CutoffDepthCent = reference ? 0 : 300;
      settings.filterEnvelope = { ...settings.filterEnvelope, amountCent: reference ? 0 : amountCent,
        attackSec: 0, decaySec: 0, sustain: 1, mode: 'gate' };
      const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
      const source = context.createConstantSource(); source.offset.value = .5; source.connect(synth.cutoffDepthGain); source.start();
      synth.output.connect(context.destination); synth.gateOn(.02);
      const data = (await context.startRendering()).getChannelData(0);
      return Array.from(data.slice(Math.round(rate * .15)));
    };
    const results = [];
    for (const rate of [44100, 48000]) for (const type of ['lowpass', 'bandpass', 'highpass']) for (const order of [2, 4]) {
      for (const amountCent of [-1200, 1200]) {
        const actual = await render(rate, type, order, 2000, amountCent);
        const expected = await render(rate, type, order, 2000, amountCent, true);
        results.push({ maxError: Math.max(...actual.map((x, i) => Math.abs(x - expected[i]))), finite: actual.every(Number.isFinite) });
      }
      for (const hz of [1, 20000]) { const data = await render(rate, type, order, hz, hz === 1 ? -4800 : 4800);
        results.push({ finite: data.every(Number.isFinite) }); }
    }
    const bypass = await render(48000, 'lowpass', 4, 2000, 4800, false, true);
    const bypassRef = await render(48000, 'lowpass', 4, 2000, 0, true, true);
    results.push({ finite: bypass.every(Number.isFinite), maxError: Math.max(...bypass.map((x, i) => Math.abs(x - bypassRef[i]))) });
    return results;
  });
  for (const result of results) { expect(result.finite).toBe(true); if (result.maxError !== undefined) expect(result.maxError).toBeLessThan(.0001); }
});

test('BURST cancellation restores FEnv owned release in the live ChannelSynth and renders it', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000), settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.blocksEnabled.fenv = true; settings.ampEnvelope = { ...settings.ampEnvelope, mode: 'one-shot',
      attackSec: 0, decaySec: .01, sustain: .5, releaseSec: .02 };
    settings.burst = { enabled: true, pulseCountMin: 1, pulseCountMax: 1,
      pulseIntervalSec: .025, pulseIntervalJitter: 0, groupPeriodSec: .05, groupPeriodJitter: 0 };
    settings.filterEnvelope = { ...settings.filterEnvelope, amountCent: -1200,
      attackSec: 0, decaySec: .01, sustain: .5, releaseSec: .1, mode: 'gate',
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.fEnv.output.connect(context.destination); synth.gateOn(.02);
    // Scheduler lookahead submitted .02 and .07; remove the unstarted second group.
    const stop = context.suspend(.04), rendering = context.startRendering();
    await stop; synth.gateOff(context.currentTime); await context.resume();
    const data = (await rendering).getChannelData(0);
    return [.03, .05, .075, .1, .16].map(t => data[Math.round(t * 48000)]);
  });
  expect(result[0]).toBeCloseTo(-600, 1); expect(result[1]).toBeCloseTo(-600, 1);
  expect(result[2]).toBeCloseTo(-450, 1); expect(result[3]).toBeCloseTo(-300, 1); expect(result[4]).toBeCloseTo(0, 3);
});

test('Trigger overlay retains FEnv base Gate, snapshots future Amount and releases after the last owner', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000), settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.blocksEnabled.fenv = true;
    settings.filterEnvelope = { ...settings.filterEnvelope, amountCent: 1200, attackSec: 0, decaySec: 0,
      sustain: .5, releaseSec: .05, releaseCurve: 'linear' };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.fEnv.output.connect(context.destination); synth.gateOn(.1);
    synth.setFilterEnvelope({ ...settings.filterEnvelope, amountCent: -1200 }); synth.gateOn(.3); synth.gateOff(.35);
    synth.setFilterEnvelope({ ...settings.filterEnvelope, amountCent: 4800 });
    const actions = [[.12, () => synth.triggerGateOn()], [.13, () => synth.triggerGateOff()], [.145, null],
      [.21, null], [.32, null], [.375, null], [.41, null]];
    const suspensions = actions.map(([t]) => context.suspend(t)), rendering = context.startRendering();
    const logical = [];
    for (let i = 0; i < actions.length; i++) { await suspensions[i]; actions[i][1]?.();
      logical.push(synth.fEnv.centValueAt(context.currentTime)); await context.resume(); }
    const data = (await rendering).getChannelData(0);
    return { logical, samples: [.145, .21, .32, .375, .41].map(t => data[Math.round(t * 48000)]) };
  });
  expect(result.logical[2]).toBeCloseTo(2400, 2); expect(result.logical[3]).toBeCloseTo(2400, 2);
  expect(result.samples[0]).toBeCloseTo(2400, 2); expect(result.samples[1]).toBeCloseTo(2400, 2);
  expect(result.samples[2]).toBeCloseTo(-600, 2); expect(result.samples[3]).toBeCloseTo(-300, 1);
  expect(result.samples[4]).toBeCloseTo(0, 3);
});

test('FEnv One-shot restarts for each BURST pulse, ignores display OFF and completes after the phrase', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000), settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.blocksEnabled.fenv = true; settings.ampEnvelope.mode = 'one-shot';
    settings.burst = { enabled: true, pulseCountMin: 3, pulseCountMax: 3, pulseIntervalSec: .025,
      pulseIntervalJitter: 0, groupPeriodSec: .1, groupPeriodJitter: 0 };
    settings.filterEnvelope = { ...settings.filterEnvelope, amountCent: 1200, mode: 'one-shot', attackSec: 0,
      decaySec: .01, sustain: .5, releaseSec: .01, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.fEnv.output.connect(context.destination); synth.gateOn(.02); synth.gateOff(.03);
    const data = (await context.startRendering()).getChannelData(0);
    return [.021, .036, .046, .071, .08, .09, .13].map(t => data[Math.round(t * 48000)]);
  });
  expect(result[0]).toBeCloseTo(1140, 1); expect(result[1]).toBeCloseTo(240, 1);
  expect(result[2]).toBeCloseTo(1140, 1); expect(result[3]).toBeCloseTo(1140, 1);
  expect(result[4]).toBeCloseTo(600, 1); expect(result[5]).toBeCloseTo(0, 3); expect(result[6]).toBeCloseTo(0, 3);
});

test('FEnv Auto ownership ignores stale Manual OFF and stop cancels future Gates', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 48000, 48000), settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.blocksEnabled.fenv = true; settings.autoTrigger = { tonSec: .1, repeatSec: .2 };
    settings.filterEnvelope = { ...settings.filterEnvelope, amountCent: 1200, attackSec: 0, decaySec: 0,
      sustain: .5, releaseSec: .05, releaseCurve: 'linear' };
    const synth = new ChannelSynth(context, new WhiteNoiseFactory(context), settings, 0);
    synth.fEnv.output.connect(context.destination); synth.gateOn(0);
    const actions = [[.02, () => synth.startAutoTrigger()], [.04, () => synth.gateOff()], [.06, null],
      [.08, () => synth.stopAutoTrigger()], [.16, null], [.3, null]];
    const suspensions = actions.map(([t]) => context.suspend(t)), rendering = context.startRendering();
    let stopTime;
    for (let i = 0; i < actions.length; i++) { await suspensions[i]; actions[i][1]?.();
      if (i === 3) stopTime = context.currentTime; await context.resume(); }
    const data = (await rendering).getChannelData(0);
    synth.dispose();
    return { stopTime, samples: [.06, .1, .16, .3].map(t => data[Math.round(t * 48000)]) };
  });
  expect(result.samples[0]).toBeCloseTo(600, 1);
  expect(result.samples[1]).toBeGreaterThan(300); expect(result.samples[1]).toBeLessThan(430);
  expect(result.samples[2]).toBeCloseTo(0, 3); expect(result.samples[3]).toBeCloseTo(0, 3);
});
