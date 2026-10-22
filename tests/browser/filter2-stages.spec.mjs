import { test, expect } from '@playwright/test';
import { openTimbreEditors } from './editor-helpers.mjs';

// FILTER2: two series stages (Stage2 Off passes through), Shelf/Peak gain, the 1st order and the FEnv Target.

/** Offline RMS of an OSC2 sine alone (AEnv OUT, OSC1 off) for each case; `edit` mutates the settings. */
async function renderCases(page, cases, legacy = false) {
  return page.evaluate(async ([cases, legacy]) => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre, normalizeTimbre } = await import('/src/model/documents.ts');
    const rate = 48000, out = {};
    for (const [name, edit] of Object.entries(cases)) {
      const context = new OfflineAudioContext(1, Math.round(rate * .2), rate);
      const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      engine.setMasterGainDb(0);
      const timbre = defaultTimbre(), s = timbre.settings;
      s.blocksEnabled.osc1 = false; s.blocksEnabled.filter2 = true;
      s.osc2.sourceType = 'sine'; s.filter2Route = 'aenv-out';
      s.ampEnvelope2 = { ...s.ampEnvelope2, attackSec: 0, decaySec: 0, sustain: 1, releaseSec: .002, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' };
      new Function('s', edit)(s);
      // `legacy` saves the case as a timbre-v20 file (Q in Web Audio's dB for LPF/HPF) and loads it back.
      engine.replaceChannel('1', legacy ? normalizeTimbre({ ...structuredClone(timbre), formatVersion: 'KOROGI-Lab/timbre-v20' }) : timbre);
      engine.gateOn('1', 0);
      const samples = (await context.startRendering()).getChannelData(0);
      const a = Math.round(.08 * rate), b = Math.round(.18 * rate);
      let sum = 0; for (let i = a; i < b; i++) sum += samples[i] * samples[i];
      out[name] = { finite: samples.every(Number.isFinite), rms: Math.sqrt(sum / (b - a)) };
      engine.dispose();
    }
    return out;
  }, [cases, legacy]);
}

/** Biquad magnitude (Audio EQ Cookbook) in dB for the linear Q the Lab stores (ADR 0017); Shelves use S = 1. */
function biquadDb(type, f0, q, gainDb, hz, rate = 48000) {
  const w0 = 2 * Math.PI * f0 / rate, c = Math.cos(w0), s = Math.sin(w0), A = 10 ** (gainDb / 40);
  const alpha = type === 'lowshelf' || type === 'highshelf' ? s / 2 * Math.SQRT2 : s / (2 * q);
  const sa = 2 * Math.sqrt(A) * alpha;
  const k = {
    lowpass: [[(1 - c) / 2, 1 - c, (1 - c) / 2], [1 + alpha, -2 * c, 1 - alpha]],
    highpass: [[(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + alpha, -2 * c, 1 - alpha]],
    peaking: [[1 + alpha * A, -2 * c, 1 - alpha * A], [1 + alpha / A, -2 * c, 1 - alpha / A]],
    lowshelf: [[A * ((A + 1) - (A - 1) * c + sa), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sa)],
      [(A + 1) + (A - 1) * c + sa, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sa]]
  }[type];
  const w = 2 * Math.PI * hz / rate;
  const mag = ([b0, b1, b2]) => Math.hypot(b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), b1 * Math.sin(w) + b2 * Math.sin(2 * w));
  return 20 * Math.log10(mag(k[0]) / mag(k[1]));
}
/** 1st-order HPF (prewarped bilinear) magnitude in dB. */
function firstHpDb(fc, hz, rate = 48000) {
  const r = Math.tan(Math.PI * hz / rate) / Math.tan(Math.PI * fc / rate);
  return 20 * Math.log10(r / Math.hypot(1, r));
}

