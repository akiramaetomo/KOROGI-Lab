import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function start(page) {
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
}
async function save(page) {
  await page.locator('#files-menu').click(); const pending = page.waitForEvent('download'); await page.locator('#export-patch').click();
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'));
}

test('Graph opens settings without focusing an input or select, including SEQUENCE and FILES', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  await expect(page.locator('.function-nav, #channel-gain, [data-flow-block="channelGain"], .common-mix')).toHaveCount(0);
  for (const [node, panel, focus] of [
    ['osc1', 'sources', 'osc1-type'], ['osc2', 'sources', 'osc2-type'], ['mod', 'modulation', 'mod-mode'],
    ['filter1', 'filters', 'filter1-type'], ['filter2', 'filters', 'filter2-type'], ['aenv', 'amp', 'attack'],
    ['penv', 'modulation', 'penv-amount'], ['fx1', 'voice-effects', 'fx1-type'], ['detune', 'output', 'detune-range']
  ]) {
    await page.locator(`#flow-${node}`).click(node === 'fx1' ? { position: { x: 8, y: 15 } } : undefined); await expect(page.locator(`[data-panel="${panel}"]`)).toHaveClass(/active/);
    await expect(page.locator(`#${focus}`)).not.toBeFocused();
  }
  await expect(page.locator('#trigger-menu')).toHaveText('SEQUENCE');
  await page.locator('#trigger-menu').focus(); await page.keyboard.press('Enter'); await expect(page.locator('[data-panel="triggering"] .panel-heading')).toBeFocused();
  await expect(page.locator('[data-panel="triggering"] .panel-heading strong')).toHaveText('SEQUENCE');
  await expect(page.locator('#active-path')).toHaveText('Viewing: SEQUENCE');
  await page.locator('#files-menu').click(); await expect(page.locator('[data-panel="patch"]')).toHaveClass(/active/);
  const value = await save(page);
  expect(value.formatVersion).toBe('KOROGI-Lab/session-v8'); expect(value.channels[0].timbre.formatVersion).toBe('KOROGI-Lab/timbre-v7');
  expect(value.channels[0].timbre.settings).not.toHaveProperty('channelGainDb'); expect(value.channels[0].timbre.settings.blocksEnabled).not.toHaveProperty('channelGain');
  expect(errors).toEqual([]);
});

