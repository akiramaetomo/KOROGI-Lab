import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Offline renders of one Timbre; `edit` mutates the settings and `play` schedules the Gate. */
async function renderCases(page, cases) {
  return page.evaluate(async cases => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const rate = 48000, out = {};
    for (const [name, spec] of Object.entries(cases)) {
      const context = new OfflineAudioContext(1, Math.round(rate * spec.seconds), rate);
      const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      engine.setMasterGainDb(0);
      const timbre = defaultTimbre(), s = timbre.settings;
      s.osc1.sourceType = 'sine'; s.osc1.baseFrequencyHz = 440;
      s.osc2.sourceType = 'sine'; s.osc2.baseFrequencyHz = 220;
      s.ampEnvelope = { ...s.ampEnvelope, attackSec: 0, decaySec: 0, sustain: 1, releaseSec: .002, attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' };
      s.ampEnvelope2 = { ...s.ampEnvelope };
      new Function('s', spec.edit)(s);
      engine.replaceChannel('1', timbre);
      engine.gateOn('1', 0);
      if (spec.offAt !== undefined) engine.gateOff('1', spec.offAt);
      const samples = (await context.startRendering()).getChannelData(0);
      const rms = (from, to) => {
        const a = Math.round(from * rate), b = Math.round(to * rate);
        let sum = 0; for (let i = a; i < b; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / (b - a));
      };
      out[name] = { finite: samples.every(Number.isFinite), windows: spec.windows.map(([from, to]) => rms(from, to)) };
      engine.dispose();
    }
    return out;
  }, cases);
}

test('Default and control routes keep OSC2 silent; Balance edges isolate each path', async ({ page }) => {
  await page.goto('/');
  const w = [[.05, .15]];
  const r = await renderCases(page, {
    modRoute: { seconds: .2, windows: w, edit: "s.filter2Route = 'mod';" },
    cutoffRoute: { seconds: .2, windows: w, edit: "s.filter2Route = 'filter1-cutoff';" },
    osc1Only: { seconds: .2, windows: w, edit: "s.blocksEnabled.osc2 = false;" },
    osc2Only: { seconds: .2, windows: w, edit: "s.filter2Route = 'aenv-out'; s.blocksEnabled.osc1 = false;" },
    outBoth: { seconds: .2, windows: w, edit: "s.filter2Route = 'aenv-out';" },
    outLeft: { seconds: .2, windows: w, edit: "s.filter2Route = 'aenv-out'; s.oscBalance = -1;" },
    outRight: { seconds: .2, windows: w, edit: "s.filter2Route = 'aenv-out'; s.oscBalance = 1;" },
    inLeft: { seconds: .2, windows: w, edit: "s.filter2Route = 'aenv-in'; s.oscBalance = -1;" },
    inRight: { seconds: .2, windows: w, edit: "s.filter2Route = 'aenv-in'; s.oscBalance = 1;" },
    inHalf: { seconds: .2, windows: w, edit: "s.filter2Route = 'aenv-in'; s.oscBalance = .5; s.blocksEnabled.osc2 = false;" }
  });
  for (const item of Object.values(r)) expect(item.finite).toBe(true);
  const v = name => r[name].windows[0];
  expect(v('osc1Only')).toBeGreaterThan(.001);
  expect(v('modRoute')).toBeCloseTo(v('osc1Only'), 6);
  expect(v('cutoffRoute')).toBeGreaterThan(.001);
  // Two unrelated sines add in power at unity Balance.
  expect(v('outBoth')).toBeCloseTo(Math.hypot(v('osc1Only'), v('osc2Only')), 3);
  expect(v('outLeft')).toBeCloseTo(v('osc1Only'), 6);
  expect(v('outRight')).toBeCloseTo(v('osc2Only'), 6);
  expect(v('inLeft')).toBeCloseTo(v('osc1Only'), 6);
  expect(v('inRight')).toBeCloseTo(v('osc2Only'), 6);
  // +0.5 halves the OSC1 path linearly.
  expect(v('inHalf')).toBeCloseTo(v('osc1Only') / 2, 6);
});