test('Stage2 Off passes through; HPF 1st 1.5 kHz → LPF 2nd 8.49 kHz (linear Q 1.94) in series matches the design response', async ({ page }) => {
  await page.goto('/');
  const q909 = 1.94;
  const freqs = [500, 1500, 4000, 8490, 12000];
  const cases = {};
  for (const hz of freqs) {
    cases[`dry${hz}`] = `s.osc2.baseFrequencyHz = ${hz}; s.blocksEnabled.filter2 = false;`;
    cases[`band${hz}`] = `s.osc2.baseFrequencyHz = ${hz}; s.filter2 = { type: 'highpass', order: 1, frequencyHz: 1500, q: .707, gainDb: 0 };
      s.filter2Stage2 = { type: 'lowpass', order: 2, frequencyHz: 8490, q: ${q909}, gainDb: 0 };`;
  }
  cases.stage1 = "s.osc2.baseFrequencyHz = 3000; s.filter2 = { type: 'lowpass', order: 2, frequencyHz: 2000, q: 2, gainDb: 0 };";
  cases.stage1Off = cases.stage1 + " s.filter2Stage2 = { type: 'off', order: 4, frequencyHz: 300, q: 9, gainDb: 24 };";
  cases.bypass = "s.osc2.baseFrequencyHz = 3000; s.blocksEnabled.filter2 = false; s.filter2Stage2 = { type: 'peaking', order: 4, frequencyHz: 3000, q: 1, gainDb: 24 };";
  cases.dry3000 = "s.osc2.baseFrequencyHz = 3000; s.blocksEnabled.filter2 = false;";
  const r = await renderCases(page, cases);
  for (const item of Object.values(r)) expect(item.finite).toBe(true);
  expect(r.stage1Off.rms).toBeCloseTo(r.stage1.rms, 6);
  expect(r.bypass.rms).toBeCloseTo(r.dry3000.rms, 6);
  for (const hz of freqs) {
    const measured = 20 * Math.log10(r[`band${hz}`].rms / r[`dry${hz}`].rms);
    expect(Math.abs(measured - (firstHpDb(1500, hz) + biquadDb('lowpass', 8490, q909, 0, hz)))).toBeLessThan(.2);
  }
  // The resonant peak of the linear Q 1.94 LPF: about +5.8 dB at the cutoff.
  expect(biquadDb('lowpass', 8490, q909, 0, 8490)).toBeCloseTo(20 * Math.log10(1.94), 1);
});

test('Shelf and Peak reach the set gain at 2nd and 4th order (and 1st-order Shelf)', async ({ page }) => {
  await page.goto('/');
  const stage = (type, order, f0, gain) => `s.filter2Stage2 = { type: '${type}', order: ${order}, frequencyHz: ${f0}, q: 1, gainDb: ${gain} };`;
  const flat = "s.filter2.type = 'highpass'; s.filter2.frequencyHz = 1;";
  const r = await renderCases(page, {
    dryPeak: 's.osc2.baseFrequencyHz = 3000; s.blocksEnabled.filter2 = false;',
    peak2: `s.osc2.baseFrequencyHz = 3000; ${flat} ${stage('peaking', 2, 3000, 12)}`,
    peak4: `s.osc2.baseFrequencyHz = 3000; ${flat} ${stage('peaking', 4, 3000, 12)}`,
    dryLow: 's.osc2.baseFrequencyHz = 100; s.blocksEnabled.filter2 = false;',
    low1: `s.osc2.baseFrequencyHz = 100; ${flat} ${stage('lowshelf', 1, 2000, -12)}`,
    low2: `s.osc2.baseFrequencyHz = 100; ${flat} ${stage('lowshelf', 2, 2000, -12)}`,
    low4: `s.osc2.baseFrequencyHz = 100; ${flat} ${stage('lowshelf', 4, 2000, -12)}`
  });
  const db = (name, dry) => 20 * Math.log10(r[name].rms / r[dry].rms);
  // Stage1 is a 1 Hz HPF here, which is flat at these frequencies.
  expect(db('peak2', 'dryPeak')).toBeCloseTo(biquadDb('peaking', 3000, 1, 12, 3000), 1);
  expect(db('peak4', 'dryPeak')).toBeCloseTo(2 * biquadDb('peaking', 3000, 1, 6, 3000), 1);
  expect(db('peak4', 'dryPeak')).toBeCloseTo(12, 1);
  expect(db('low2', 'dryLow')).toBeCloseTo(biquadDb('lowshelf', 2000, 1, -12, 100), 1);
  expect(db('low4', 'dryLow')).toBeCloseTo(2 * biquadDb('lowshelf', 2000, 1, -6, 100), 1);
  // 1st order: |(j f/fc + G) / (j f/fc + 1)| with the prewarped ratio.
  const ratio = Math.tan(Math.PI * 100 / 48000) / Math.tan(Math.PI * 2000 / 48000), g = 10 ** (-12 / 20);
  expect(db('low1', 'dryLow')).toBeCloseTo(20 * Math.log10(Math.hypot(g, ratio) / Math.hypot(1, ratio)), 1);
});