test('Parallel buses have independent switches and click targets; v2 restore synchronizes every graph switch', async ({ page }) => {
  await start(page);
  const toggle = (bus, block) => block === 'mixGain'
    ? page.locator(`#${bus}-gain`).locator('..').locator('[data-block-toggle="mixGain"]')
    : page.locator(`[data-space="${bus}"] [data-block-toggle="${block}"]`);
  await toggle('near', 'fx2').click(); await toggle('far', 'fx3').click();
  await page.locator('#flow-far-gain').click(); await toggle('far', 'mixGain').click();
  await expect(toggle('far', 'fx2')).toHaveAttribute('aria-pressed', 'false'); await expect(toggle('near', 'fx3')).toHaveAttribute('aria-pressed', 'false');
  for (const bus of ['near', 'far']) {
    await page.locator(`#flow-${bus}-fx2`).click(); await expect(page.locator(`#effects-${bus}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#fx2-type')).not.toBeFocused();
    await page.locator('#fx2-type').selectOption(bus === 'near' ? 'delay' : 'chorus');
  }
  await page.locator('.source-group [data-block-toggle="aenv"]').click();
  const saved = await save(page); expect(saved.near.effects[0].enabled).toBe(true); expect(saved.far.effects[1].enabled).toBe(true); expect(saved.far.gainEnabled).toBe(false);
  await toggle('near', 'fx2').click(); await toggle('far', 'fx3').click();
  await page.locator('#patch-file').setInputFiles({ name: 'restore.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await expect(toggle('near', 'fx2')).toHaveAttribute('aria-pressed', 'true'); await expect(toggle('far', 'fx3')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.source-group [data-block-toggle="aenv"]')).toHaveAttribute('aria-pressed', 'false');
  const restored = await save(page); delete saved.savedAt; delete restored.savedAt; expect(restored).toEqual(saved);
});

test('Channel inputs replace summaries; mixer selection and send coefficients remain independent', async ({ page }) => {
  await start(page); await page.locator('#select-2').click(); await page.locator('#standard-2').click();
  await expect(page.locator('.voice-overview, .voice-summary')).toHaveCount(0);
  await expect(page.locator('.channel-input')).toHaveCount(8);
  await expect(page.locator('.channel-input:visible')).toHaveCount(4);
  await expect(page.locator('.common-heading')).toContainText('COMMON SPACE');
  await expect(page.locator('#voice-title')).toContainText('TIMBRE · 2'); await expect(page.locator('#select-2')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#balance-2').evaluate(input => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const wire = page.locator('path[data-from="input-2"][data-to="near-input"]'); await expect(wire).toHaveCSS('opacity', '1');
  await expect(page.locator('path[data-from="input-2"][data-to="far-input"]')).toHaveCSS('opacity', '0.15');
  await page.locator('#level-2').evaluate(input => { input.value = '-9'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#level-2')).toHaveValue('-9');
  await page.locator('#mute-2').click(); await expect(wire).toHaveCSS('opacity', '0.15');
  await page.locator('#clear-2').click(); await expect(page.locator('#voice-title')).toContainText('Empty');
  await expect(wire).toHaveCSS('opacity', '0.15'); await expect(page.locator('#fx1-type')).toBeDisabled();
});

test('Every block in the current editor is illuminated, including bypassed blocks and the selected FX bus', async ({ page }) => {
  await page.goto('/');
  const active = () => page.locator('.signal-map [data-panel-target].active').evaluateAll(nodes => nodes.map(node => node.id).sort());
  await expect.poll(active).toEqual(['flow-osc1', 'flow-osc2']);
  for (const [clicked, ids] of [
    ['osc2', ['flow-osc1', 'flow-osc2']], ['filter1', ['flow-filter1', 'flow-filter2']],
    ['penv', ['flow-mod', 'flow-penv']], ['aenv', ['flow-aenv']], ['detune', ['flow-detune']],
    ['far-fx2', ['flow-far-fx2', 'flow-far-fx3', 'flow-far-gain']]
  ]) {
    await page.locator(`#flow-${clicked}`).click(); await expect.poll(active).toEqual(ids.sort());
  }
  await page.locator('#effects-near').click();
  await expect.poll(active).toEqual(['flow-near-fx2', 'flow-near-fx3', 'flow-near-gain']);
  await expect(page.locator('#flow-near-gain')).toHaveCSS('background-color', 'rgb(52, 71, 80)');
  await page.locator('#flow-master').click();
  await expect.poll(active).toEqual(['flow-balance', 'flow-master']);
  for (const id of ['balance', 'master']) await expect(page.locator(`#flow-${id}`)).toHaveCSS('background-color', 'rgb(52, 71, 80)');
  await page.locator('#flow-filter2').click();
  await expect(page.locator('#flow-filter1')).toHaveClass(/active/);
  await expect(page.locator('#flow-filter1')).toHaveClass(/bypassed/);
  await expect(page.locator('#flow-filter1')).toHaveCSS('opacity', '1');
  await page.locator('.source-group [data-block-toggle="filter1"]').click();
  await expect(page.locator('#flow-filter1')).not.toHaveClass(/bypassed/);
  await page.locator('#trigger-menu').click(); await expect.poll(active).toEqual(['trigger-menu']);
  await page.locator('#files-menu').click(); await expect.poll(active).toEqual([]);
});

for (const [width, height] of [[1024, 768], [768, 768]]) {
  test(`FX1 common and FILTER2 cutoff routes stay clear at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await start(page);
    await expect(page.locator('#flow-fx1-common')).toHaveText('COMMON SPACE');
    const commonLength = await page.locator('path[data-from="fx1"][data-to="fx1-common"]').evaluate(path => path.getTotalLength());
    expect(commonLength).toBeGreaterThanOrEqual(23.5);

    await page.locator('#flow-filter2').click();
    await page.locator('.filter-route-field [role="radio"]').last().click();
    await expect(page.locator('path[data-from="filter2"][data-to="filter1"]')).toHaveCount(1);
    const route = await page.locator('.signal-canvas').evaluate(root => {
      const path = root.querySelector('path[data-from="filter2"][data-to="filter1"]');
      const origin = root.getBoundingClientRect();
      const filter2 = root.querySelector('#flow-filter2').getBoundingClientRect();
      const filter1 = root.querySelector('#flow-filter1').getBoundingClientRect();
      const mod = root.querySelector('#flow-mod').getBoundingClientRect();
      const start = path.getPointAtLength(0);
      const end = path.getPointAtLength(path.getTotalLength());
      const points = [];
      for (let distance = 1; distance < path.getTotalLength(); distance += 1) {
        const point = path.getPointAtLength(distance);
        points.push({ x: point.x + origin.left, y: point.y + origin.top });
      }
      return {
        d: path.getAttribute('d'),
        start: { x: start.x + origin.left, y: start.y + origin.top },
        end: { x: end.x + origin.left, y: end.y + origin.top },
        expectedStart: { x: filter2.right, y: filter2.top + filter2.height / 2 },
        expectedEnd: { x: filter1.left + filter1.width / 2, y: filter1.bottom },
        crossesMod: points.some(point => point.x > mod.left && point.x < mod.right && point.y > mod.top && point.y < mod.bottom)
      };
    });
    expect(route.d).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+ V [\d.]+$/);
    expect(Math.hypot(route.start.x - route.expectedStart.x, route.start.y - route.expectedStart.y)).toBeLessThan(1);
    expect(Math.hypot(route.end.x - route.expectedEnd.x, route.end.y - route.expectedEnd.y)).toBeLessThan(1);
    expect(route.crossesMod).toBe(false);
  });
}

test('Bus gains and separate OUTPUT editor use horizontal controls and survive save/restore', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); await start(page);
  await page.locator('#flow-near-gain').click();
  await expect(page.locator('[data-panel="space-effects"]')).toHaveClass(/active/);
  await expect(page.locator('#near-gain')).not.toBeFocused();
  for (const bus of ['near', 'far']) {
    await page.locator(`#effects-${bus}`).click();
    await page.locator(`#${bus}-gain`).fill('-17.7');
    await page.locator(`#${bus}-gain`).dispatchEvent('change');
    await expect(page.locator(`#${bus}-gain-readout`)).toHaveText('-17.7 dB');
  }
  await page.locator('#flow-balance').click();
  await expect(page.locator('[data-panel="space-output"]')).toHaveClass(/active/);
  for (const id of ['crossfade-coarse', 'master-gain-coarse']) {
    const rect = await page.locator(`#${id}`).boundingBox();
    expect(rect.width).toBeGreaterThan(rect.height);
  }
  await page.locator('#master-gain').fill('-17.7'); await page.locator('#master-gain').dispatchEvent('change');
  await expect(page.locator('#master-gain')).toHaveValue('-17.7');
  const saved = await save(page);
  expect(saved.near.gainDb).toBe(-17.7); expect(saved.far.gainDb).toBe(-17.7); expect(saved.masterGainDb).toBe(-17.7);
  await page.locator('#patch-file').setInputFiles({ name: 'gains.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  for (const id of ['near-gain', 'far-gain', 'master-gain']) await expect(page.locator(`#${id}`)).toHaveValue('-17.7');
  await expect(page.locator('#master-gain-coarse')).toBeEnabled();
});

test('FX1 MON is transient and the signal map shows only the selected COMMON SPACE or direct route', async ({ page }) => {
  await start(page);
  await expect(page.locator('#master-input-mode')).toHaveCount(0);
  await expect(page.locator('#fx1-monitor-toggle')).toHaveText('MON');
  await expect(page.locator('#fx1-monitor-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#master-input-readout')).toHaveText('COMMON SPACE');
  await expect(page.locator('#flow-fx1-common')).toBeVisible();
  await expect(page.locator('path[data-from="fx1"][data-to="fx1-common"]')).toHaveCount(1);
  await expect(page.locator('path[data-from="balance"][data-to="master"]')).toHaveCount(1);
  await expect(page.locator('path[data-from="fx1"][data-to="master"]')).toHaveCount(0);
  await page.locator('#fx1-monitor-toggle').click();
  await expect(page.locator('#fx1-monitor-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#master-input-readout')).toHaveText('FX1 MON');
  await expect(page.locator('#flow-fx1-common')).toBeHidden();
  await expect(page.locator('path[data-from="fx1"][data-to="fx1-common"]')).toHaveCount(0);
  await expect(page.locator('path[data-from="balance"][data-to="master"]')).toHaveCount(0);
  await expect(page.locator('path[data-from="fx1"][data-to="master"]')).toHaveCount(1);
  const directRoute = await page.locator('.signal-canvas').evaluate(root => {
    const path = root.querySelector('path[data-from="fx1"][data-to="master"]');
    const sequence = root.querySelector('#trigger-menu').getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const points = [];
    for (let distance = 1; distance < path.getTotalLength(); distance += 2) {
      const point = path.getPointAtLength(distance);
      points.push({ x: point.x + origin.left, y: point.y + origin.top });
    }
    return { d: path.getAttribute('d'), crossesSequence: points.some(point => point.x > sequence.left && point.x < sequence.right && point.y > sequence.top && point.y < sequence.bottom) };
  });
  expect(directRoute.d).toMatch(/ H .* V /);
  expect(directRoute.crossesSequence).toBe(false);
  const session = await save(page); expect(session).not.toHaveProperty('masterInputMode');
  await page.locator('#timbre-file-1').setInputFiles({ name: 'timbre.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session.channels[0].timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  await expect(page.locator('#master-input-readout')).toHaveText('FX1 MON');
  await expect(page.locator('#fx1-monitor-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('path[data-from="fx1"][data-to="master"]')).toHaveCount(1);
  await page.locator('#patch-file').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(session)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
  await expect(page.locator('#master-input-readout')).toHaveText('COMMON SPACE');
  await expect(page.locator('#fx1-monitor-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#flow-fx1-common')).toBeVisible();
  await expect(page.locator('path[data-from="balance"][data-to="master"]')).toHaveCount(1);
});

test('Bus Gain to Output Balance wires keep their length when the window widens', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); await start(page);
  const lengths = () => page.locator('path[data-to="balance"]').evaluateAll(paths => paths.map(path => path.getTotalLength()));
  await expect(page.locator('path[data-to="balance"]')).toHaveCount(2);
  const narrow = await lengths();
  await page.setViewportSize({ width: 1920, height: 768 });
  await expect.poll(async () => (await lengths()).every((length, index) => Math.abs(length - narrow[index]) < 2)).toBe(true);
});

test('Near and Far titles sit on the frame; output arrows run horizontally', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 }); await start(page);
  await expect(page.locator('path[data-from="master"][data-to="limiter"]')).toHaveCount(1);
  const layout = await page.locator('.signal-canvas').evaluate(root => {
    const center = id => { const r = root.querySelector(`#flow-${id}`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const labels = [...root.querySelectorAll('.bus-group')].map(group => {
      const box = group.getBoundingClientRect(), style = getComputedStyle(group, '::before');
      return { boxCenter: box.left + box.width / 2, labelX: box.left + parseFloat(style.left), top: style.top };
    });
    const path = root.querySelector('path[data-from="master"][data-to="limiter"]');
    return { balance: center('balance'), master: center('master'), limiter: center('limiter'), labels,
      limiterPath: path.getAttribute('d') };
  });
  expect(Math.abs(layout.balance.y - layout.master.y)).toBeLessThan(2);
  expect(Math.abs(layout.master.y - layout.limiter.y)).toBeLessThan(2);
  expect(layout.master.x).toBeLessThan(layout.limiter.x);
  expect(layout.labels.every(label => Math.abs(label.boxCenter - label.labelX) < 2 && label.top === '0px')).toBe(true);
  expect(layout.limiterPath).not.toContain(' V ');
});

for (const [width, height] of [[1366, 768], [1440, 900], [1920, 1080], [1024, 900], [768, 768]]) {
  test(`SVG ports, parallel layout and scroll remain aligned at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height }); await start(page);
    const ports = async () => page.locator('.signal-canvas').evaluate(root => {
      const origin = root.getBoundingClientRect();
      return [...root.querySelectorAll('.wire-paths path')].map(path => {
        const node = root.querySelector(`#flow-${path.dataset.to}`), rect = node.getBoundingClientRect();
        const p = path.getPointAtLength(path.getTotalLength());
        const end = path.dataset.end;
        const lane = path.dataset.from.startsWith('input-') ? Number(path.dataset.from.slice(-1)) : null;
        const x = end === 'left' ? rect.left : end === 'right' ? rect.right : rect.left + rect.width / 2;
        if (lane !== null) {
          const absoluteY = p.y + origin.top;
          return Math.abs(p.x + origin.left - x) + Math.max(rect.top - absoluteY, absoluteY - rect.bottom, 0);
        }
        const y = end === 'top' ? rect.top : end === 'bottom' ? rect.bottom : rect.top + rect.height / 2;
        return Math.hypot(p.x + origin.left - x, p.y + origin.top - y);
      });
    });
    await expect.poll(async () => (await ports()).every(error => error < 1)).toBe(true);
    await page.setViewportSize({ width: width - 20, height: height - 40 });
    await expect.poll(async () => (await ports()).every(error => error < 1)).toBe(true);
    await page.setViewportSize({ width, height });
    await expect.poll(async () => (await ports()).every(error => error < 1)).toBe(true);
    const overlaps = await page.locator('.signal-canvas').evaluate(root => {
      const controls = [...root.querySelectorAll('.flow-node, #trigger-menu, .diagram-gain, #flow-balance, #flow-limiter')];
      return controls.flatMap((a, i) => controls.slice(i + 1).filter(b => {
        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
        return Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1;
      }).map(b => `${a.id}/${b.id}`));
    });
    expect(overlaps).toEqual([]);
    const crossings = await page.locator('.signal-canvas').evaluate(root => {
      const origin = root.getBoundingClientRect();
      const nodes = [...root.querySelectorAll('.flow-node, #trigger-menu, .diagram-gain, #flow-balance, #flow-limiter')];
      return [...root.querySelectorAll('.wire-paths path')].flatMap(path => {
        const obstacles = nodes.filter(node => node.id !== `flow-${path.dataset.from}` && node.id !== `flow-${path.dataset.to}`);
        const hit = new Set();
        for (let distance = 1; distance < path.getTotalLength(); distance += 2) {
          const point = path.getPointAtLength(distance), x = point.x + origin.left, y = point.y + origin.top;
          for (const node of obstacles) {
            const rect = node.getBoundingClientRect();
            if (x > rect.left + 1 && x < rect.right - 1 && y > rect.top + 1 && y < rect.bottom - 1) hit.add(node.id);
          }
        }
        return [...hit].map(id => `${path.dataset.from}→${path.dataset.to}/${id}`);
      });
    });
    expect(crossings).toEqual([]);
    const boxes = await page.locator('.bus-group').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right }; }));
    expect(boxes[0].top).toBeLessThan(boxes[1].top); expect(boxes[0].left).toBe(boxes[1].left);
    await expect(page.locator('path[data-from="penv"]')).toHaveCount(2);
    expect((await page.locator('path[data-from="penv"]').evaluateAll(paths => paths.map(path => path.dataset.to).sort())))
      .toEqual(['osc1', 'osc2']);
    await expect(page.locator('#flow-penv-target')).toHaveCount(0);
    const oscillatorStack = await page.locator('#flow-osc1, #flow-penv, #flow-osc2').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect(); return { top: rect.top, left: rect.left };
    }));
    expect(oscillatorStack[0].top).toBeLessThan(oscillatorStack[1].top);
    expect(oscillatorStack[1].top).toBeLessThan(oscillatorStack[2].top);
    expect(oscillatorStack.map(box => Math.round(box.left))).toEqual([Math.round(oscillatorStack[0].left), Math.round(oscillatorStack[0].left), Math.round(oscillatorStack[0].left)]);
    expect(await page.locator('path[data-from="penv"]').evaluateAll(paths => paths.map(path => path.getTotalLength()).every(length => length < 20))).toBe(true);
    await expect(page.locator('path[data-from^="input-"]')).toHaveCount(8);
    const backgrounds = await page.locator('.source-group, .common-space').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
    expect(backgrounds[0]).not.toBe(backgrounds[1]); expect(backgrounds.every(color => color.startsWith('rgba('))).toBe(true);
    if (width >= 1366) expect(await page.locator('#flow-osc1').evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(121);
    await page.locator('#flow-balance').click();
    for (const id of ['crossfade', 'master-gain', 'master-mute']) {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded(); await expect(page.locator(`#${id}`)).toBeInViewport();
    }
    await page.locator('#flow-near-gain').click();
    await page.locator('#near-gain').scrollIntoViewIfNeeded(); await expect(page.locator('#near-gain')).toBeInViewport();
    await page.locator('#effects-far').click();
    await page.locator('#far-gain').scrollIntoViewIfNeeded(); await expect(page.locator('#far-gain')).toBeInViewport();
    await expect.poll(async () => (await ports()).every(error => error < 1)).toBe(true);
    if (width === 768 && height === 768) {
      const scrolled = await page.locator('.signal-map').evaluate(group => {
        group.scrollTop = group.scrollHeight;
        group.scrollLeft = group.scrollWidth;
        return { top: group.scrollTop, maxTop: group.scrollHeight - group.clientHeight, left: group.scrollLeft };
      });
      expect(scrolled.top).toBe(scrolled.maxTop);
      await expect.poll(async () => (await ports()).every(error => error < 1)).toBe(true);
    }
    await page.locator('#flow-filter2').scrollIntoViewIfNeeded();
    await expect(page.locator('path[data-from="filter2"][data-to="mod"]')).toHaveClass('control-wire');
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`voice-${width}x${height}.png`) });
    await page.locator('#flow-master').click();
    await page.locator('#master-mute').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`space-${width}x${height}.png`) });
  });
}

