import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openTimbreEditors } from './editor-helpers.mjs';

const card = (page, id) => page.locator(`[data-editor-card="${id}"]`);
const layout = page => page.locator('.editor-card.active').evaluateAll(nodes => nodes.map(node => node.dataset.editorCard));
async function start(page) {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
}
async function closeAll(page) {
  while (await page.locator('.editor-card.active').count()) await page.locator('.editor-card.active .editor-card-close').first().click();
}
async function select(page, id) { await page.locator(id === 'sequence' ? '#trigger-menu' : `#flow-${id}`).click(id === 'fx1' ? { position: { x: 8, y: 15 } } : undefined); }
async function saved(page, button) {
  const download = page.waitForEvent('download'); await page.locator(button).click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

test('edits independent cards, keeps switches intact, and applies capacity replacement', async ({ page }) => {
  await start(page); await select(page, 'filter1');
  expect(await layout(page)).toEqual(['osc1', 'osc2', 'filter1']);
  await page.locator('#osc1-frequency').fill('3800'); await page.locator('#osc1-frequency').dispatchEvent('input');
  await page.locator('#filter1-frequency').fill('1200'); await page.locator('#filter1-frequency').dispatchEvent('input');
  await card(page, 'osc2').locator('.editor-card-close').click();
  expect(await layout(page)).toEqual(['osc1', 'filter1']);
  await expect(page.locator('#flow-osc1')).toHaveClass(/active/);
  await expect(page.locator('#flow-filter1')).toHaveClass(/active/);
  await expect(page.locator('#flow-osc2')).not.toHaveClass(/active/);
  await expect(page.locator('[data-flow-block-wrapper="osc2"] [data-block-toggle]')).toHaveAttribute('aria-pressed', 'true');
  const timbre = await saved(page, '#save-1');
  expect(timbre.settings.osc1.baseFrequencyHz).toBe(3800); expect(timbre.settings.filter1.frequencyHz).toBe(1200);
  expect(timbre.settings.blocksEnabled.osc2).toBe(true);
  await select(page, 'filter1'); expect(await layout(page)).toEqual(['osc1']);
  await select(page, 'filter1'); expect(await layout(page)).toEqual(['osc1', 'filter1']);
  await select(page, 'mod'); await select(page, 'burst');
  expect(await layout(page)).toEqual(['osc1', 'filter1', 'mod', 'burst']);
  expect(await page.locator('.function-editor-row > .editor-card-column').count()).toBe(3);
  await select(page, 'sequence'); expect(await layout(page)).toEqual(['sequence']);
  await select(page, 'filter1'); expect(await layout(page)).toEqual(['sequence', 'filter1']);
});

test('reorders by keyboard and mouse without replacing controls or their values', async ({ page }) => {
  await start(page); await closeAll(page); await select(page, 'osc1'); await select(page, 'filter1');
  await page.locator('#osc1-frequency').evaluate(node => { node.dataset.identity = 'original'; });
  await page.locator('#osc1-frequency').fill('4100'); await page.locator('#osc1-frequency').dispatchEvent('input');
  const handle = card(page, 'osc1').locator('.editor-card-handle'); await handle.press('ArrowRight');
  expect(await layout(page)).toEqual(['filter1', 'osc1']);
  await expect(page.locator('#osc1-frequency')).toHaveAttribute('data-identity', 'original');
  await expect(page.locator('#osc1-frequency')).toHaveValue('4100');
  const from = await handle.boundingBox(), to = await card(page, 'filter1').locator('.editor-card-handle').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 }); await page.mouse.up();
  expect(await layout(page)).toEqual(['osc1', 'filter1']);
  await expect(page.locator('#osc1-frequency')).toHaveValue('4100');
});