test('FEnv Target moves Stage1, Stage2 or both cutoffs', async ({ page }) => {
  await page.goto('/');
  const base = `s.osc2.baseFrequencyHz = 3000; s.blocksEnabled.fenv = true; s.filter2FenvDepth = 1;
    s.filterEnvelope = { ...s.filterEnvelope, attackSec: 0, decaySec: 0, sustain: 1, amountCent: 2400, mode: 'gate' };
    s.filter2 = { type: 'lowpass', order: 2, frequencyHz: 1000, q: .707, gainDb: 0 };
    s.filter2Stage2 = { type: 'lowpass', order: 2, frequencyHz: 1000, q: .707, gainDb: 0 };`;
  const r = await renderCases(page, {
    none: base + ' s.filter2FenvDepth = 0;',
    stage1: base + " s.filter2FenvTarget = 'stage1';",
    stage2: base + " s.filter2FenvTarget = 'stage2';",
    both: base + " s.filter2FenvTarget = 'both';",
    firstOrder: base + " s.filter2FenvTarget = 'stage1'; s.filter2.order = 1; s.filter2Stage2.type = 'off';",
    firstOrderStill: base + " s.filter2FenvDepth = 0; s.filter2.order = 1; s.filter2Stage2.type = 'off';"
  });
  // +2400 cent moves a 1 kHz LPF to 4 kHz; the two identical stages give the same single-stage lift.
  const lift = name => 20 * Math.log10(r[name].rms / r.none.rms);
  const one = biquadDb('lowpass', 4000, .707, 0, 3000) - biquadDb('lowpass', 1000, .707, 0, 3000);
  expect(lift('stage1')).toBeCloseTo(one, 1);
  expect(lift('stage2')).toBeCloseTo(one, 1);
  expect(lift('both')).toBeCloseTo(2 * one, 1);
  // A 1st-order stage keeps its fixed coefficients.
  expect(r.firstOrder.rms).toBeCloseTo(r.firstOrderStill.rms, 6);
});

