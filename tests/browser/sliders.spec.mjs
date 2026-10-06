import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openTimbreEditors, openCommonEditors } from './editor-helpers.mjs';

async function panel(page, name) {
  const groups = { sources: ['osc1', 'osc2'], modulation: ['mod', 'penv'], filters: ['filter1', 'filter2'],
    amp: ['aenv'], triggering: ['sequence'], 'voice-effects': ['fx1'], output: ['detune'] };
  if (groups[name]) { await openTimbreEditors(page, groups[name]); return; }
  if (name === 'space-effects') {
    await openCommonEditors(page, ['near', 'near-gain']);
  } else if (name === 'space-output') {
    await openCommonEditors(page, ['balance', 'master']);
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
  return page.locator(`#${id}-coarse`).evaluate(async range => {
    const { parameterForInput } = await import('/src/config/parameterRanges.ts');
    const spec = parameterForInput(range.id.replace(/-coarse$/, ''));
    const position = Number(range.value) / 10000;
    return spec.scale === 'log' ? spec.min * (spec.max / spec.min) ** position
      : spec.min + (spec.max - spec.min) * position;
  });
}

async function osc1Range(page) {
  return page.evaluate(async () => (await import('/src/config/parameterRanges.ts')).PARAMETER_RANGES['osc1-frequency']);
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
  await expect(page.locator('#play-1')).toBeEnabled();
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
  expect(patch.channels[0].timbre.settings.osc1.baseFrequencyHz).toBe((await osc1Range(page)).defaultValue);
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
  await slide(page, 'penv-attack-level-coarse', 0);
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
  expect(patch.channels[0].timbre.settings.pitchEnvelope.attack).toBe(-1);
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
  await openCommonEditors(page, ['near', 'far']);
  await expect(page.locator('#fx1-delay-time')).toHaveValue('275');
  await expect(page.locator('#far-fx2-delay-time-coarse')).toBeDisabled();
  await page.locator('#far-fx2-type').selectOption('delay');
  await edit(page, 'far-fx2-delay-time', 800);
  await edit(page, 'far-fx2-delay-time', 880);
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
  const initial = (await osc1Range(page)).defaultValue;
  await expect(page.locator('#osc1-frequency')).toHaveValue(String(initial));
  await expect(page.locator('#osc1-frequency-fine')).toHaveValue('5000');
  expect(await coarseFrequency(page, 'osc1-frequency')).toBeCloseTo(initial, -1);
});