test('AEnv IN follows AEnv1 only; AEnv OUT follows AEnv2 independently of AEnv1', async ({ page }) => {
  await page.goto('/');
  const shortShot = "s.ampEnvelope2 = { ...s.ampEnvelope2, mode: 'one-shot', decaySec: .01, sustain: 0, releaseSec: .002 };";
  const longShot = "s.ampEnvelope2 = { ...s.ampEnvelope2, mode: 'one-shot', decaySec: .4, sustain: 0, releaseSec: .002, decayCurve: 'linear' };";
  // Windows: while AEnv1 is held, after AEnv1 has released.
  const windows = [[.05, .1], [.15, .2]];
  const r = await renderCases(page, {
    inShort: { seconds: .25, offAt: .12, windows, edit: `s.filter2Route = 'aenv-in'; s.blocksEnabled.osc1 = false; ${shortShot}` },
    outShort: { seconds: .25, offAt: .12, windows, edit: `s.filter2Route = 'aenv-out'; s.blocksEnabled.osc1 = false; ${shortShot}` },
    outLong: { seconds: .25, offAt: .12, windows, edit: `s.filter2Route = 'aenv-out'; s.blocksEnabled.osc1 = false; ${longShot}` },
    outBypass: { seconds: .25, offAt: .12, windows, edit: `s.filter2Route = 'aenv-out'; s.blocksEnabled.osc1 = false; s.blocksEnabled.aenv2 = false; ${shortShot}` }
  });
  for (const item of Object.values(r)) expect(item.finite).toBe(true);
  // AEnv IN ignores AEnv2 and stops with AEnv1.
  expect(r.inShort.windows[0]).toBeGreaterThan(.01);
  expect(r.inShort.windows[1]).toBeLessThan(1e-4);
  // AEnv OUT: a short AEnv2 One-shot silences OSC2 while AEnv1 is still held ...
  expect(r.outShort.windows[0]).toBeLessThan(1e-4);
  // ... and a long one keeps sounding after AEnv1 has released.
  expect(r.outLong.windows[1]).toBeGreaterThan(.005);
  // AEnv2 OFF is a unity bypass.
  expect(r.outBypass.windows[1]).toBeGreaterThan(.01);
});

test('FEnv Depth moves Filter2 by a signed share of the FEnv Amount; 0 keeps the previous sound', async ({ page }) => {
  await page.goto('/');
  // A 2 kHz sine well above the 400 Hz cutoff: +3600 cent opens Filter2 to 3.2 kHz, -3600 cent closes it to 50 Hz.
  const base = "s.filter2Route = 'aenv-in'; s.blocksEnabled.osc1 = false; s.osc2.baseFrequencyHz = 2000;"
    + " s.filter2.type = 'lowpass'; s.filter2.frequencyHz = 400; s.blocksEnabled.filter2 = true;"
    + " s.filterEnvelope = { ...s.filterEnvelope, attackSec: 0, decaySec: 0, sustain: 1, amountCent: 3600 };";
  const windows = [[.05, .15]];
  const r = await renderCases(page, {
    fenvOff: { seconds: .2, windows, edit: `${base} s.blocksEnabled.fenv = false; s.filter2FenvDepth = 1;` },
    zero: { seconds: .2, windows, edit: `${base} s.blocksEnabled.fenv = true; s.filter2FenvDepth = 0;` },
    up: { seconds: .2, windows, edit: `${base} s.blocksEnabled.fenv = true; s.filter2FenvDepth = 1;` },
    down: { seconds: .2, windows, edit: `${base} s.blocksEnabled.fenv = true; s.filter2FenvDepth = -1;` }
  });
  for (const item of Object.values(r)) expect(item.finite).toBe(true);
  const v = name => r[name].windows[0];
  expect(v('zero')).toBeCloseTo(v('fenvOff'), 6);
  expect(v('up')).toBeGreaterThan(v('zero') * 10);
  expect(v('down')).toBeLessThan(v('zero') / 10);
});

