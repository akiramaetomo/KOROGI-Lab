import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openCommonEditors, openTimbreEditors, compactNumericRows, expectCompactNumericRows } from './editor-helpers.mjs';

const layout = page => page.locator('.space-card.active').evaluateAll(nodes => nodes.map(node => node.dataset.commonCard));
async function start(page) { await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled(); }
async function save(page) {
  await page.locator('#files-menu').click(); const pending = page.waitForEvent('download'); await page.locator('#export-patch').click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

test('Near and Far edit both effects independently and close/reorder never changes audio state', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openCommonEditors(page, ['near', 'far']);
  await page.locator('#fx2-type').selectOption('delay'); await page.locator('#far-fx2-type').selectOption('distortion');
  await page.locator('#fx2-delay-time').fill('440'); await page.locator('#fx2-delay-time').dispatchEvent('change');
  await page.locator('#far-fx2-dist-drive').fill('18'); await page.locator('#far-fx2-dist-drive').dispatchEvent('change');
  await page.locator('[data-common-card="near"] .editor-card-handle').press('ArrowRight');
  expect(await layout(page)).toEqual(['far', 'near']);
  const handle = page.locator('[data-common-card="near"] .editor-card-handle');
  const from = await handle.boundingBox(), to = await page.locator('[data-common-card="far"] .editor-card-handle').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 6 }); await page.mouse.up();
  expect(await layout(page)).toEqual(['near', 'far']);
  await expect(page.locator('#fx2-delay-time')).toHaveValue('440');
  for (const id of ['flow-near-fx2', 'flow-near-fx3', 'flow-far-fx2', 'flow-far-fx3']) await expect(page.locator(`#${id}`)).toHaveClass(/active/);
  await page.locator('#play-1').click();
  await page.locator('[data-common-card="near"] .editor-card-close').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  const session = await save(page);
  expect(session.near.effects[0].type).toBe('delay'); expect(session.near.effects[0].delayTimeSec).toBe(.44);
  expect(session.far.effects[0].type).toBe('distortion'); expect(session.far.effects[0].distortionDriveDb).toBe(18);
  expect(session).not.toHaveProperty('commonEditorLayout');
  await page.locator('#flow-far-fx2').click(); expect(await layout(page)).toEqual(['far']);
  await page.locator('#flow-osc1').click(); await page.locator('#flow-far-fx2').click(); expect(await layout(page)).toEqual(['far']);
  await page.locator('#flow-far-fx3').click(); expect(await layout(page)).toEqual([]);
});

test('common rank capacity, all-close guidance and every output gain card remain independent', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openCommonEditors(page, ['near', 'near-gain']);
  expect((await page.locator('[data-common-card="near"]').boundingBox()).width).toBeCloseTo(602.67, 0);
  expect((await page.locator('[data-common-card="near-gain"]').boundingBox()).width).toBeCloseTo(297.33, 0);
  await page.locator('#flow-far-gain').click(); expect(await layout(page)).toEqual(['near', 'near-gain', 'far-gain']);
  expect(await page.locator('.common-editor .editor-card-column').last().locator('.space-card.active').count()).toBe(2);
  await openCommonEditors(page, ['near-gain', 'far-gain', 'master']);
  for (const [id, value] of [['near-gain', '-6'], ['far-gain', '-12'], ['master-gain', '-9']]) {
    await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).dispatchEvent('change');
  }
  const session = await save(page); expect(session.near.gainDb).toBe(-6); expect(session.far.gainDb).toBe(-12); expect(session.masterGainDb).toBe(-9);
  await page.locator('#flow-master').click();
  while (await page.locator('.space-card.active').count()) await page.locator('.space-card.active .editor-card-close').first().click();
  await expect(page.locator('.common-editor .editor-empty')).toBeVisible();
  await page.locator('#flow-balance').click(); expect(await layout(page)).toEqual(['balance']);
  await expect(page.locator('#crossfade')).toHaveValue('50');
});

test('COMMON SPACE stacks two Small cards and keeps the arrangement only during the session', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page); await openCommonEditors(page, ['near', 'near-gain']);
  await page.locator('#flow-far-gain').click();
  const columns = page.locator('.common-editor .editor-card-column');
  expect(await columns.evaluateAll(nodes => nodes.map(column => [...column.querySelectorAll('.space-card.active')].map(card => card.dataset.commonCard)))).toEqual([['near'], ['near-gain', 'far-gain']]);
  const session = await save(page);
  expect(session).not.toHaveProperty('commonEditorLayout');
  await page.locator('#flow-near-fx2').click();
  expect(await columns.evaluateAll(nodes => nodes.map(column => [...column.querySelectorAll('.space-card.active')].map(card => card.dataset.commonCard)))).toEqual([['near'], ['near-gain', 'far-gain']]);
});

