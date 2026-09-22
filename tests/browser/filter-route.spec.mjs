import { test, expect } from '@playwright/test';

test('FILTER2 destination, depth, segmented choices, and v4 save stay synchronized', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#filter2-route')).toBeEnabled();
  await page.locator('#flow-filter2').click();
  const route = page.locator('#filter2-route');
  await expect(page.locator('.filter-route-field [role="radio"]')).toHaveCount(2);
  await page.locator('.filter-route-field [role="radio"]').last().click();
  await expect(route).toHaveValue('filter1-cutoff');
  await expect(page.locator('.source-group [data-block-toggle="mod"]')).toBeDisabled();
  await expect(page.locator('.source-group [data-block-toggle="mod"]')).toHaveText('N/A');
  await page.locator('#flow-mod').click();
  await expect(page.locator('#mod-mode + .segmented-choice [role="radio"]').first()).toBeDisabled();
  await expect(page.locator('#mod-readout')).toContainText('MOD mode and depth retained');
  await page.locator('#flow-filter2').click();
  await expect(page.locator('#filter1-cutoff-depth-coarse')).toBeVisible();
  await page.locator('#filter1-cutoff-depth').fill('4800');
  await page.locator('#filter1-cutoff-depth').dispatchEvent('change');
  const filterChoices = page.locator('#filter2-type').locator('xpath=..').locator('[role="radio"]');
  await expect(filterChoices).toHaveCount(3);
  await filterChoices.last().click();
  await expect(page.locator('#filter2-type')).toHaveValue('highpass');
  await filterChoices.last().press('Home');
  await expect(page.locator('#filter2-type')).toHaveValue('lowpass');
  await page.locator('.filter-route-field [role="radio"]').first().click();
  await expect(page.locator('.source-group [data-block-toggle="mod"]')).toBeEnabled();
  await expect(page.locator('.source-group [data-block-toggle="mod"]')).toHaveText('OFF');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const engine = new AudioEngine();
    const timbre = engine.createTimbre('1');
    timbre.settings.filter2Route = 'filter1-cutoff'; timbre.settings.filter1CutoffDepthCent = 4800;
    engine.replaceChannel('1', timbre);
    const saved = engine.createSession('v3');
    const old = structuredClone(saved);
    old.formatVersion = 'KOROGI-Lab/session-v2';
    for (const ch of old.channels) if (ch.timbre) {
      ch.timbre.formatVersion = 'KOROGI-Lab/timbre-v2';
      delete ch.timbre.settings.filter2Route;
      delete ch.timbre.settings.filter1CutoffDepthCent;
    }
    await engine.applySession(old);
    const migrated = engine.createSession('migrated');
    const live = engine.getChannel('1');
    const invalid = structuredClone(saved);
    invalid.channels[0].timbre.settings.filter2Route = 'broken';
    let rejected = false;
    try { await engine.applySession(invalid); } catch { rejected = true; }
    const retained = engine.getChannel('1') === live;
    await engine.close();
    return { saved: saved.channels[0].timbre, migrated: migrated.channels[0].timbre, migratedVersion: migrated.formatVersion, rejected, retained };
  });
  expect(result.saved.formatVersion).toBe('KOROGI-Lab/timbre-v7');
  expect(result.saved.settings.filter1CutoffDepthCent).toBe(4800);
  expect(result.migratedVersion).toBe('KOROGI-Lab/session-v8');
  expect(result.migrated.settings.filter2Route).toBe('mod');
  expect(result.migrated.settings.filter1CutoffDepthCent).toBe(1200);
  expect(result.rejected && result.retained).toBe(true);
});