test('BURST pulses retrigger AEnv2 and release a Gate-mode AEnv2 at each pulse end', async ({ page }) => {
  await page.goto('/');
  const burst = "s.ampEnvelope = { ...s.ampEnvelope, mode: 'one-shot', decaySec: .005, sustain: 0, releaseSec: .001 };"
    + " s.burst = { ...s.burst, enabled: true, pulseCountMin: 3, pulseCountMax: 3, pulseIntervalSec: .03, pulseIntervalJitter: 0, groupPeriodSec: .2, groupPeriodJitter: 0 };"
    + " s.filter2Route = 'aenv-out'; s.blocksEnabled.osc1 = false;";
  // First pulse sounding, the gap before the second pulse, and the second pulse.
  const windows = [[0, .004], [.015, .028], [.03, .034]];
  const r = await renderCases(page, {
    gateMode: { seconds: .1, windows, edit: `${burst} s.ampEnvelope2 = { ...s.ampEnvelope2, mode: 'gate', sustain: 1, releaseSec: .001 };` }
  });
  expect(r.gateMode.finite).toBe(true);
  const [first, gap, second] = r.gateMode.windows;
  expect(first).toBeGreaterThan(.01);
  expect(gap).toBeLessThan(1e-3);
  expect(second).toBeGreaterThan(.01);
});

test('Destination UI exposes four routes, Balance, FEnv Depth, AEnv2 and matching wires', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
  await expect(page.locator('#filter2-route')).toBeEnabled();
  await page.locator('#flow-filter2').click();
  const radios = page.locator('.filter-route-field [role="radio"]');
  await expect(radios).toHaveText(['MOD', 'F1 CUTOFF', 'AEnv IN', 'AEnv OUT']);
  const balance = page.locator('.osc-balance-control');
  const aenv2Toggle = page.locator('.source-group [data-block-toggle="aenv2"]');
  await expect(balance).toBeHidden();
  await expect(page.locator('.fenv-filter2-depth-control')).toBeVisible();
  await expect(aenv2Toggle).toHaveText('N/A');
  await expect(page.locator('path[data-from="filter2"][data-to="mod"]')).toHaveCount(1);

  await radios.nth(2).click();
  await expect(page.locator('#filter2-route')).toHaveValue('aenv-in');
  await expect(balance).toBeVisible();
  await expect(page.locator('.source-group [data-block-toggle="mod"]')).toHaveText('N/A');
  await expect(aenv2Toggle).toHaveText('N/A');
  await expect(page.locator('path[data-from="filter2"][data-to="aenv"]')).toHaveCount(1);
  await expect(page.locator('path[data-from="burst"][data-to="aenv2"]')).toHaveCount(0);
  await expect(page.locator('path[data-from="filter2"][data-to="mod"]')).toHaveCount(0);
  await expect(page.locator('#mod-readout')).toContainText('FILTER2 → AEnv IN');

  await radios.nth(3).click();
  await expect(aenv2Toggle).toHaveText('ON');
  await expect(page.locator('path[data-from="filter2"][data-to="aenv2"]')).toHaveCount(1);
  await expect(page.locator('path[data-from="aenv2"][data-to="fx1"]')).toHaveCount(1);
  const burstWire = page.locator('path[data-from="burst"][data-to="aenv2"]');
  await expect(burstWire).toHaveCount(1);
  await expect(burstWire).toHaveClass(/control-wire/);

  await page.locator('#osc-balance').fill('40'); await page.locator('#osc-balance').dispatchEvent('change');
  await page.locator('#fenv-filter2-depth').fill('-60'); await page.locator('#fenv-filter2-depth').dispatchEvent('change');
  await page.locator('#flow-aenv2').click();
  await expect(page.getByRole('group', { name: 'AEnv2 / ADSR' })).toBeVisible();
  await page.locator('#aenv2-attack').fill('120'); await page.locator('#aenv2-attack').dispatchEvent('change');
  await page.locator('#aenv2-mode + .segmented-choice [role="radio"]').last().click();
  const download = page.waitForEvent('download'); await page.locator('#save-1').click();
  const saved = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(saved.formatVersion).toBe('KOROGI-Lab/timbre-v20');
  expect(saved.settings).toMatchObject({ filter2Route: 'aenv-out', oscBalance: .4, filter2FenvDepth: -.6 });
  expect(saved.settings.ampEnvelope2).toMatchObject({ attackSec: .12, mode: 'one-shot' });
  const fenvWire = page.locator('path[data-from="fenv"][data-to="filter2"]');
  await expect(fenvWire).toHaveCount(1);
  expect(Number(await fenvWire.evaluate(path => path.style.opacity))).toBeGreaterThan(.5);
});