for (const viewport of [{ width: 1180, height: 820 }, { width: 1024, height: 768 }, { width: 1194, height: 834 }, { width: 1440, height: 900 }, { width: 360, height: 800 }, { width: 844, height: 390 }]) {
  test(`common cards keep controls inside ranks at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport); await start(page);
    for (const ids of [['near', 'far'], ['near-gain', 'far-gain', 'balance'], ['master']]) {
      await openCommonEditors(page, ids);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      const overflow = await page.locator('.space-card.active').evaluateAll(cards => cards.flatMap(card => {
        const bounds = card.getBoundingClientRect();
        return [...card.querySelectorAll('input, button, select, .slider-scale span, .numeric-slider-name')].filter(node => {
          if (!node.getClientRects().length) return false;
          const rect = node.getBoundingClientRect(); return rect.left < bounds.left || rect.right > bounds.right + 1;
        }).map(node => node.id || node.textContent);
      }));
      expect(overflow).toEqual([]);
      if (ids[0] === 'near') {
        for (const prefix of ['', 'far-']) {
          const fx2 = await page.locator(`[data-effect-slot="${prefix}fx2"]`).boundingBox();
          const fx3 = await page.locator(`[data-effect-slot="${prefix}fx3"]`).boundingBox();
          expect(fx2.y).toBeCloseTo(fx3.y, 0); expect(fx2.width).toBeCloseTo(fx3.width, 0);
          expect(fx3.x).toBeGreaterThan(fx2.x + fx2.width);
          for (const type of ['distortion', 'delay', 'chorus', 'reverb']) {
            for (const slot of [2, 3]) await page.locator(`#${prefix}fx${slot}-type`).selectOption(type);
            const escaped = await page.locator(`[data-common-card="${prefix ? 'far' : 'near'}"] .effect-slot`).evaluateAll(fields => fields.flatMap(field => {
              const bounds = field.getBoundingClientRect();
              return [...field.querySelectorAll('input, select, button, .slider-scale span, .numeric-slider-name')].filter(node => {
                if (!node.getClientRects().length) return false;
                const rect = node.getBoundingClientRect(); return rect.left < bounds.left || rect.right > bounds.right + 1;
              }).map(node => node.id || node.textContent);
            }));
            expect(escaped).toEqual([]);
          }
        }
      }
      if (viewport.width === 1180 && ids[0] === 'near') await page.screenshot({ path: testInfo.outputPath('common-medium-air.png') });
    }
  });
}

for (const [node, expected] of [['flow-near-fx2', 'near'], ['flow-far-fx3', 'far'], ['flow-near-gain', 'near-gain'], ['flow-far-gain', 'far-gain']]) {
  test(`first common selection opens only ${expected} after closing OSC cards`, async ({ page }) => {
    await start(page);
    await page.locator('[data-editor-card="osc1"] .editor-card-close').click();
    await page.locator('[data-editor-card="osc2"] .editor-card-close').click();
    await page.locator(`#${node}`).click(); expect(await layout(page)).toEqual([expected]);
    await page.locator(`#${node}`).click(); expect(await layout(page)).toEqual([]);
    await expect(page.locator('.common-editor .editor-empty')).toBeVisible();
  });
}

test('diagram toggles preserve audio and explicit layouts across editing areas', async ({ page }) => {
  await start(page);
  await page.locator('#flow-near-gain').click(); expect(await layout(page)).toEqual(['near-gain']);
  await page.locator('#flow-near-fx2').click(); expect(await layout(page)).toEqual(['near-gain', 'near']);
  await page.locator('#flow-near-fx3').click(); expect(await layout(page)).toEqual(['near-gain']);
  await page.locator('#flow-osc1').click();
  await expect(page.locator('[data-editor-card="osc1"]')).toBeVisible();
  await page.locator('#flow-osc1').click();
  await expect(page.locator('[data-editor-card="osc1"]')).toBeHidden();
  await page.locator('#flow-near-gain').click(); expect(await layout(page)).toEqual(['near-gain']);
  await page.locator('#flow-near-fx2').click();
  await page.locator('#fx2-type').selectOption('delay');
  await page.locator('#fx2-delay-time').fill('440'); await page.locator('#fx2-delay-time').dispatchEvent('change');
  const toggle = page.locator('[data-effect-slot="fx2"] [data-block-toggle]');
  await toggle.click(); expect(await layout(page)).toEqual(['near-gain', 'near']);
  const enabled = await toggle.getAttribute('aria-pressed');
  await page.locator('#play-1').click();
  await page.locator('#flow-near-fx2').click(); expect(await layout(page)).toEqual(['near-gain']);
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#flow-near-fx3').click();
  await expect(toggle).toHaveAttribute('aria-pressed', enabled);
  await expect(page.locator('#fx2-delay-time')).toHaveValue('440');
  for (const id of ['flow-near-fx2', 'flow-near-fx3', 'flow-near-gain']) await expect(page.locator(`#${id}`)).toHaveClass(/active/);
  await expect(page.locator('#flow-far-fx2')).not.toHaveClass(/active/);
});