test('Centered Σ ports retain horizontal outer sends and leave room for outgoing arrows', async ({ page }) => {
  for (const width of [1024, 1366]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto('/');
    await expect(page.locator('path[data-from^="input-"]')).toHaveCount(8);
    const geometry = await page.evaluate(() => {
      const buses = ['near', 'far'];
      return buses.map(bus => {
        const paths = [1, 2, 3, 4].map(i => document.querySelector(`path[data-from="input-${i}"][data-to="${bus}-input"]`));
        const starts = paths.map(path => Number(path.getAttribute('d').split(' ')[2]));
        const ends = paths.map(path => Number(path.getAttribute('d').match(/ V ([\d.]+) H /)?.[1] ?? path.getAttribute('d').split(' ')[2]));
        const sum = document.querySelector(`#flow-${bus}-input`).getBoundingClientRect();
        const fx2 = document.querySelector(`#flow-${bus}-fx2`).getBoundingClientRect();
        const group = document.querySelector(`.bus-group[data-space="${bus}"]`).getBoundingClientRect();
        const bends = paths.map(path => path.getAttribute('d').match(/^M [\d.]+ [\d.]+ H ([\d.]+) V/)).filter(Boolean).map(match => Number(match[1]));
        const canvas = document.querySelector('.signal-canvas').getBoundingClientRect();
        return { bus, outerPath: paths[bus === 'near' ? 0 : 3].getAttribute('d'), starts, ends,
          sumCenter: (sum.top + sum.bottom) / 2 - canvas.top, sumWidth: sum.width, outgoingGap: fx2.left - sum.right,
          nearestBend: Math.max(...bends), groupLeft: group.left - canvas.left };
      });
    });
    for (const bus of geometry) {
      expect(bus.outerPath, `${width}px ${bus.bus}`).not.toContain(' V ');
      const outer = bus.bus === 'near' ? 0 : 3;
      expect(bus.ends[outer]).toBeCloseTo(bus.starts[outer], 1);
      expect(bus.sumWidth).toBe(42);
      expect(bus.outgoingGap).toBeGreaterThanOrEqual(16);
      expect(bus.groupLeft - bus.nearestBend).toBeGreaterThanOrEqual(12);
      expect(Math.abs((bus.ends[0] + bus.ends[3]) / 2 - bus.sumCenter)).toBeLessThan(.3);
      for (let i = 1; i < 4; i++) expect(Math.abs(bus.ends[i] - bus.ends[i - 1] - 7.5)).toBeLessThan(.3);
    }
  }
});

