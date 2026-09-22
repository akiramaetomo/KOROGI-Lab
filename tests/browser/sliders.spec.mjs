import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function panel(page, name) {
  if (name === 'space-effects') {
    const bus = await page.locator('.bus-segment [aria-pressed="true"]').getAttribute('data-bus-choice');
    await page.locator(`#flow-${bus}-fx2`).click();
  } else {
    const target = page.locator(`[data-panel-target="${name}"]`).first();
    await target.click(name === 'voice-effects' ? { position: { x: 8, y: 15 } } : undefined);
  }
}

async function edit(page, id, value) {
  await page.locator(`#${id}`).fill(String(value));
  await page.locator(`#${id}`).dispatchEvent('change');
}

async function slide(page, id, value) {
  await page.locator(`#${id}`).evaluate((range, value) => {
    range.value = String(value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function value(page, id) {
  return Number(await page.locator(`#${id}`).inputValue());
}

async function coarseFrequency(page, id) {
  return page.locator(`#${id}-coarse`).evaluate(range => {
    const number = document.querySelector(`#${range.id.replace(/-coarse$/, '')}`);
    return Number(number.min) + (Number(number.max) - Number(number.min)) * Number(range.value) / 10000;
  });
}

async function exportPatch(page) {
  await panel(page, 'patch');
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-patch').click();
  const file = await downloaded;
  return JSON.parse(await readFile(await file.path(), 'utf8'));
}

async function start(page) {
  await page.goto('/');
  await page.locator('.signal-map [data-block-toggle="osc1"]').click();
}

test('Every numeric input retains its field and an immediately available slider', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency-coarse')).toBeEnabled();
  const coverage = await page.locator('input[data-numeric-min]').evaluateAll((inputs) => inputs.map((input) => ({
    id: input.id, text: input.type === 'text', value: input.value,
    slider: document.getElementById(`${input.id}-coarse`)?.type === 'range',
    disabled: document.getElementById(`${input.id}-coarse`)?.disabled
  })));
  expect(coverage.length).toBeGreaterThan(40);
  expect(coverage.every((input) => input.text && input.slider)).toBe(true);
  await expect(page.locator('#osc1-frequency-coarse')).toBeEnabled();
  await expect(page.locator('#osc1-frequency-fine')).toBeEnabled();
  await expect(page.locator('#fx1-delay-time-coarse')).toBeDisabled();
  const patch = await exportPatch(page);
  expect(patch.channels[0].timbre.settings.osc1.baseFrequencyHz).toBe(4000);
  expect(patch.channels[0].timbre.settings.filter1.q).toBe(.707);
});

test('Log coarse uses geometric interpolation; local fine stays put and numerical edits recenter it', async ({ page }) => {
  await start(page); await panel(page, 'filters');
  await slide(page, 'filter1-frequency-coarse', 5000);
  const min = Number(await page.locator('#filter1-frequency').getAttribute('min'));
  const max = Number(await page.locator('#filter1-frequency').getAttribute('max'));
  expect(await value(page, 'filter1-frequency')).toBeCloseTo(Math.sqrt(min * max), 1);
  await edit(page, 'filter1-frequency', 4400);
  await expect(page.locator('#filter1-frequency-fine')).toHaveValue('5000');
  await slide(page, 'filter1-frequency-fine', 7500);
  const expected = 4400 * 2 ** (50 / 1200);
  expect(await value(page, 'filter1-frequency')).toBeCloseTo(expected, 3);
  await page.locator('#filter1-frequency-fine').dispatchEvent('pointerup');
  await page.locator('#filter1-frequency-fine').dispatchEvent('change');
  await expect(page.locator('#filter1-frequency-fine')).toHaveValue('7500');
  await expect(page.locator('#filter1-frequency-fine')).toHaveAttribute('title', /around 4\.4 kHz/);
  const patch = await exportPatch(page);
  expect(patch.channels[0].timbre.settings.filter1.frequencyHz).toBeCloseTo(expected, 3);
  await panel(page, 'filters');
  await edit(page, 'filter1-frequency', 1000);
  await expect(page.locator('#filter1-frequency-fine')).toHaveValue('5000');
  await slide(page, 'filter1-frequency-fine', 7500);
  expect(await value(page, 'filter1-frequency')).toBeCloseTo(1000 * 2 ** (50 / 1200), 3);
});

test('Horizontal frequency drag increases rightward; fine release does not reset the thumb', async ({ page }) => {
  await start(page);
  const coarse = page.locator('#osc1-frequency-coarse');
  const rect = await coarse.boundingBox();
  await page.mouse.click(rect.x + rect.width * .2, rect.y + rect.height / 2);
  const lower = await value(page, 'osc1-frequency');
  await page.mouse.click(rect.x + rect.width * .8, rect.y + rect.height / 2);
  expect(await value(page, 'osc1-frequency')).toBeGreaterThan(lower);
  await edit(page, 'osc1-frequency', 4400);
  const fine = page.locator('#osc1-frequency-fine');
  const fineRect = await fine.boundingBox();
  await page.mouse.move(fineRect.x + fineRect.width / 2, fineRect.y + fineRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(fineRect.x + fineRect.width * .75, fineRect.y + fineRect.height / 2, { steps: 5 });
  const during = await fine.inputValue();
  await page.mouse.up();
  expect(Number(during)).toBeGreaterThan(5000);
  expect(await fine.inputValue()).toBe(during);
  expect(await value(page, 'osc1-frequency')).toBeGreaterThan(4400);
});

test('OSC Fine defaults to 50%, supports 10/30/50% file settings, and resets only its own offset', async ({ page }) => {
  for (const [percent, expected1, expected2] of [[10, 1100, 110], [30, 1300, 130], [50, 1500, 150]]) {
    const pattern = '**/src/config/parameterRanges.ts*';
    const handler = async route => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: `${body}\nPARAMETER_RANGES["osc1-frequency"].fine = "ratio-${percent}-percent"; PARAMETER_RANGES["osc2-frequency"].fine = "ratio-${percent}-percent";` });
    };
    await page.route(pattern, handler);
    await page.goto('/');
    await edit(page, 'osc1-frequency', 1000);
    await edit(page, 'osc2-frequency', 100);
    await slide(page, 'osc1-frequency-fine', 10000);
    await slide(page, 'osc2-frequency-fine', 10000);
    expect(await value(page, 'osc1-frequency')).toBe(expected1);
    expect(await value(page, 'osc2-frequency')).toBe(expected2);
    const saved = await exportPatch(page);
    expect(saved.channels[0].timbre.settings.osc1.baseFrequencyHz).toBe(expected1);
    expect(saved.channels[0].timbre.settings.osc2.baseFrequencyHz).toBe(expected2);
    await page.unroute(pattern, handler);
  }
  await page.goto('/');
  await edit(page, 'osc1-frequency', 4400);
  await slide(page, 'osc1-frequency-fine', 7500);
  await expect(page.locator('#osc1-frequency')).toHaveValue('5500');
  await page.locator('#osc1-frequency-fine').dblclick();
  await expect(page.locator('#osc1-frequency')).toHaveValue('4400');
  await expect(page.locator('#osc1-frequency-fine')).toHaveValue('5000');
  expect(await coarseFrequency(page, 'osc1-frequency')).toBeCloseTo(4400, -1);
});

test('Keyboard adjustment works at the minimum and fine windows obey both frequency limits', async ({ page }) => {
  await start(page);
  await edit(page, 'osc1-frequency', 100);
  await page.locator('#osc1-frequency-coarse').press('ArrowUp');
  expect(await value(page, 'osc1-frequency')).toBeGreaterThan(100);
  await edit(page, 'osc1-frequency', 100);
  await page.locator('#osc1-frequency-fine').press('ArrowUp');
  expect(await value(page, 'osc1-frequency')).toBeGreaterThan(100);
  await edit(page, 'osc1-frequency', 100);
  await page.locator('#osc1-frequency-fine').press('End');
  expect(await value(page, 'osc1-frequency')).toBeGreaterThan(100);
  await page.locator('#osc1-frequency-fine').press('Home');
  expect(await value(page, 'osc1-frequency')).toBeGreaterThanOrEqual(20);
  await edit(page, 'osc1-frequency', 20000);
  await page.locator('#osc1-frequency-fine').press('End');
  expect(await value(page, 'osc1-frequency')).toBeLessThanOrEqual(20000);
  await page.locator('#osc1-frequency-fine').press('Home');
  expect(await value(page, 'osc1-frequency')).toBeLessThan(20000);
});

test('Linear zero, bipolar amount, dB and fine cent controls update the canonical settings', async ({ page }) => {
  await start(page); await panel(page, 'modulation');
  await slide(page, 'penv-amount-coarse', 0);
  await page.locator('#mod-mode + .segmented-choice [data-value="am"]').click();
  await slide(page, 'am-depth-coarse', 5000);
  await page.locator('#mod-mode + .segmented-choice [data-value="fm"]').click();
  await edit(page, 'fm-depth', 100);
  await slide(page, 'fm-depth-fine', 7500);
  expect(await value(page, 'fm-depth')).toBeCloseTo(124, 2);
  await panel(page, 'output');
  await edit(page, 'detune-range', 0);
  await page.locator('#detune-range-fine').press('ArrowUp');
  expect(await value(page, 'detune-range')).toBeGreaterThan(0);
  await panel(page, 'voice-effects');
  await page.locator('#fx1-type').selectOption('distortion');
  await expect(page.locator('#fx1-dist-wet-coarse')).toBeEnabled();
  await slide(page, 'fx1-dist-wet-coarse', 0);
  await page.locator('#fx1-dist-wet-coarse').press('ArrowUp');
  expect(await value(page, 'fx1-dist-wet')).toBe(1);
  const patch = await exportPatch(page);
  expect(patch.channels[0].timbre.settings.pitchEnvelope.amount).toBe(-.1);
  expect(patch.channels[0].timbre.settings.mod.amDepth).toBe(1);
  expect(patch.channels[0].timbre.settings.mod.fmDepthCent).toBe(124);
  expect(patch.channels[0].timbre.settings).not.toHaveProperty('channelGainDb');
  expect(patch.channels[0].timbre.settings.fx1.distortionWet).toBe(.01);
  expect(patch.channels[0].timbre.detuneRangeCent).toBeGreaterThan(0);
});

test('FX slider visibility, bus selection and session import synchronize every relevant value', async ({ page }) => {
  await start(page); await panel(page, 'voice-effects');
  await page.locator('#fx1-type').selectOption('delay');
  await expect(page.locator('#fx1-delay-time-coarse')).toBeEnabled();
  await expect(page.locator('#fx1-dist-drive-coarse')).toBeDisabled();
  await edit(page, 'fx1-delay-time', 250);
  await slide(page, 'fx1-delay-time-coarse', 5000);
  expect(await value(page, 'fx1-delay-time')).toBeGreaterThan(1);
  await edit(page, 'fx1-delay-time', 275);
  await panel(page, 'space-effects');
  await page.locator('#fx2-type').selectOption('delay');
  await edit(page, 'fx2-delay-time', 400);
  await edit(page, 'fx2-delay-time', 440);
  await page.locator('#effects-far').click();
  await expect(page.locator('#fx1-delay-time')).toHaveValue('275');
  await expect(page.locator('#fx2-delay-time-coarse')).toBeDisabled();
  await page.locator('#fx2-type').selectOption('delay');
  await edit(page, 'fx2-delay-time', 800);
  await edit(page, 'fx2-delay-time', 880);
  await page.locator('#effects-near').click();
  await expect(page.locator('#fx2-delay-time')).toHaveValue('440');
  await expect(page.locator('#fx2-delay-time-coarse')).toBeEnabled();
  const saved = await exportPatch(page);
  await panel(page, 'sources'); await edit(page, 'osc1-frequency', 1234);
  await panel(page, 'patch');
  await page.locator('#patch-file').setInputFiles({ name: 'sliders.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  const restored = await exportPatch(page);
  delete saved.savedAt; delete restored.savedAt;
  expect(restored).toEqual(saved);
  await panel(page, 'sources');
  await expect(page.locator('#osc1-frequency')).toHaveValue('4000');
  await expect(page.locator('#osc1-frequency-fine')).toHaveValue('5000');
  expect(await coarseFrequency(page, 'osc1-frequency')).toBeCloseTo(4000, -1);
});

test('OSC1 accepts 20 kHz through numeric and coarse controls and retains it in a Session', async ({ page }) => {
  await start(page);
  await expect(page.locator('#osc1-frequency-coarse + .slider-scale span:last-child')).toHaveText('20 kHz');
  await edit(page, 'osc1-frequency', 20_000);
  await expect(page.locator('#osc1-frequency')).toHaveValue('20000');
  await edit(page, 'osc1-frequency', 20_001);
  await expect(page.locator('#osc1-frequency')).toHaveValue('20000');
  await edit(page, 'osc1-frequency', 4_000);
  await slide(page, 'osc1-frequency-coarse', 10_000);
  await expect(page.locator('#osc1-frequency')).toHaveValue('20000');
  const saved = await exportPatch(page);
  expect(saved.channels[0].timbre.settings.osc1.baseFrequencyHz).toBe(20_000);
  await panel(page, 'sources');
  await edit(page, 'osc1-frequency', 4_000);
  await page.locator('#patch-file').setInputFiles({ name: '20khz.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await panel(page, 'sources');
  await expect(page.locator('#osc1-frequency')).toHaveValue('20000');
});

test('Current OSC ranges, integer Hz, Duty, wheel and Shift-wheel survive multi-timbre save/load', async ({ page }) => {
  await start(page); await edit(page, 'osc1-frequency', 4000);
  await page.locator('#osc1-frequency-coarse').dispatchEvent('wheel', { deltaY: -100 });
  expect(await value(page, 'osc1-frequency')).toBe(4010);
  await page.locator('#osc1-frequency-coarse').dispatchEvent('wheel', { deltaX: -100, shiftKey: true });
  expect(await value(page, 'osc1-frequency')).toBe(4110);
  await edit(page, 'osc1-frequency', 1234.6); expect(await value(page, 'osc1-frequency')).toBe(1235);
  await page.locator('#osc1-frequency-fine').dispatchEvent('wheel', { deltaY: -100 });
  expect(await value(page, 'osc1-frequency')).toBe(1236);
  await expect(page.locator('#osc1-frequency-fine')).toHaveAttribute('title', /around 1\.24 kHz/);
  await page.locator('#osc1-frequency-fine').dispatchEvent('wheel', { deltaX: -100, shiftKey: true });
  expect(await value(page, 'osc1-frequency')).toBe(1246);
  await slide(page, 'osc2-frequency-coarse', 5000); expect(await value(page, 'osc2-frequency')).toBeCloseTo(Math.sqrt(1000), 1);
  await page.locator('#osc1-type').selectOption('square'); await edit(page, 'osc1-duty', 50);
  await page.locator('#osc1-duty-coarse').dispatchEvent('wheel', { deltaY: -100 }); expect(await value(page, 'osc1-duty')).toBe(50.5);
  await page.locator('#osc1-duty-coarse').dispatchEvent('wheel', { deltaX: -100, shiftKey: true }); expect(await value(page, 'osc1-duty')).toBe(55.5);
  await edit(page, 'osc2-duty', 25); await page.locator('#osc1-type').selectOption('triangle');
  await panel(page, 'modulation'); await page.locator('#mod-mode + .segmented-choice [data-value="am"]').click(); await edit(page, 'am-offset', 0);
  const saved = await exportPatch(page); const settings = saved.channels[0].timbre.settings;
  expect(settings.osc1.baseFrequencyHz).toBe(1246); expect(settings.osc1.dutyRatio).toBeCloseTo(.555, 6); expect(settings.osc2.dutyRatio).toBe(.25);
  expect(settings.mod.amOffset).toBe(0); expect(settings.blocksEnabled.mod).toBe(false);
  await page.locator('#patch-file').setInputFiles({ name: 'current.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await panel(page, 'sources'); await expect(page.locator('#osc1-duty')).toHaveValue('55.5'); await expect(page.locator('#osc2-duty')).toHaveValue('25');
  await panel(page, 'modulation'); await expect(page.locator('#am-offset')).toHaveValue('0');
});

for (const [width, height] of [[1440, 900], [1024, 900], [768, 900], [768, 768]]) {
  test(`All numeric panels fit and operate at ${width}x${height}`, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height }); await start(page);
    await panel(page, 'voice-effects');
    await page.locator('#fx1-type').selectOption('distortion');
    await panel(page, 'space-effects');
    await page.locator('#fx2-type').selectOption('delay');
    await page.locator('#fx3-type').selectOption('reverb');
    for (const name of ['sources', 'modulation', 'filters', 'amp', 'triggering', 'voice-effects', 'space-effects', 'space-output', 'output']) {
      await panel(page, name);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${width}x${height}.png`) });
      const outside = await page.locator('.function-panel.active input:not(:disabled), .function-panel.active select:not(:disabled), .function-panel.active button:not(:disabled)').evaluateAll((controls) => controls.filter((control) => {
        if (control.getClientRects().length === 0) return false;
        const rect = control.getBoundingClientRect();
        const fieldset = control.closest('fieldset')?.getBoundingClientRect();
        return rect.left < 0 || rect.right > window.innerWidth ||  rect.width < 1 || (fieldset && rect.bottom > fieldset.bottom);
      }).map((control) => {
        const rect = control.getBoundingClientRect();
        return { id: control.id || control.textContent, left: rect.left, right: rect.right, bottom: rect.bottom };
      }));
      expect(outside, name).toEqual([]);

      const directions = await page.locator('.function-panel.active .numeric-slider-axis input[type="range"]:not(:disabled)').evaluateAll((ranges) => ranges.every((range) => {
        if (range.getClientRects().length === 0) return true;
        const axis = range.closest('.numeric-slider-axis').dataset.axis;
        const rect = range.getBoundingClientRect();
        return axis === 'vertical' ? rect.height > rect.width : rect.width > rect.height;
      }));
      expect(directions, name).toBe(true);
    }
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