test('retains unsaved layouts per timbre, exports both formats and restores files including empty layouts', async ({ page }) => {
  await start(page); await closeAll(page); await select(page, 'filter1'); await select(page, 'osc1');
  const timbre = await saved(page, '#save-1');
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v15'); expect(timbre.editorLayout).toEqual([['filter1'], ['osc1']]);
  await page.locator('#select-2').click(); await page.locator('#standard-2').click(); await closeAll(page);
  await page.locator('#select-1').click(); expect(await layout(page)).toEqual(['filter1', 'osc1']);
  await page.locator('#files-menu').click(); const session = await saved(page, '#export-patch');
  expect(session.formatVersion).toBe('KOROGI-Lab/session-v16'); expect(session.channels[1].timbre.editorLayout).toEqual([]);
  await page.locator('#patch-file').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded');
  await select(page, 'filter1'); expect(await layout(page)).toEqual(['filter1', 'osc1']);
  await page.locator('#select-2').click(); expect(await layout(page)).toEqual([]); await expect(page.locator('.function-editor .editor-empty')).toBeVisible();
  await page.locator('#timbre-file-2').setInputFiles({ name: 'timbre.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 2'); expect(await layout(page)).toEqual(['filter1', 'osc1']);
  await page.locator('#standard-2').click(); expect(await layout(page)).toEqual(['osc1', 'osc2']);
});

test('Sequence stays left while OSC1 and Filter1 stack, then save and reload preserve the columns', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openTimbreEditors(page, ['sequence', 'osc1']);
  await select(page, 'filter1');
  const columns = page.locator('.function-editor-row > .editor-card-column');
  await expect(columns).toHaveCount(2);
  expect(await columns.nth(0).locator('.editor-card.active').evaluateAll(nodes => nodes.map(node => node.dataset.editorCard))).toEqual(['sequence']);
  expect(await columns.nth(1).locator('.editor-card.active').evaluateAll(nodes => nodes.map(node => node.dataset.editorCard))).toEqual(['osc1', 'filter1']);
  const top = await card(page, 'osc1').boundingBox(), bottom = await card(page, 'filter1').boundingBox();
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height);
  const timbre = await saved(page, '#save-1');
  expect(timbre.editorLayout).toEqual([['sequence'], ['osc1', 'filter1']]);
  await page.locator('#timbre-file-2').setInputFiles({ name: 'stacked.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await page.locator('#select-2').click();
  expect(await columns.evaluateAll(nodes => nodes.map(column => [...column.querySelectorAll('.editor-card.active')].map(card => card.dataset.editorCard)))).toEqual([['sequence'], ['osc1', 'filter1']]);
  await card(page, 'filter1').locator('.editor-card-handle').press('Shift+ArrowDown');
  expect(await columns.evaluateAll(nodes => nodes.map(column => [...column.querySelectorAll('.editor-card.active')].map(card => card.dataset.editorCard)))).toEqual([['sequence'], ['osc1'], ['filter1']]);
  await card(page, 'filter1').locator('.editor-card-handle').press('Shift+ArrowLeft');
  expect(await columns.evaluateAll(nodes => nodes.map(column => [...column.querySelectorAll('.editor-card.active')].map(card => card.dataset.editorCard)))).toEqual([['sequence'], ['osc1', 'filter1']]);
});

test('dragging a Small card onto another makes a two-card column', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  const source = card(page, 'osc2').locator('.editor-card-handle');
  const from = await source.boundingBox(), target = await card(page, 'osc1').locator('.editor-card-handle').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 2, { steps: 8 }); await page.mouse.up();
  const columns = page.locator('.function-editor-row > .editor-card-column');
  await expect(columns).toHaveCount(1);
  expect(await columns.first().locator('.editor-card.active').evaluateAll(nodes => nodes.map(node => node.dataset.editorCard))).toEqual(['osc1', 'osc2']);
  expect((await saved(page, '#save-1')).editorLayout).toEqual([['osc1', 'osc2']]);
});

test('dedicated COMMON SPACE and FILES preserve the selected timbre layout', async ({ page }) => {
  await start(page); await select(page, 'filter1');
  for (const id of ['flow-near-fx2', 'flow-master', 'files-menu']) {
    await page.locator(`#${id}`).click(); await expect(page.locator('.function-editor')).toBeHidden();
    await expect(page.locator('#flow-osc1')).not.toHaveClass(/active/);
    await select(page, 'filter1'); expect(await layout(page)).toEqual(['osc1', 'osc2', 'filter1']);
  }
});

test('touch dragging reorders and pointer cancellation preserves order', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  try {
    const page = await context.newPage(); await start(page);
    const client = await context.newCDPSession(page);
    const from = await card(page, 'osc1').locator('.editor-card-handle').boundingBox();
    const to = await card(page, 'osc2').locator('.editor-card-handle').boundingBox();
    const point = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, id: 1 });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to.x + to.width - 4, y: to.y + to.height / 2, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await layout(page)).toEqual(['osc2', 'osc1']);
    const nextFrom = await card(page, 'osc2').locator('.editor-card-handle').boundingBox();
    const nextTo = await card(page, 'osc1').locator('.editor-card-handle').boundingBox();
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(nextFrom)] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(nextTo)] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(await layout(page)).toEqual(['osc2', 'osc1']);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
  } finally { await context.close(); }
});

test('every Small editor retains its controls within the minimum card width', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  for (const id of ['mod', 'filter2', 'burst', 'detune', 'fx1']) {
    await openTimbreEditors(page, ['osc1', 'osc2', id]);
    for (const effect of id === 'fx1' ? ['distortion', 'delay', 'chorus', 'reverb'] : [null]) {
      if (effect) await page.locator('#fx1-type').selectOption(effect);
      const overflows = await card(page, id).evaluate(root => {
        const card = root.getBoundingClientRect();
        return [...root.querySelectorAll('input, button, .slider-scale')].filter(node => {
          if (!node.getClientRects().length) return false;
          const rect = node.getBoundingClientRect();
          return rect.left < card.left || rect.right > card.right + 1;
        }).map(node => node.id || node.textContent);
      });
      expect(overflows, `${id} ${effect ?? ''}`).toEqual([]);
    }
    if (id === 'filter2' || id === 'burst') await page.screenshot({ path: testInfo.outputPath(`${id}-minimum-air.png`) });
  }
});