test('Repeated touch double taps reset the same slider; drag does not reset; text stays unselected', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('#osc1-frequency');
  const slider = page.locator('#osc1-frequency-coarse');
  const tap = async (x, y, dx = 0, target = slider) => target.evaluate((el, { x, y, dx }) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 7, bubbles: true, clientX: x, clientY: y }));
    if (dx) el.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, bubbles: true, clientX: x + dx, clientY: y }));
    el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, bubbles: true, clientX: x + dx, clientY: y }));
  }, { x, y, dx });
  for (let repeat = 0; repeat < 3; repeat++) {
    await input.fill('1500'); await input.dispatchEvent('change');
    await tap(100, 100); await tap(100, 100);
    await expect(input).toHaveValue('4000');
  }
  await input.fill('1500'); await input.dispatchEvent('change');
  await tap(100, 100, 30); await tap(100, 100);
  await expect(input).toHaveValue('1500');
  const fine = page.locator('#osc1-frequency-fine');
  await fine.evaluate(el => { el.value = '7500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(input).toHaveValue('1875');
  await tap(100, 100, 0, fine); await tap(100, 100, 0, fine);
  await expect(input).toHaveValue('1500');
  await expect(fine).toHaveValue('5000');
  const selection = await page.locator('#flow-filter1').evaluate(el => {
    const event = new Event('selectstart', { bubbles: true, cancelable: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(selection).toBe(true);
  const editable = await input.evaluate(el => {
    const event = new Event('selectstart', { bubbles: true, cancelable: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(editable).toBe(false);
});

test('Duty edges, Drive 48 dB, and cutoff route render bounded samples at both sample rates', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const cases = [];
    for (const rate of [44100, 48000]) for (const duty of [.005, .995]) for (const depth of [0, 4800]) {
      const context = new OfflineAudioContext(1, Math.round(rate * .25), rate);
      const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      engine.setMasterGainDb(0);
      const timbre = defaultTimbre();
      timbre.settings.osc1.sourceType = 'square'; timbre.settings.osc1.dutyRatio = duty;
      timbre.settings.osc1.baseFrequencyHz = 440;
      timbre.settings.filter1.type = 'lowpass'; timbre.settings.filter1.frequencyHz = 1000;
      timbre.settings.blocksEnabled.filter1 = true;
      timbre.settings.filter2Route = 'filter1-cutoff'; timbre.settings.filter1CutoffDepthCent = depth;
      timbre.settings.blocksEnabled.aenv = false;
      timbre.settings.fx1.type = 'distortion'; timbre.settings.fx1.distortionDriveDb = 48;
      timbre.settings.fx1.distortionWet = 1;
      timbre.settings.fx1.enabled = true;
      engine.replaceChannel('1', timbre); engine.gateOn('1');
      const samples = (await context.startRendering()).getChannelData(0);
      let peak = 0, energy = 0, finite = true;
      for (const sample of samples) { finite &&= Number.isFinite(sample); peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
      cases.push({ rate, duty, depth, finite, peak, rms: Math.sqrt(energy / samples.length) });
      engine.dispose();
    }
    return cases;
  });
  expect(result).toHaveLength(8);
  for (const item of result) {
    expect(item.finite).toBe(true);
    // The distortion shaper is bounded to 1, while the resonant filter may overshoot.
    expect(item.peak).toBeLessThan(4);
    expect(item.rms).toBeGreaterThan(0);
  }
  for (const rate of [44100, 48000]) for (const duty of [.005, .995]) {
    const pair = result.filter(item => item.rate === rate && item.duty === duty);
    expect(Math.abs(pair[0].rms - pair[1].rms)).toBeGreaterThan(.00001);
  }
});

test('MOD and cutoff destinations are exclusive, and Filter1 OFF bypasses cutoff depth', async ({ page }) => {
  await page.goto('/');
  const metrics = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const render = async (route, depth, filterOn) => {
      const context = new OfflineAudioContext(1, 24000, 48000);
      const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      const timbre = defaultTimbre();
      timbre.settings.osc1.sourceType = 'sine'; timbre.settings.osc1.baseFrequencyHz = 440;
      timbre.settings.osc2.sourceType = 'sine'; timbre.settings.osc2.baseFrequencyHz = 30;
      timbre.settings.mod.mode = 'am'; timbre.settings.mod.amDepth = 1; timbre.settings.mod.amOffset = 1;
      timbre.settings.blocksEnabled.mod = true;
      timbre.settings.filter2Route = route; timbre.settings.filter1CutoffDepthCent = depth;
      timbre.settings.filter1.type = 'lowpass'; timbre.settings.filter1.frequencyHz = 400;
      timbre.settings.blocksEnabled.aenv = false; timbre.settings.blocksEnabled.filter1 = filterOn;
      engine.replaceChannel('1', timbre); engine.gateOn('1');
      const samples = (await context.startRendering()).getChannelData(0);
      const rms = Math.sqrt(samples.slice(4800).reduce((sum, x) => sum + x * x, 0) / (samples.length - 4800));
      engine.dispose(); return rms;
    };
    return { mod: await render('mod', 4800, false),
      cutoffOff0: await render('filter1-cutoff', 0, false), cutoffOffMax: await render('filter1-cutoff', 4800, false),
      cutoffOn0: await render('filter1-cutoff', 0, true), cutoffOnMax: await render('filter1-cutoff', 4800, true) };
  });
  expect(Math.abs(metrics.mod - metrics.cutoffOff0)).toBeGreaterThan(.001);
  expect(metrics.cutoffOffMax).toBeCloseTo(metrics.cutoffOff0, 4);
  expect(Math.abs(metrics.cutoffOnMax - metrics.cutoffOn0)).toBeGreaterThan(.0001);
});

test('Four voices repeatedly schedule 5 ms gates at 44.1 and 48 kHz without nonfinite audio', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { defaultTimbre } = await import('/src/model/documents.ts');
    const runs = [];
    for (const rate of [44100, 48000]) {
      const context = new OfflineAudioContext(1, Math.round(rate * .25), rate);
      const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination);
      const events = [];
      for (const id of ['1', '2', '3', '4']) {
        const timbre = defaultTimbre(); timbre.settings.osc1.baseFrequencyHz = 200 + Number(id) * 100;
        timbre.settings.ampEnvelope.attackSec = .001; timbre.settings.ampEnvelope.releaseSec = .001;
        engine.replaceChannel(id, timbre);
        engine.getChannel(id).addGateScheduleListener(event => events.push({ id, kind: event.kind, time: event.time }));
        for (let cycle = 0; cycle < 20; cycle++) {
          const on = .01 + cycle * .01;
          engine.gateOn(id, on); engine.gateOff(id, on + .005);
        }
      }
      const samples = (await context.startRendering()).getChannelData(0);
      let finite = true, peak = 0;
      for (const sample of samples) { finite &&= Number.isFinite(sample); peak = Math.max(peak, Math.abs(sample)); }
      runs.push({ rate, finite, peak, events, end: samples.at(-1) });
      engine.dispose();
    }
    return runs;
  });
  for (const run of results) {
    expect(run.finite).toBe(true);
    expect(run.peak).toBeGreaterThan(.001);
    const gateEvents = run.events.filter(event => event.kind === 'on' || event.kind === 'off');
    expect(gateEvents).toHaveLength(160);
    expect(run.events.filter(event => event.kind === 'cancel')).toHaveLength(4);
    for (const id of ['1', '2', '3', '4']) {
      const events = gateEvents.filter(event => event.id === id);
      for (let i = 0; i < events.length; i++) {
        expect(events[i].kind).toBe(i % 2 === 0 ? 'on' : 'off');
        if (i % 2) expect(events[i].time - events[i - 1].time).toBeCloseTo(.005, 9);
      }
    }
    expect(Math.abs(run.end)).toBeLessThan(.001);
  }
});

