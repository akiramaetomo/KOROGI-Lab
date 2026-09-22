import { test, expect } from '@playwright/test';

async function start(page) {
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
}

test('1024x768 shows a red Gate indicator and separates Auto playback from User recording', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await start(page);
  const indicator = page.locator('#gate-lamp');
  await expect(indicator).toBeVisible();
  await expect(page.locator('#play-all')).toBeEnabled();
  await expect(page.locator('#trigger')).toHaveText('Trigger');
  await page.locator('#trigger-menu').click();
  await expect(page.locator('[data-panel="triggering"]')).toHaveClass(/active/);
  const lampStyles = await page.locator('#gate-lamp, #gate-lamp-panel').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
      borderRadius: style.borderRadius, borderColor: style.borderColor, backgroundColor: style.backgroundColor, color: style.color };
  }));
  expect(lampStyles[0]).toEqual(lampStyles[1]);
  const triggerStyles = await page.locator('#trigger, #record-gate').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return { backgroundColor: style.backgroundColor, borderColor: style.borderColor, color: style.color };
  }));
  expect(triggerStyles[0]).toEqual(triggerStyles[1]);
  const gate = await page.locator('#gate-1').boundingBox();
  await page.mouse.move(gate.x + gate.width / 2, gate.y + gate.height / 2);
  await page.mouse.down();
  await expect(indicator).toHaveClass(/on/);
  await expect.poll(() => indicator.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(168, 36, 44)');
  await page.mouse.up();
  const layout = await page.locator('.trigger-editor').evaluate(editor => {
    const rect = selector => editor.querySelector(selector).getBoundingClientRect();
    const auto = rect('.trigger-settings');
    const controls = rect('.record-performance');
    const source = rect('.source-choice');
    const play = rect('#sequence-panel');
    const trigger = rect('#record-gate');
    const user = rect('.trigger-user-group');
    const length = rect('#record-length');
    const recording = rect('#record-toggle');
    const timeline = rect('#record-timeline');
    const ton = rect('#ton');
    const repeat = rect('#trepeat');
    return { auto, controls, source, play, trigger, user, length, recording, timeline, ton, repeat };
  });
  expect(layout.auto.right).toBeLessThan(layout.controls.left);
  expect(layout.ton.top).toBeLessThan(layout.repeat.top);
  expect(layout.source.top).toBeLessThan(layout.play.top);
  expect(layout.source.right).toBeLessThan(layout.trigger.left);
  expect(layout.trigger.top).toBeLessThan(layout.play.top);
  expect(layout.user.top).toBeGreaterThan(layout.auto.bottom);
  expect(layout.length.top).toBeLessThan(layout.timeline.top);
  expect(layout.recording.top).toBeLessThan(layout.timeline.top);
});

