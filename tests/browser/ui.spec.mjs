import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function exportPatch(page) {
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-patch').click();
  const file = await downloaded;
  return JSON.parse(await readFile(await file.path(), 'utf8'));
}

async function importPatch(page, patch) {
  await page.locator('#patch-file').setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded:');
}

async function edit(page, selector, value) {
  await page.locator(selector).fill(String(value));
  await page.locator(selector).dispatchEvent('change');
}

test('Earlier formats and malformed session are rejected without changing settings or Auto', async ({ page }) => {
  await page.goto('/');
  await page.locator('.signal-map [data-block-toggle="osc1"]').click();
  await page.locator('#play-all').click();
  await page.locator('[data-panel-target="patch"]').first().click();
  const original = await exportPatch(page);
  const invalid = structuredClone(original);
  delete invalid.channels[0].timbre.settings.fx1;
  const patches = [
    ...['KOROGI-Lab/0.1-harness-1ch', 'KOROGI-Lab/0.1-harness-1ch-v2', 'KOROGI-Lab/0.1-harness-1ch-v3'].map((formatVersion) => ({ ...original, formatVersion })),
    invalid
  ];
  for (const patch of patches) {
    await page.locator('#patch-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(patch)) });
    await expect(page.locator('#patch-status')).toContainText('Import failed:');
    const restored = await exportPatch(page);
    delete restored.savedAt;
    const expected = structuredClone(original); delete expected.savedAt;
    expect(restored).toEqual(expected);
    await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');
    // Default Auto repeats every 500 ms; long polling intervals can alias its ON phase.
    await expect.poll(async () => page.locator('#gate-lamp').getAttribute('class'), { timeout: 2000, intervals: [50] }).toContain('on');
  }
  await page.locator('#play-all').click();
});

for (const width of [1440, 1024, 768]) {
  test(`Diagram and separate voice/common FX editors fit and operate at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/');
    const grouping = await page.locator('.signal-map').evaluate((map) => {
      const source = map.querySelector('.source-group'), bus = map.querySelector('.bus-group');
      const sourceRect = source.getBoundingClientRect(), busRect = bus.getBoundingClientRect();
      const blocks = ['osc1', 'osc2', 'mod', 'filter1', 'filter2', 'penv', 'aenv', 'fx1'];
      return {
        insideSource: blocks.every((block) => [...map.querySelectorAll(`[data-flow-block="${block}"]`)].every((node) => {
          const rect = node.getBoundingClientRect();
          return source.contains(node) && rect.top >= sourceRect.top && rect.bottom <= sourceRect.bottom;
        })),
        sourceAboveSpace: sourceRect.bottom < busRect.top,
        onlySpaceBlocks: ['fx2', 'fx3'].every((block) => bus.querySelector(`[data-flow-block="${block}"]`))
      };
    });
    expect(grouping).toEqual({ insideSource: true, sourceAboveSpace: true, onlySpaceBlocks: true });
    await page.locator('.signal-map [data-block-toggle="osc1"]').click();
    await page.locator('#flow-fx1').click({ position: { x: 8, y: 15 } });
    await expect(page.locator('[data-effect-slot]')).toHaveCount(3);
    await page.locator('#fx1-type').selectOption('distortion');
    await page.locator('#flow-near-fx2').click();
    await page.locator('#fx2-type').selectOption('delay');
    await expect(page.locator('#fx2-delay-time')).toBeEnabled();
    await page.locator('#fx3-type').selectOption('reverb');
    await expect(page.locator('#fx3-reverb-decay')).toBeEnabled();
    await edit(page, '#fx2-delay-time', 123);
    await edit(page, '#fx3-reverb-decay', 2.4);
    await page.locator('#flow-fx1').click({ position: { x: 8, y: 15 } });
    await page.locator('#fx1-dist-drive').focus();
    await page.locator('#fx1-dist-drive').evaluate((input) => input.setSelectionRange(0, 0));
    await page.locator('#fx1-dist-drive').press('ArrowUp');
    await expect(page.locator('#fx1-dist-drive')).toHaveValue('22');
    await page.locator('#flow-near-fx2').click();
    const outside = await page.locator('.effects-panel.active select, .effects-panel.active .flow-toggle').evaluateAll((controls) => controls.filter((control) => {
      if (control.getClientRects().length === 0) return false;
      const rect = control.getBoundingClientRect(); return rect.left < 0 || rect.right > window.innerWidth || rect.width < 1;
    }).map((control) => control.id || control.textContent));
    expect(outside).toEqual([]);
    const cards = await page.locator('.space-effects-grid > fieldset').evaluateAll((cards) => cards.map((card) => {
      const rect = card.getBoundingClientRect(); return { top: rect.top, left: rect.left, right: rect.right, overflow: card.scrollWidth > card.clientWidth };
    }));
    expect(cards.every(card => !card.overflow)).toBe(true);
    if (width >= 1024) { expect(cards.every(card => card.top === cards[0].top)).toBe(true); expect(cards[0].right).toBeLessThanOrEqual(cards[1].left); }
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`viewport-${width}.png`) });
  });
}