test('1st-order cutoff and Shelf gain edits rebuild the IIR with a crossfade, coalesce rapid edits and release retired stages', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { FilterChain } = await import('/src/audio/dsp/FilterChain.ts');
    const { firstOrderCoefficients, firstOrderResponse } = await import('/src/audio/dsp/firstOrderFilter.ts');
    const rate = 48000, switchAt = .25;
    const context = new OfflineAudioContext(1, rate * .5, rate);
    const osc = context.createOscillator(); osc.frequency.value = 1500; osc.start();
    const chain = new FilterChain(context, { type: 'highpass', order: 1, frequencyHz: 6000, q: .707, gainDb: 0 });
    osc.connect(chain.input); chain.output.connect(context.destination);
    let built = 0;
    const create = context.createIIRFilter.bind(context);
    context.createIIRFilter = (...args) => { built += 1; return create(...args); };
    const edited = context.suspend(switchAt).then(async () => {
      for (const hz of [5000, 4000, 3000, 2000, 1500]) chain.setFrequency(hz);
      chain.setFrequency(1500);
      await new Promise(resolve => setTimeout(resolve, 80));
      await context.resume();
    });
    const rendering = context.startRendering();
    await edited;
    const out = (await rendering).getChannelData(0);
    const peak = (from, to) => { let m = 0; for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) m = Math.max(m, Math.abs(out[i])); return m; };
    await new Promise(resolve => setTimeout(resolve, 120));
    const retiring = chain.retiring.size;
    const rebuilds = built;
    // A Shelf gain edit rebuilds as well; an unchanged gain does not.
    const shelf = new FilterChain(context, { type: 'lowshelf', order: 1, frequencyHz: 1000, q: .707, gainDb: 0 });
    const afterShelf = built;
    shelf.setGain(0); await new Promise(resolve => setTimeout(resolve, 60));
    const unchanged = built - afterShelf;
    shelf.setGain(-6); shelf.setGain(-12); await new Promise(resolve => setTimeout(resolve, 60));
    const changed = built - afterShelf - unchanged;
    chain.dispose(); shelf.dispose();
    // Expected levels are the digital (prewarped bilinear) responses at 1500 Hz.
    const gain = fc => Math.hypot(...firstOrderResponse(firstOrderCoefficients('highpass', fc, rate), 1500, rate));
    return { before: peak(.1, .24), after: peak(.35, .49), expectBefore: gain(6000), expectAfter: gain(1500), rebuilds,
      retiring, unchanged, changed, finite: out.every(Number.isFinite) };
  });
  expect(result.finite).toBe(true);
  expect(result.before).toBeCloseTo(result.expectBefore, 2);
  expect(result.after).toBeCloseTo(result.expectAfter, 2);
  expect(result.expectAfter).toBeCloseTo(Math.SQRT1_2, 3);
  // Five rapid edits within one rebuild window build one new stage; the retired one is disconnected.
  expect(result.rebuilds).toBe(1);
  expect(result.retiring).toBe(0);
  expect(result.unchanged).toBe(0);
  expect(result.changed).toBe(1);
});