for (const width of [1024, 1366, 768]) test(`Eight send wires keep separate bends and labels remain readable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 768 });
  await page.goto('/');
  await expect(page.locator('path[data-from^="input-"]')).toHaveCount(8);
  const layout = await page.locator('.signal-canvas').evaluate(root => {
    const wires = [...root.querySelectorAll('path[data-from^="input-"]')];
    const byBus = bus => wires.filter(path => path.dataset.to === `${bus}-input`).map(path => {
      const coordinates = path.getAttribute('d').match(/^M [\d.]+ [\d.]+ H ([\d.]+) V/);
      return coordinates ? Number(coordinates[1]) : null;
    });
    return {
      near: byBus('near'), far: byBus('far'),
      active: wires.filter(path => path.classList.contains('send-active')).length,
      colors: wires.map(path => getComputedStyle(path).stroke),
      widths: wires.map(path => parseFloat(getComputedStyle(path).strokeWidth)),
      smallText: [...document.querySelectorAll('.slider-scale span, .segmented-choice button, .channel-inputs small')]
        .filter(node => node.getClientRects().length).map(node => parseFloat(getComputedStyle(node).fontSize))
    };
  });
  for (const xs of [layout.near, layout.far]) {
    expect(xs).toHaveLength(4);
    const bends = xs.filter(x => x !== null);
    expect(bends).toHaveLength(3);
    for (let i = 1; i < bends.length; i++) expect(Math.abs(bends[i] - bends[i - 1])).toBeCloseTo(8, 5);
  }
  expect(layout.active).toBeGreaterThan(0);
  expect(new Set(layout.colors).size).toBeGreaterThan(1);
  expect(new Set(layout.widths).size).toBeGreaterThan(1);
  expect(Math.min(...layout.smallText)).toBeGreaterThanOrEqual(10.39);
});