test('TIMBRES width resizes, scrolls below 65 percent, and collapses without stacking controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  const divider = page.locator('#mixer-divider');
  const mixer = page.locator('.mixer-panel');
  const width = () => mixer.evaluate(node => node.getBoundingClientRect().width);
  const headerControls = await page.locator('#fullscreen-toggle, #files-menu, #play-all, #trigger').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { id: node.id, left: rect.left, right: rect.right, visible: rect.width > 0 && rect.height > 0 };
  }));
  const headerLayout = await page.locator('.topbar').evaluate(node => ({ innerWidth, rect: node.getBoundingClientRect().toJSON(),
    grid: getComputedStyle(node).gridTemplateColumns, audio: getComputedStyle(node.querySelector('.audio-state')).display,
    brand: node.querySelector('.brand').getBoundingClientRect().toJSON(), transport: node.querySelector('.transport').getBoundingClientRect().toJSON() }));
  expect(headerControls.every(control => control.visible && control.left >= 0 && control.right <= 390), JSON.stringify({ headerControls, headerLayout })).toBe(true);
  await expect(page.locator('.audio-state')).toBeVisible();
  await expect(page.locator('#status')).toBeVisible();
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  expect(await width()).toBeCloseTo(248, 0);

  await divider.press('ArrowRight');
  expect(await width()).toBeCloseTo(248, 0);
  for (let index = 0; index < 12; index += 1) await divider.press('ArrowLeft');
  expect(await width()).toBeCloseTo(152, 0);
  const narrow = await mixer.evaluate(panel => {
    const sameRow = selector => {
      const tops = [...panel.querySelector(selector).children]
        .filter(node => node.getClientRects().length > 0)
        .map(node => node.getBoundingClientRect().top);
      return Math.max(...tops) - Math.min(...tops);
    };
    return { clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth,
      headingSpread: sameRow('[data-slot="1"] .slot-heading'), fileSpread: sameRow('[data-slot="1"] .slot-files') };
  });
  expect(narrow.clientWidth).toBeCloseTo(152, 0);
  expect(narrow.scrollWidth).toBeGreaterThanOrEqual(161);
  expect(narrow.headingSpread).toBeLessThan(1);
  expect(narrow.fileSpread).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('mobile-390x844-timbres-scroll.png') });

  const bar = await divider.boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await expect(page.locator('body')).toHaveClass(/mixer-resizing/);
  await page.mouse.move(bar.x - 40, bar.y + bar.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/mixer-resizing/);
  expect(await width()).toBeLessThan(152);

  await divider.press('End');
  expect(await width()).toBe(0);
  await expect(mixer).toHaveAttribute('aria-hidden', 'true');
  expect(await divider.getAttribute('aria-valuenow')).toBe('0');
  await divider.press('Home');
  expect(await width()).toBeCloseTo(248, 0);
  await expect(mixer).toHaveAttribute('aria-hidden', 'false');
  expect(await divider.getAttribute('aria-valuenow')).toBe('248');

  for (const viewport of [{ width: 360, height: 800 }, { width: 844, height: 390 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    expect(await width()).toBeCloseTo(248, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    if (viewport.width === 844) {
      await expect(page.locator('#status')).toBeVisible();
      const header = await page.locator('.topbar').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
      expect(header.scroll).toBeLessThanOrEqual(header.client);
    }
  }
});

test('Fullscreen control follows API state and reports a rejected request', async ({ page }) => {
  await page.addInitScript(() => {
    let fullscreenElement = null;
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => true });
    Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
    Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value(options) {
      window.fullscreenRequestOptions = options; fullscreenElement = this;
      document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve();
    } });
    Object.defineProperty(Document.prototype, 'exitFullscreen', { configurable: true, value() {
      fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve();
    } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  const toggle = page.locator('#fullscreen-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-label', 'Enter fullscreen');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Exit fullscreen');
  expect(await page.evaluate(() => window.fullscreenRequestOptions)).toEqual({ navigationUI: 'hide' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true, value: () => Promise.reject(new Error('denied'))
  }));
  await toggle.click();
  await expect(page.locator('#display-error')).toBeVisible();
  await expect(page.locator('#display-error')).toContainText('Fullscreen could not start');
  const header = await page.locator('.topbar').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
  expect(header.scroll).toBeLessThanOrEqual(header.client);
});

test('Fullscreen control stays hidden when the API is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false }));
  await start(page);
  await expect(page.locator('#fullscreen-toggle')).toBeHidden();
});