test('Fixed reference equals the old -18 dB baseline; Drive changes harmonics and post-FX1 Level scales the complete waveform', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    const { VOICE_FX_INPUT_DB } = await import('/src/audio/constants.ts');
    const render = async drive => {
      const context = new OfflineAudioContext(1, 48000, 48000); const engine = new AudioEngine(context);
      engine.preLimiterOutput.disconnect(); engine.preLimiterOutput.connect(context.destination); engine.setMasterGainDb(0);
      const voice = engine.getChannel('1'); voice.setOsc1Frequency(1000); voice.setBlockEnabled('aenv', false);
      engine.setChannelMix('1', { balance: 0 }); engine.setCrossfade(0);
      if (drive !== null) { await voice.setFx1Type('distortion'); voice.setFx1Enabled(true); voice.setFx1Parameter('distortionDriveDb', drive); voice.setFx1Parameter('distortionWet', 1); }
      engine.gateOn('1');
      const pause = context.suspend(.5), rendering = context.startRendering(); await pause;
      engine.setChannelMix('1', { gainDb: -6 }); await context.resume(); const samples = (await rendering).getChannelData(0);
      const amplitude = hz => { let sin = 0, cos = 0; for (let i = 9600; i < 19200; i++) { sin += samples[i] * Math.sin(2 * Math.PI * hz * i / 48000); cos += samples[i] * Math.cos(2 * Math.PI * hz * i / 48000); } return 2 * Math.hypot(sin, cos) / 9600; };
      let scaleError = 0; for (let i = 9600; i < 19200; i++) scaleError = Math.max(scaleError, Math.abs(samples[i + 24000] - samples[i] * 10 ** (-6 / 20)));
      const value = { fundamental: amplitude(1000), harmonicRatio: amplitude(3000) / amplitude(1000), scaleError }; engine.dispose(); return value;
    };
    return { baseline: await render(null), mild: await render(12), strong: await render(24), reference: VOICE_FX_INPUT_DB };
  });
  expect(result.reference).toBe(-18); expect(result.baseline.fundamental).toBeCloseTo(10 ** (-18 / 20) / Math.SQRT2, 5);
  expect(result.strong.harmonicRatio).toBeGreaterThan(result.mild.harmonicRatio * 3);
  for (const value of [result.baseline, result.mild, result.strong]) expect(value.scaleError).toBeLessThan(.0001);
});
