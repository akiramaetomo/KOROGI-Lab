import { test, expect } from '@playwright/test';
import { openTimbreEditors } from './editor-helpers.mjs';

for (const viewport of [{ width: 1024, height: 768 }, { width: 1194, height: 834 }, { width: 1366, height: 1024 },
  { width: 360, height: 800 }, { width: 844, height: 390 }]) {
  test(`PEnv prioritized width and static guide at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#play-1')).toBeEnabled();
    await openTimbreEditors(page, ['mod', 'penv']);
    const panel = page.locator('[data-editor-card="penv"]');
    const guide = panel.locator('details');
    await expect(guide).not.toHaveAttribute('open', '');
    const geometry = await panel.evaluate(panel => {
      const layout = panel.closest('.function-editor-row');
      const cards = [...layout.querySelectorAll('.editor-card.active')].map(node => node.getBoundingClientRect());
      const scroll = panel.querySelector('.penv-controls-scroll');
      return { layout: layout.getBoundingClientRect().width, widths: cards.map(r => r.width),
        scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth,
        columns: getComputedStyle(panel.querySelector('.penv-points')).gridTemplateColumns,
        timeColumns: getComputedStyle(panel.querySelector('.penv-times')).gridTemplateColumns,
        scale: panel.querySelector('[data-numeric-control="penv-scale"]').getBoundingClientRect(),
        modes: panel.querySelector('.penv-mode-switches').getBoundingClientRect(),
        pageWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.pageWidth).toBe(viewport.width);
    expect(geometry.widths[0]).toBeLessThanOrEqual(450);
    expect(geometry.widths[1]).toBeCloseTo(602.67, 0);
    expect(geometry.widths[0] + geometry.widths[1] + 8).toBeLessThanOrEqual(geometry.layout + 1);
    expect(geometry.widths[1]).toBeGreaterThan(geometry.widths[0]);
    expect(geometry.columns.split(' ')).toHaveLength(4);
    if (viewport.width >= 1024) expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.timeColumns.split(' ')).toHaveLength(3);
    expect(geometry.scale.x).toBeGreaterThanOrEqual(geometry.modes.right);
    expect(geometry.scale.y).toBeCloseTo(geometry.modes.y, 0);
    const scaleRows = await panel.locator('[data-numeric-control="penv-scale"]').evaluate(node => {
      const rect = selector => node.querySelector(selector).getBoundingClientRect();
      return { label: rect('.numeric-heading'), slider: rect('.numeric-slider-axes') };
    });
    expect(scaleRows.slider.y).toBeGreaterThanOrEqual(scaleRows.label.bottom);
    expect(scaleRows.slider.width).toBeGreaterThan(100);
    await expect(page.locator('#penv-scale')).toBeHidden();
    await expect(panel.locator('[data-numeric-control="penv-scale"] .numeric-value-readout')).toHaveText('1');
    if ([1024, 1366].includes(viewport.width)) await page.screenshot({ path: testInfo.outputPath('penv-collapsed.png') });
    await guide.locator('summary').click();
    await expect(guide).toHaveAttribute('open', '');
    await expect(guide.locator('svg')).toHaveCount(2);
    await expect(guide.locator('.parallel-mark')).toHaveCount(2);
    await expect(guide.locator('svg').first().locator('.parallel-mark')).toHaveCount(0);
    await expect(guide.locator('svg').last().locator('.parallel-mark')).toHaveCount(2);
    const slopes = await guide.locator('.envelope-line').evaluateAll(nodes => nodes.map(node => {
      const numbers = node.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
      if (node.classList.contains('rate')) return (numbers[3] - numbers[1]) / (numbers[2] - numbers[0]);
      return (numbers[8] - numbers[5]) / (numbers[7] - numbers[6]);
    }));
    expect(slopes[0]).toBeCloseTo(slopes[1], 10);
    await expect(guide.locator('summary')).toHaveText('PEnv Shape Guide');
    await expect(guide).not.toContainText('not linked to settings');
    await expect(panel).not.toContainText('Time and Rate match');
    await expect(guide.locator('figure').last().locator('.penv-release-note')).toContainText('Rate: same slope as Ps→Pr');
    const note = await guide.locator('.penv-release-note').boundingBox();
    await expect(guide).not.toContainText('ms');
    const diagramRects = await guide.locator('svg').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()));
    expect(diagramRects[1].x).toBeGreaterThan(diagramRects[0].right);
    expect(diagramRects[1].y).toBeCloseTo(diagramRects[0].y, 0);
    expect(note.y + note.height).toBeLessThanOrEqual(diagramRects[1].y + 1);
    expect(await guide.locator('.penv-release-note').evaluate(node => getComputedStyle(node).textAlign)).toBe('right');
    const diagrams = await guide.locator('svg').evaluateAll(nodes => nodes.map(node => node.innerHTML));
    await page.locator('#penv-attack-level').fill('12');
    await page.locator('#penv-attack-level').dispatchEvent('change');
    expect(await guide.locator('svg').evaluateAll(nodes => nodes.map(node => node.innerHTML))).toEqual(diagrams);
    await page.locator('#penv-scale-coarse').scrollIntoViewIfNeeded();
    await expect(page.locator('#penv-scale-coarse')).toBeVisible();
    await guide.locator('figure').last().scrollIntoViewIfNeeded();
    if ([1024, 1366].includes(viewport.width)) await page.screenshot({ path: testInfo.outputPath('penv-expanded.png') });
    expect(await page.locator('.function-editor').evaluate(node => getComputedStyle(node).overflowY)).toBe('auto');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await guide.locator('summary').click();
    await expect(guide).not.toHaveAttribute('open', '');
  });
}