for (const closeBy of ['button', 'diagram']) {
test(`closing Sequence by ${closeBy} releases its held screen Trigger while recording and playback continue`, async ({ page }) => {
  await start(page); await closeAll(page); await select(page, 'sequence');
  await page.locator('#record-length').fill('10'); await page.locator('#record-length').dispatchEvent('change');
  await page.locator('#record-toggle').click(); await expect(page.locator('#record-toggle')).toContainText('End');
  await page.locator('#record-gate').scrollIntoViewIfNeeded();
  const trigger = await page.locator('#record-gate').boundingBox();
  await page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2); await page.mouse.down();
  await expect(page.locator('#gate-lamp')).toHaveClass(/on/);
  const close = closeBy === 'diagram' ? page.locator('#trigger-menu') : card(page, 'sequence').locator('.editor-card-close');
  await close.evaluate(button => button.click());
  await expect(page.locator('#gate-lamp')).not.toHaveClass(/on/);
  await expect(page.locator('#record-toggle')).toContainText('End');
  await page.mouse.up(); await select(page, 'sequence'); await page.locator('#record-toggle').click();
  const timbre = await saved(page, '#save-1');
  const recording = timbre.gatePatterns.find(item => item.id === timbre.sequence.gateUserId).recording;
  expect(recording.gates).toHaveLength(1); expect(recording.gates[0].offSec).toBeLessThan(recording.durationSec);
  await page.locator('#play-1').click(); await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await close.click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
});
}

test('Medium takes priority over Small and AEnv choices fit even at the Medium minimum', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openTimbreEditors(page, ['aenv', 'osc1']);
  expect((await card(page, 'aenv').boundingBox()).width).toBeCloseTo(602.67, 0);
  expect((await card(page, 'osc1').boundingBox()).width).toBeCloseTo(297.33, 0);
  await openTimbreEditors(page, ['aenv', 'penv']);
  expect((await card(page, 'aenv').boundingBox()).width).toBeCloseTo(450, 0);
  const row = page.locator('.aenv-mode-row');
  expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  const buttons = row.locator('button');
  expect(await buttons.count()).toBe(6);
  for (const button of await buttons.all()) {
    await expect(button).toBeVisible();
    expect(await button.evaluate(node => {
      const rect = node.getBoundingClientRect(), root = node.closest('.aenv-mode-row').getBoundingClientRect();
      return rect.left >= root.left && rect.right <= root.right + 1 && node.scrollWidth <= node.clientWidth + 1;
    })).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath('aenv-medium-minimum.png') });
});

test('Sequence Record title, vertical modes, unit and full timer fit the smallest inner editor', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openTimbreEditors(page, ['sequence', 'osc1']);
  await page.locator('#record-length').fill('300'); await page.locator('#record-length').dispatchEvent('change');
  const geometry = await card(page, 'sequence').evaluate(root => {
    const rect = selector => root.querySelector(selector).getBoundingClientRect();
    const counter = root.querySelector('#record-counter');
    return { title: rect('.trigger-user-group .trigger-group-title'), viewport: rect('.trigger-editor'),
      record: rect('.trigger-user-group'), counter: rect('#record-counter'), counterFits: counter.scrollWidth <= counter.clientWidth,
      length: rect('.record-length-label'), heading: rect('.record-length-heading'),
      modes: [...root.querySelectorAll('#record-mode + .segmented-choice button')].map(node => node.getBoundingClientRect()),
      grip: getComputedStyle(root.querySelector('.editor-card-handle'), '::before').backgroundImage };
  });
  expect(geometry.title.top).toBeGreaterThanOrEqual(geometry.viewport.top);
  expect(geometry.counter.right).toBeLessThanOrEqual(geometry.record.right);
  expect(geometry.counterFits).toBe(true);
  expect(geometry.heading.right).toBeLessThanOrEqual(geometry.length.right);
  expect(geometry.modes[0].bottom).toBeLessThanOrEqual(geometry.modes[1].top);
  expect(geometry.modes[1].bottom).toBeLessThanOrEqual(geometry.modes[2].top);
  expect(geometry.grip).toContain('radial-gradient');
  await expect(page.locator('.record-length-heading')).toHaveText('Record length (s)');
  await page.screenshot({ path: testInfo.outputPath('sequence-record-polish.png') });
});