test('1024x768 uses equal diagram/editor heights and one shared signal-map scroll, permits dragging, and fits each editor page', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await start(page);
  const nameRow = page.locator('[data-slot="1"] .slot-name-row');
  await expect(nameRow).toHaveText('Mute');
  const placement = await nameRow.evaluate(row => {
    const card = row.closest('.mixer-slot');
    const input = row.querySelector('input').getBoundingClientRect();
    const mute = row.querySelector('button').getBoundingClientRect();
    const select = card.querySelector('.slot-select').getBoundingClientRect();
    const gate = card.querySelector('.slot-gate').getBoundingClientRect();
    const play = card.querySelector('.slot-play').getBoundingClientRect();
    return { nameLeft: input.left, selectLeft: select.left, selectRight: select.right, muteRight: mute.right,
      playLeft: play.left, playRight: play.right, gateLeft: gate.left, gateRight: gate.right,
      muteWidth: mute.width, gateWidth: gate.width, muteHeight: mute.height, gateHeight: gate.height };
  });
  expect(placement.nameLeft).toBeCloseTo(placement.selectLeft, 0);
  expect(placement.selectRight).toBeLessThan(placement.playLeft);
  expect(placement.playRight).toBeLessThan(placement.gateLeft);
  expect(placement.muteRight).toBeCloseTo(placement.gateRight, 0);
  expect(placement.muteWidth).toBe(placement.gateWidth);
  expect(placement.muteHeight).toBe(placement.gateHeight);
  const diagram = await page.locator('.signal-map').evaluate(root => {
    const rect = selector => root.querySelector(selector).getBoundingClientRect();
    return { detune: rect('#flow-detune'), sequence: rect('#trigger-menu'),
      title: rect('.common-heading strong'), pages: rect('.input-page-switch') };
  });
  expect(diagram.sequence.top).toBeCloseTo(diagram.detune.top, 0);
  expect(diagram.sequence.height).toBeCloseTo(diagram.detune.height, 0);
  expect(diagram.pages.left - diagram.title.right).toBeLessThan(16);
  await expect(page.locator('#pan-1')).toBeVisible();
  expect((await page.locator('#pan-1').boundingBox()).width).toBeGreaterThan(180);
  await expect(page.locator('#flow-near-input small, #flow-far-input small')).toHaveText(['L/R', 'L/R']);
  expect(await page.locator('#flow-near-input small').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(10.4);
  const sizes = () => page.locator('.editor-column').evaluate(column => {
    const graph = column.querySelector('.signal-map').getBoundingClientRect();
    const edit = column.querySelector('.workspace').getBoundingClientRect();
    return { graph: graph.height, edit: edit.height, total: graph.height + edit.height };
  });
  const initial = await sizes();
  expect(initial.graph / initial.total).toBeCloseTo(.5, 2);
  const scrollOwners = await page.locator('.signal-map, .source-group, .common-space').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).overflowY));
  expect(scrollOwners).toEqual(['auto', 'visible', 'visible']);
  const bar = await page.locator('#panel-divider').boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await expect(page.locator('body')).toHaveClass(/panel-resizing/);
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 28, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveClass(/panel-resizing/);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe('');
  expect((await sizes()).graph).toBeGreaterThan(initial.graph + 15);
  await page.locator('#panel-divider').press('Home');
  expect((await sizes()).graph / (await sizes()).total).toBeCloseTo(.5, 2);
  const sourceLayout = () => page.locator('[data-panel="sources"]').evaluate(panel => {
    const heading = panel.querySelector('.panel-heading').getBoundingClientRect();
    const phase = panel.querySelector('.source-phase-row').getBoundingClientRect();
    const cards = panel.querySelector('.control-columns').getBoundingClientRect();
    return { phaseHeight: phase.height, headingGap: phase.top - heading.bottom, cardsGap: cards.top - phase.bottom };
  });
  const sourceInitial = await sourceLayout();
  for (let index = 0; index < 10; index += 1) await page.locator('#panel-divider').press('ArrowUp');
  const sourceExpanded = await sourceLayout();
  expect(sourceExpanded.phaseHeight).toBeCloseTo(sourceInitial.phaseHeight, 0);
  expect(sourceExpanded.headingGap).toBeLessThan(10);
  expect(sourceExpanded.cardsGap).toBeLessThan(14);
  await page.locator('#panel-divider').press('Home');
  await page.locator('#flow-fx1').click({ position: { x: 8, y: 15 } }); await page.locator('#fx1-type').selectOption('delay');
  await page.locator('#flow-near-fx2').click(); await page.locator('#fx2-type').selectOption('delay');
  await expect(page.locator('#fx2-delay-time')).toBeEnabled();
  await page.locator('#fx3-type').selectOption('reverb');
  await expect(page.locator('#fx3-reverb-decay')).toBeEnabled();
  for (const [leftId, rightId] of [['fx2-delay-time', 'fx2-delay-feedback'], ['fx3-reverb-decay', 'fx3-reverb-wet']]) {
    const left = await page.locator(`#${leftId}-coarse + .slider-scale span:last-child`).boundingBox();
    const right = await page.locator(`#${rightId}-coarse + .slider-scale span:first-child`).boundingBox();
    expect(right.x - (left.x + left.width)).toBeGreaterThanOrEqual(6);
  }
  await page.screenshot({ path: testInfo.outputPath('common-space-1024x768.png') });
  const fits = [];
  for (const node of ['osc1', 'mod', 'filter1', 'aenv', 'fx1', 'near-fx2', 'balance', 'detune']) {
    await page.locator(`#flow-${node}`).click(node === 'fx1' ? { position: { x: 8, y: 15 } } : undefined);
    fits.push(await page.locator('.function-panel.active').evaluate((panel, node) => ({ node, scroll: panel.scrollHeight, client: panel.clientHeight }), node));
  }
  for (const node of ['trigger-menu', 'files-menu']) {
    await page.locator(`#${node}`).click();
    if (node === 'trigger-menu') await page.screenshot({ path: testInfo.outputPath('trigger-1024x768.png') });
    fits.push(await page.locator('.function-panel.active').evaluate((panel, node) => ({ node, scroll: panel.scrollHeight, client: panel.clientHeight }), node));
  }
  expect(fits.filter(({ scroll, client }) => scroll > client + 1)).toEqual([]);
  await expect(page.locator('#wire-arrow path')).toHaveAttribute('fill', '#8aafb5');
});