test('OSC1 accepts 20 kHz numerically while Coarse retains its own endpoint', async ({ page }) => {
  await start(page);
  const spec = await osc1Range(page);
  await edit(page, 'osc1-frequency', 20_000);
  await expect(page.locator('#osc1-frequency')).toHaveValue('20000');
  await edit(page, 'osc1-frequency', 20_001);
  await expect(page.locator('#osc1-frequency')).toHaveValue('20000');
  await edit(page, 'osc1-frequency', 4_000);
  await slide(page, 'osc1-frequency-coarse', 10_000);
  await expect(page.locator('#osc1-frequency')).toHaveValue(String(spec.max));
  await edit(page, 'osc1-frequency', 20_000);
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
  // Fixed linear fixture verifies the 10 Hz / Shift-100 Hz wheel contract.
  await page.route('**/src/config/parameterRanges.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nPARAMETER_RANGES["osc1-frequency"].scale = "linear";` });
  });
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

for (const scale of ['linear', 'log']) {
  test(`OSC Fine crosses both Coarse endpoints with ${scale} Coarse and survives reload`, async ({ page }) => {
    await page.route('**/src/config/parameterRanges.ts*', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\nObject.assign(PARAMETER_RANGES["osc1-frequency"], { min: 10, max: 10000, scale: "${scale}" });` });
    });
    await start(page);
    for (const [id, low, high] of [['osc1-frequency', 10, 10000], ['osc2-frequency', 1, 1000]]) {
      await slide(page, `${id}-coarse`, 0);
      expect(await value(page, id)).toBe(low);
      await expect(page.locator(`#${id}-fine + .slider-scale span`)).toHaveText(['-50%', '0%', '+50%']);
      await slide(page, `${id}-fine`, 0);
      expect(await value(page, id)).toBe(low / 2);
      await expect(page.locator(`#${id}-coarse`)).toHaveValue('0');
      await expect(page.locator(`#${id}-fine`)).toHaveValue('0');
      await page.locator(`#${id}-fine`).dblclick();
      expect(await value(page, id)).toBe(low);
      await slide(page, `${id}-coarse`, 10000);
      await slide(page, `${id}-fine`, 10000);
      expect(await value(page, id)).toBe(high * 1.5);
      await expect(page.locator(`#${id}-coarse`)).toHaveValue('10000');
    }
    const saved = await exportPatch(page);
    expect(saved.channels[0].timbre.settings.osc1.baseFrequencyHz).toBe(15000);
    expect(saved.channels[0].timbre.settings.osc2.baseFrequencyHz).toBe(1500);
    await panel(page, 'sources');
    await edit(page, 'osc1-frequency', 440);
    await edit(page, 'osc2-frequency', 30);
    await panel(page, 'patch');
    await page.locator('#patch-file').setInputFiles({ name: 'fine.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
    await expect(page.locator('#patch-status')).toContainText('Loaded:');
    await panel(page, 'sources');
    await expect(page.locator('#osc1-frequency')).toHaveValue('15000');
    await expect(page.locator('#osc2-frequency')).toHaveValue('1500');
    await expect(page.locator('#osc1-frequency-fine')).toHaveValue('5000');
    await expect(page.locator('#osc1-frequency-coarse')).toHaveValue('10000');
    await slide(page, 'osc1-frequency-fine', 10000);
    await expect(page.locator('#osc1-frequency')).toHaveValue('20000');
    await expect(page.locator('#osc1-frequency-fine + .slider-scale span:last-child')).toHaveText('+33.3%');
    await edit(page, 'osc1-frequency', 1);
    await slide(page, 'osc1-frequency-fine', 0);
    await expect(page.locator('#osc1-frequency')).toHaveValue('1');
    await slide(page, 'osc1-frequency-coarse', 0);
    await expect(page.locator('#osc1-frequency')).toHaveValue('10');
  });
}

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
      const activeControls = page.locator('.function-panel.active:visible input:not(:disabled), .function-panel.active:visible select:not(:disabled), .function-panel.active:visible button:not(:disabled):not(.editor-card-handle):not(.editor-card-close)');
      if (name === 'triggering') {
        const count = await activeControls.count();
        for (let index = 0; index < count; index += 1) {
          const control = activeControls.nth(index);
          if (!(await control.isVisible())) continue;
          await control.scrollIntoViewIfNeeded();
          const reachable = await control.evaluate(node => {
            const rect = node.getBoundingClientRect(); const clip = node.closest('.trigger-editor').getBoundingClientRect();
            const horizontal = rect.width > clip.width - 2
              ? rect.right > clip.left && rect.left < clip.right
              : rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
            return horizontal && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
          });
          expect(reachable, await control.getAttribute('id') ?? `trigger control ${index}`).toBe(true);
        }
        const triggerWidth = await page.locator('.trigger-editor').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth,
          inner: node.querySelector('.trigger-editor-inner').getBoundingClientRect().width }));
        expect(triggerWidth.scroll).toBeGreaterThanOrEqual(triggerWidth.client);
        expect(triggerWidth.inner).toBeGreaterThanOrEqual(760);
      }
      if (name === 'modulation') {
        const penv = page.locator('[data-editor-card="penv"] .penv-editor');
        const controls = penv.locator('input:not(:disabled), button:not(:disabled)');
        for (let index = 0; index < await controls.count(); index += 1) {
          const control = controls.nth(index);
          if (!(await control.isVisible())) continue;
          await control.scrollIntoViewIfNeeded();
          const reachable = await control.evaluate(node => {
            const rect = node.getBoundingClientRect(); const clip = node.closest('fieldset').getBoundingClientRect();
            return rect.left >= clip.left - 1 && rect.right <= clip.right + 1 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
          });
          expect(reachable, await control.getAttribute('id') ?? `PEnv control ${index}`).toBe(true);
        }
      }
      if (name === 'amp') {
        const row = page.locator('.function-panel.active .aenv-mode-row');
        const controls = row.locator('button:not(:disabled)');
        for (let index = 0; index < await controls.count(); index += 1) {
          const control = controls.nth(index);
          await control.scrollIntoViewIfNeeded();
          const reachable = await control.evaluate(node => {
            const rect = node.getBoundingClientRect(); const clip = node.closest('.aenv-mode-row').getBoundingClientRect();
            return rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
          });
          expect(reachable, `AEnv mode control ${index}`).toBe(true);
        }
      }
      const outside = name === 'triggering' ? [] : await activeControls.evaluateAll((controls) => controls.filter((control) => {
        if (control.getClientRects().length === 0) return false;
        if (control.closest('.aenv-mode-row')) return false;
        if (control.closest('.editor-card, .space-card')) {
          const rect = control.getBoundingClientRect();
          const card = control.closest('.editor-card, .space-card').getBoundingClientRect();
          const field = control.closest('fieldset')?.getBoundingClientRect();
          return rect.width < 1 || rect.left < card.left || rect.right > card.right || (field && rect.bottom > field.bottom);
        }
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