test('FILTER2 card shows both stages and the FEnv Target; Type, Order, Q and Gain follow the stage rules', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#filter2-route')).toBeEnabled();
  await openTimbreEditors(page, ['filter2']);
  const card = page.locator('.editor-card.active');
  await expect(card.locator('[data-filter2-stage]')).toHaveCount(2);
  const choices = id => page.locator(id).locator('xpath=..').locator('[role="radio"]');
  const choice = (id, text) => choices(id).filter({ hasText: new RegExp(`^${text}$`) });
  await expect(choices('#filter2-type')).toHaveText(['LPF', 'BPF', 'HPF', 'LShelf', 'HShelf', 'Peak']);
  await expect(choices('#filter2s2-type')).toHaveText(['Off', 'LPF', 'BPF', 'HPF', 'LShelf', 'HShelf', 'Peak']);
  await expect(choices('#filter2-fenv-target')).toHaveText(['Stage1', 'Stage2', 'Both']);
  // Every choice stays visible inside the card (the seven Stage2 types may wrap).
  const cardBox = await card.boundingBox();
  for (const button of await choices('#filter2s2-type').all()) {
    const box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + .5);
  }
  // Stage2 Off disables its Order, Freq, Q and Gain.
  await expect(page.locator('#filter2s2-type')).toHaveValue('off');
  await expect(choice('#filter2s2-order', '2nd')).toBeDisabled();
  await expect(page.locator('#filter2s2-frequency')).toBeDisabled();
  await choice('#filter2s2-type', 'LShelf').click();
  await expect(page.locator('#filter2s2-frequency')).toBeEnabled();
  await expect(page.locator('#filter2s2-q')).toBeDisabled();
  await expect(page.locator('#filter2s2-gain')).toBeEnabled();
  await expect(page.locator('#filter2s2-gain-coarse')).toBeEnabled();
  await expect(choice('#filter2s2-order', '1st')).toBeEnabled();
  // Stage1: 1st disables BPF/Peak and Q; Peak disables 1st and enables Q and Gain.
  await choice('#filter2-type', 'HPF').click();
  await expect(page.locator('#filter2-gain')).toBeDisabled();
  await choice('#filter2-order', '1st').click();
  await expect(choice('#filter2-type', 'BPF')).toBeDisabled();
  await expect(choice('#filter2-type', 'Peak')).toBeDisabled();
  await expect(page.locator('#filter2-q')).toBeDisabled();
  await choice('#filter2-order', '2nd').click();
  await choice('#filter2-type', 'Peak').click();
  await expect(choice('#filter2-order', '1st')).toBeDisabled();
  await expect(page.locator('#filter2-q')).toBeEnabled();
  await expect(page.locator('#filter2-gain')).toBeEnabled();
  await choice('#filter2-fenv-target', 'Both').click();
  await expect(page.locator('#filter2-fenv-target')).toHaveValue('both');
  // LPF/HPF show the resonance peak of their linear Q next to Q; BPF/Peak (a width) show nothing.
  const peak = page.locator('[data-numeric-control="filter2-q"] .filter-q-peak');
  await expect(peak).toBeHidden();
  await choice('#filter2-type', 'LPF').click();
  await page.locator('#filter2-q').fill('1.94'); await page.locator('#filter2-q').dispatchEvent('change');
  await expect(peak).toHaveText('peak +6.1 dB');
  await choice('#filter2-order', '4th').click();
  await expect(peak).toHaveText('peak +12.1 dB');
  await page.locator('#filter2-q').fill('0.707'); await page.locator('#filter2-q').dispatchEvent('change');
  await expect(peak).toHaveText('no peak');
});

test('Linear Q: 0.707 is Butterworth (−3 dB at cutoff) and 0.5 critically damped (−6 dB); timbre-v20 dB values load with the same sound', async ({ page }) => {
  await page.goto('/');
  const lp = (q, order = 2) => `s.osc2.baseFrequencyHz = 2000; s.filter2 = { type: 'lowpass', order: ${order}, frequencyHz: 2000, q: ${q}, gainDb: 0 };`;
  const hp = q => `s.osc2.baseFrequencyHz = 4000; s.filter2 = { type: 'highpass', order: 2, frequencyHz: 4000, q: ${q}, gainDb: 0 };
    s.filter2Stage2 = { type: 'lowpass', order: 4, frequencyHz: 9000, q: ${q}, gainDb: 0 };`;
  const r = await renderCases(page, {
    dry: 's.osc2.baseFrequencyHz = 2000; s.blocksEnabled.filter2 = false;',
    butterworth: lp(Math.SQRT1_2), critical: lp(.5), q4: lp(4), q4Fourth: lp(4, 4),
    linear: hp(1.94)
  });
  const db = name => 20 * Math.log10(r[name].rms / r.dry.rms);
  expect(db('butterworth')).toBeCloseTo(-3.01, 1);
  expect(db('critical')).toBeCloseTo(-6.02, 1);
  expect(db('q4')).toBeCloseTo(20 * Math.log10(4), 1);
  expect(db('q4Fourth')).toBeCloseTo(40 * Math.log10(4), 1);
  // The same timbre saved by the previous Lab held 20·log10(1.94) dB in each LPF/HPF Q.
  const old = await renderCases(page, { linear: hp(20 * Math.log10(1.94)) }, true);
  expect(old.linear.rms).toBeCloseTo(r.linear.rms, 6);
});