test('TIMBRE nodes use compact equal geometry and distinguish enabled from editing state', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await start(page);
  const geometry = await page.locator('.signal-canvas').evaluate(root => {
    const rect = id => root.querySelector(id).getBoundingClientRect();
    const ids = ['#flow-osc1', '#flow-penv', '#flow-osc2', '#flow-mod', '#flow-filter1', '#flow-aenv', '#flow-burst', '#flow-fx1', '#flow-filter2', '#flow-detune', '#trigger-menu'];
    return { nodes: ids.map(id => ({ id, width: rect(id).width, height: rect(id).height })), osc2: rect('#flow-osc2'), filter2: rect('#flow-filter2') };
  });
  expect(geometry.nodes.every(node => Math.abs(node.width - 96) < 1 && Math.abs(node.height - 30) < 1)).toBe(true);
  expect(geometry.osc2.y + geometry.osc2.height / 2).toBeCloseTo(geometry.filter2.y + geometry.filter2.height / 2, 0);
  const osc2Filter2 = await page.locator('path[data-from="osc2"][data-to="filter2"]').getAttribute('d');
  expect(osc2Filter2).not.toContain(' V ');

  const enabled = await page.locator('#flow-aenv').evaluate(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, border: style.borderTopWidth, color: style.color }; });
  const off = await page.locator('#flow-filter1').evaluate(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, border: style.borderTopWidth, color: style.color }; });
  const burst = await page.locator('#flow-burst').evaluate(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, border: style.borderTopWidth, color: style.color }; });
  expect(enabled).toEqual({ background: 'rgb(72, 94, 85)', border: '1px', color: 'rgb(238, 244, 232)' });
  expect(off.border).toBe('1px');
  expect(burst).toEqual(off);

  const triggerColors = await page.locator('#trigger, .slot-gate, #record-gate, #trigger-menu').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, border: style.borderColor, color: style.color, disabled: node.disabled }; }));
  expect(triggerColors.every(style => style.background === 'rgb(41, 63, 46)' && style.border === 'rgb(128, 150, 111)')).toBe(true);
  expect(triggerColors.filter(style => !style.disabled).every(style => style.color === 'rgb(219, 233, 211)')).toBe(true);
  const fx1Buttons = await page.locator('#fx1-monitor-toggle, [data-flow-block-wrapper="fx1"] .flow-toggle').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height }; }));
  expect(fx1Buttons).toHaveLength(2);
  expect(fx1Buttons.every(({ width, height }) => Math.abs(width - 24) < 1 && Math.abs(height - 22) < 1)).toBe(true);
  await page.locator('#flow-filter1').click();
  await expect(page.locator('#flow-filter1')).toHaveClass(/active/);
  await expect(page.locator('#flow-filter1')).toHaveClass(/bypassed/);
  expect(await page.locator('#flow-filter1').evaluate(node => getComputedStyle(node).boxShadow)).toContain('rgb(176, 210, 223)');
  await page.locator('.source-group [data-block-toggle="filter1"]').click();
  await expect(page.locator('#flow-filter1')).toHaveClass(/enabled/);
  await expect(page.locator('#flow-filter1')).not.toHaveClass(/bypassed/);
  await expect(page.locator('#flow-filter1')).toHaveCSS('background-color', 'rgb(72, 94, 85)');
  await expect(page.locator('#flow-filter1')).toHaveCSS('border-top-width', '1px');
  expect(await page.locator('#flow-filter1').evaluate(node => getComputedStyle(node).boxShadow)).toContain('rgb(176, 210, 223)');
});