test('single-function headings move existing switches outside the drag handle', async ({ page }) => {
  await start(page);
  for (const id of ['osc1', 'osc2', 'mod', 'penv', 'filter1', 'filter2', 'aenv', 'burst', 'fx1', 'detune']) {
    await openTimbreEditors(page, [id]);
    const card = page.locator(`[data-editor-card="${id}"]`);
    await expect(card.locator('legend')).toHaveCount(0);
    const toggle = card.locator('.editor-card-heading > .flow-toggle');
    if (await toggle.count()) {
      await toggle.click(); await expect(card).toBeVisible();
      await expect(card).not.toHaveClass(/dragging/);
      const bounds = await toggle.boundingBox(), handle = await card.locator('.editor-card-handle').boundingBox();
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(handle.x);
    }
  }
  await openCommonEditors(page, ['near-gain']);
  await expect(page.locator('[data-common-card="near-gain"] legend')).toHaveCount(0);
  await expect(page.locator('[data-common-card="near-gain"] .editor-card-heading > .flow-toggle')).toHaveCount(1);
});

test('COMMON SPACE stacks three cards by keys and greys only the OFF FX slot', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openCommonEditors(page, ['near-gain', 'far-gain', 'balance']);
  const handle = id => page.locator(`[data-common-card="${id}"] .editor-card-handle`);
  const columns = () => page.locator('.common-editor .function-editor-row > .editor-card-column')
    .evaluateAll(nodes => nodes.map(column => [...column.querySelectorAll('.space-card.active')].map(node => node.dataset.commonCard)));
  await handle('far-gain').press('Shift+ArrowLeft'); await handle('balance').press('Shift+ArrowLeft');
  expect(await columns()).toEqual([['near-gain', 'far-gain', 'balance']]);
  await openCommonEditors(page, ['near']);
  const grey = slot => page.locator(`[data-effect-slot="${slot}"] > label`).evaluate(node => getComputedStyle(node).filter.includes('grayscale'));
  const fx2 = page.locator('[data-effect-slot="fx2"] legend .flow-toggle'), fx3 = page.locator('[data-effect-slot="fx3"] legend .flow-toggle');
  if (await fx2.getAttribute('aria-pressed') === 'true') await fx2.click();
  if (await fx3.getAttribute('aria-pressed') === 'true') await fx3.click();
  expect(await grey('fx2')).toBe(true); expect(await grey('fx3')).toBe(true);
  await fx2.click(); await expect(fx2).toHaveAttribute('aria-pressed', 'true');
  expect(await grey('fx2')).toBe(false); expect(await grey('fx3')).toBe(true);
  expect(await page.locator('[data-effect-slot="fx2"] legend').evaluate(node => getComputedStyle(node).filter)).toBe('none');
});

test('Near and Far use compact numeric rows while the envelope Medium cards keep their layout', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openCommonEditors(page, ['near', 'far']);
  for (const type of ['distortion', 'delay', 'chorus', 'reverb']) {
    for (const id of ['fx2-type', 'fx3-type', 'far-fx2-type', 'far-fx3-type']) await page.locator(`#${id}`).selectOption(type);
    const prefix = { distortion: 'dist', delay: 'delay', chorus: 'chorus', reverb: 'reverb' }[type];
    // Far may switch its visible parameter set a frame after the select change.
    await expect.poll(async () => (await compactNumericRows(page.locator('.space-card.active[data-rank="medium"]')))
      .every(control => control.id.replace(/^far-/, '').startsWith(`fx2-${prefix}-`) || control.id.replace(/^far-/, '').startsWith(`fx3-${prefix}-`)), type).toBe(true);
    const controls = await compactNumericRows(page.locator('.space-card.active[data-rank="medium"]'));
    expect(controls.length, type).toBeGreaterThanOrEqual(8);
    expectCompactNumericRows(controls, type);
    expect(controls.every(control => control.valueBesideCaption), type).toBe(true);
    expect(controls.filter(control => control.axes[0].mark).map(control => control.id.replace(/^far-/, '').replace(/^fx\d-/, '')),
      type).toEqual(Array(4).fill(`${prefix}-wet`));
  }
  await openTimbreEditors(page, ['aenv']);
  const attack = await page.locator('#attack-coarse').boundingBox();
  const scale = await page.locator('#attack-coarse + .slider-scale').boundingBox();
  expect(scale.y).toBeGreaterThanOrEqual(attack.y + attack.height - 1);
});