test('live AoE width grows capacity, caps cards and retains wide layouts across resize and both file formats', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 }); await start(page);
  await openTimbreEditors(page, ['sequence', 'osc1']);
  const divider = page.locator('#mixer-divider'); await divider.press('End');
  await expect.poll(async () => (await card(page, 'sequence').boundingBox()).width).toBeGreaterThan(602.67);
  await divider.press('Home');
  await expect.poll(async () => (await card(page, 'sequence').boundingBox()).width).toBeCloseTo(602.67, 0);
  await page.setViewportSize({ width: 1638, height: 900 }); // 1366px AoE: Large 908 + gap 8 + Small 450.
  await expect.poll(async () => (await card(page, 'sequence').boundingBox()).width).toBeCloseTo(908, 0);
  expect((await card(page, 'osc1').boundingBox()).width).toBeCloseTo(450, 0);
  await page.setViewportSize({ width: 2000, height: 900 });
  await expect.poll(async () => (await card(page, 'sequence').boundingBox()).width).toBeCloseTo(908, 0);
  expect((await card(page, 'osc1').boundingBox()).width).toBeCloseTo(450, 0);
  await select(page, 'aenv');
  const expected = ['sequence', 'osc1', 'aenv']; expect(await layout(page)).toEqual(expected);
  const timbre = await saved(page, '#save-1');
  await page.locator('#files-menu').click(); const session = await saved(page, '#export-patch');
  await select(page, 'sequence'); await page.setViewportSize({ width: 1024, height: 768 });
  await expect.poll(() => layout(page)).toEqual(expected);
  await expect.poll(async () => (await card(page, 'sequence').boundingBox()).width).toBeCloseTo(602.67, 0);
  expect(await page.locator('.function-editor').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  for (const [file, input, status] of [[timbre, '#timbre-file-1', 'Loaded timbre'], [session, '#patch-file', 'Loaded']]) {
    await page.locator(input).setInputFiles({ name: 'wide.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
    await expect(page.locator('#patch-status')).toContainText(status);
    if (input === '#patch-file' && await page.locator('.function-editor').isHidden()) await select(page, 'sequence');
    expect(await layout(page)).toEqual(expected);
  }
  await page.setViewportSize({ width: 2000, height: 900 });
  await expect.poll(async () => (await card(page, 'sequence').boundingBox()).width).toBeCloseTo(908, 0);
  expect(await layout(page)).toEqual(expected);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(2000);
});

for (const viewport of [{ width: 1180, height: 820 }, { width: 1024, height: 768 }, { width: 1194, height: 834 },
  { width: 1440, height: 900 }, { width: 360, height: 800 }, { width: 844, height: 390 }]) {
  test(`card width limits and local scroll at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport); await start(page); await select(page, 'filter1');
    const geometry = await page.locator('.function-editor').evaluate(root => ({
      page: document.documentElement.scrollWidth, viewport: innerWidth, width: root.clientWidth, scroll: root.scrollWidth,
      cards: [...root.querySelectorAll('.editor-card.active')].map(node => ({ width: node.getBoundingClientRect().width, client: node.clientWidth, scroll: node.scrollWidth }))
    }));
    expect(geometry.page).toBe(geometry.viewport);
    geometry.cards.forEach(rect => { expect(rect.width).toBeCloseTo(Math.min(450, Math.max(908, viewport.width - 272) / 3 - 16 / 3), 0); expect(rect.scroll).toBeLessThanOrEqual(rect.client + 1); });
    const type = await page.locator('#filter1-type + .segmented-choice').boundingBox();
    const order = await page.locator('#filter1-order + .segmented-choice').boundingBox();
    expect(type.x + type.width).toBeLessThanOrEqual(order.x);
    expect(type.y).toBeCloseTo(order.y, 0);
    if (viewport.width === 1180) await page.screenshot({ path: testInfo.outputPath('small-three-air.png') });
    if (viewport.width < 1180) expect(geometry.scroll).toBeGreaterThan(geometry.width);
    await closeAll(page); await select(page, 'penv'); await select(page, 'aenv');
    const penv = await card(page, 'penv').boundingBox(); expect(penv.width).toBeCloseTo(Math.min(602.67, (Math.max(908, viewport.width - 272) - 8) / 2), 0);
    expect(await page.locator('.penv-controls-scroll').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await closeAll(page); await select(page, 'sequence'); await select(page, 'filter1');
    expect(await page.locator('.trigger-editor-inner').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(780);
    const sequenceScroll = await page.locator('.trigger-editor').evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(sequenceScroll.scroll).toBeGreaterThanOrEqual(780);
    if (sequenceScroll.client < 780) expect(sequenceScroll.scroll).toBeGreaterThan(sequenceScroll.client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    if (viewport.width === 1180) await page.screenshot({ path: testInfo.outputPath('large-small-air.png') });
  });
}