test('FILTER Type and Order sit above Frequency and Q at the standard width', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await start(page);
  await expect(page.locator('#filter1-type')).toBeEnabled();
  await page.locator('#flow-filter1').click({ position: { x: 8, y: 10 } });
  await expect(page.locator('[data-panel="filters"]')).toBeVisible();
  for (const index of [1, 2]) {
    const type = await page.locator(`#filter${index}-type + .segmented-choice`).boundingBox();
    const order = await page.locator(`#filter${index}-order + .segmented-choice`).boundingBox();
    const frequency = await page.locator(`[data-numeric-control="filter${index}-frequency"]`).boundingBox();
    const q = await page.locator(`[data-numeric-control="filter${index}-q"]`).boundingBox();
    expect(type.y).toBeCloseTo(order.y, 0);
    expect(frequency.y).toBeCloseTo(q.y, 0);
    expect(type.y + type.height).toBeLessThanOrEqual(frequency.y + 1);
    expect(type.x).toBeLessThan(order.x);
    expect(frequency.x).toBeLessThan(q.x);
  }
  await page.screenshot({ path: testInfo.outputPath('filters-1024x768.png') });
});

test('invalid author range appears in the header before the audio graph starts', async ({ page }) => {
  await page.route('**/src/config/parameterRanges.ts*', route => route.fulfill({
    contentType: 'application/javascript',
    body: 'export const PARAMETER_RANGES = { "osc1-frequency": { min: NaN } };'
  }));
  await page.goto('/');
  await expect(page.locator('#audio-error')).toContainText('src/config/parameterRanges.ts: osc1-frequency.min');
  await expect(page.locator('#status')).toHaveText('Initialization stopped');
  await expect(page.locator('#play-all')).toBeDisabled();
});

test('a safe author range edit reaches the UI and import normalization', async ({ page }) => {
  await page.route('**/src/config/parameterRanges.ts*', async route => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: `${body}\nPARAMETER_RANGES["filter-frequency"].min = 25;` });
  });
  await start(page);
  await expect(page.locator('#filter1-frequency')).toHaveAttribute('min', '25');
  await expect(page.locator('#filter2-frequency')).toHaveAttribute('min', '25');
  const normalized = await page.evaluate(async () => {
    const { defaultTimbre, normalizeTimbre } = await import('/src/model/documents.ts');
    const timbre = defaultTimbre();
    timbre.settings.filter1.frequencyHz = 1;
    return normalizeTimbre(timbre).settings.filter1.frequencyHz;
  });
  expect(normalized).toBe(25);
});

test('Double-click restores the declared initial values through the normal parameter handlers', async ({ page }) => {
  await start(page);
  await expect(page.locator('#crossfade-coarse + .slider-scale span')).toHaveText(['0%', '50%', '100%']);
  await expect(page.locator('#filter1-frequency-fine + .slider-scale span').nth(1)).toHaveText('0 cent');
  await expect(page.locator('#osc1-frequency-fine + .slider-scale span').nth(1)).toHaveText('0%');
  await expect(page.locator('#master-gain-coarse + .slider-scale span')).toHaveText(['-60 dB', '', '0 dB']);
  await page.locator('#level-1').evaluate(input => { input.value = '-9'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#level-1').dblclick();
  await expect(page.locator('#level-1')).toHaveValue('0');
  await page.locator('#balance-1').evaluate(input => { input.value = '.2'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#balance-1').dblclick();
  await expect(page.locator('#balance-1')).toHaveValue('0.5');
  await page.locator('#flow-near-gain').click();
  await page.locator('#near-gain').fill('-12'); await page.locator('#near-gain').dispatchEvent('change');
  await page.locator('#near-gain-coarse').dblclick();
  await expect(page.locator('#near-gain')).toHaveValue('0');
  await expect(page.locator('#near-gain-readout')).toHaveText('0.0 dB');
  await page.locator('#flow-master').click();
  await page.locator('#master-gain').fill('-30'); await page.locator('#master-gain').dispatchEvent('change');
  await page.locator('#master-gain-coarse').dblclick();
  await expect(page.locator('#master-gain')).toHaveValue('-18');
  await page.locator('#crossfade').fill('10'); await page.locator('#crossfade').dispatchEvent('change');
  await page.locator('#crossfade-coarse').dblclick();
  await expect(page.locator('#crossfade')).toHaveValue('50');
});

test('First Gate gesture resumes audio, and release before resume never leaves Gate on', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); window.__testAudioContext = this; }
    };
  });
  await page.goto('/');
  await expect(page.locator('#start-audio')).toHaveCount(0);
  await expect(page.locator('#gate-1')).toBeEnabled();
  await page.evaluate(async () => {
    const context = window.__testAudioContext;
    await context.suspend();
    const resume = context.resume.bind(context);
    context.resume = () => new Promise((resolve, reject) => {
      window.__releaseResume = () => resume().then(resolve, reject);
    });
  });
  const gate = await page.locator('#gate-1').boundingBox();
  await page.mouse.move(gate.x + gate.width / 2, gate.y + gate.height / 2);
  await page.mouse.down(); await page.mouse.up();
  await page.evaluate(() => window.__releaseResume());
  await expect(page.locator('#gate-1')).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.down();
  await expect.poll(() => page.locator('#gate-1').getAttribute('aria-pressed'), { intervals: [50] }).toBe('true');
  await page.mouse.up();
  await expect.poll(() => page.locator('#gate-1').getAttribute('aria-pressed'), { intervals: [50] }).toBe('false');
});

test('Global Auto covers every populated voice including muted ones and preserves per-voice timing', async ({ page }) => {
  await page.goto('/');
  await page.locator('#select-2').click(); await page.locator('#standard-2').click();
  await page.locator('#select-3').click(); await page.locator('#standard-3').click();
  await page.locator('#select-2').click(); await page.locator('#mute-2').click();
  await page.locator('#trigger-menu').click();
  await page.locator('#ton').fill('700'); await page.locator('#ton').dispatchEvent('change');
  await page.locator('#trepeat').fill('1800'); await page.locator('#trepeat').dispatchEvent('change');
  await page.locator('#play-all').click();
  for (const id of ['1', '2', '3']) await expect(page.locator(`#play-${id}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-4')).toBeDisabled();
  await expect(page.locator('#mute-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ton')).toHaveValue('700'); await expect(page.locator('#trepeat')).toHaveValue('1800');
  await page.locator('#play-all').click();
  for (const id of ['1', '2', '3']) await expect(page.locator(`#play-${id}`)).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#play-2').click(); await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#play-2').click();
  await page.locator('#select-1').click(); await page.locator('#trigger-menu').click();
  await page.locator('#sequence-panel').click(); await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#play-2')).toHaveAttribute('aria-pressed', 'false');
});

test('Audio resume failure is visible and the next Auto gesture retries', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); window.__testAudioContext = this; }
    };
  });
  await page.goto('/');
  await expect(page.locator('#play-all')).toBeEnabled();
  await page.evaluate(async () => {
    const context = window.__testAudioContext;
    await context.suspend();
    const resume = context.resume.bind(context);
    let attempt = 0;
    context.resume = () => ++attempt === 1 ? Promise.reject(new Error('test interruption')) : resume();
  });
  await page.locator('#play-all').click();
  await expect(page.locator('#audio-error')).toBeVisible();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#play-all').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#audio-error')).toBeHidden();
  await page.locator('#play-all').click();
});

test('Touching diagram blocks never opens an editor input or native select', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage(); await page.goto('/');
    for (const [node, panel] of [['detune', 'output'], ['aenv', 'amp'], ['osc1', 'sources'], ['filter1', 'filters']]) {
      await page.locator(`#flow-${node}`).tap();
      await expect(page.locator(`[data-panel="${panel}"]`)).toHaveClass(/active/);
      expect(await page.evaluate(() => document.activeElement?.tagName)).not.toMatch(/INPUT|SELECT/);
    }
  } finally { await context.close(); }
});
