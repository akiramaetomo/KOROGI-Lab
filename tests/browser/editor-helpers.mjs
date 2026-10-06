import { expect } from '@playwright/test';

/** Explicit test setup replaces the former implicit fixed-page pairing. */
export async function openTimbreEditors(page, ids) {
  if (await page.locator('.function-editor').isHidden())
    await page.locator(ids[0] === 'sequence' ? '#trigger-menu' : `#flow-${ids[0]}`).click(ids[0] === 'fx1' ? { position: { x: 8, y: 15 } } : undefined);
  while (await page.locator('.editor-card.active').count())
    await page.locator('.editor-card.active .editor-card-close').first().click();
  for (const id of ids) await page.locator(id === 'sequence' ? '#trigger-menu' : `#flow-${id}`).click(id === 'fx1' ? { position: { x: 8, y: 15 } } : undefined);
}

export async function openCommonEditors(page, ids) {
  if (!await page.locator('.common-editor').isVisible()) await page.locator('#flow-near-fx2').click();
  while (await page.locator('.space-card.active').count()) await page.locator('.space-card.active .editor-card-close').first().click();
  const nodes = { near: 'flow-near-fx2', far: 'flow-far-fx2', 'near-gain': 'flow-near-gain', 'far-gain': 'flow-far-gain', balance: 'flow-balance', master: 'flow-master' };
  for (const id of ids) await page.locator(`#${nodes[id]}`).click();
}

/** Geometry of compact numeric controls: caption + value / low · name · high / slider. */
export const compactNumericRows = root => root.evaluateAll(cards => cards.flatMap(card => [...card.querySelectorAll('.numeric-control')]
  .filter(node => node.getClientRects().length).map(node => {
    const box = element => element.getBoundingClientRect();
    const heading = box(node.querySelector('.numeric-heading')), value = box(node.querySelector(':scope > input'));
    return {
      id: node.dataset.numericControl, width: box(node).width, valueBesideCaption: value.top < heading.bottom - 1,
      axes: [...node.querySelectorAll('.numeric-slider-axis')].map(axis => {
        const [low, center, high] = axis.querySelectorAll('.slider-scale span');
        const name = axis.querySelector('.numeric-slider-name'), range = box(axis.querySelector('input[type="range"]'));
        const mark = getComputedStyle(axis, '::after');
        return {
          sameRow: Math.abs(box(low).bottom - box(high).bottom) < 1 && (!name.textContent || Math.abs(box(name).bottom - box(low).bottom) < 2),
          sliderBelow: range.top >= Math.max(box(low).bottom, box(high).bottom) - 1,
          centerText: center.textContent, centerHidden: !center.getClientRects().length,
          mark: mark.content !== 'none' && mark.width === '1px',
          // The mark has no box; it is centered in the same grid area that the range spans.
          markCentered: mark.content === 'none' || (mark.justifySelf === 'center'
            && Math.abs(box(axis).left + box(axis).width / 2 - (range.left + range.width / 2)) <= 1)
        };
      })
    };
  })));

/** Narrow controls (<160px) keep the value below the caption; all axes use the compact rows. */
export function expectCompactNumericRows(controls, label) {
  for (const control of controls) {
    expect(control.valueBesideCaption, `${label} ${control.id}`).toBe(control.width >= 160);
    for (const axis of control.axes) {
      expect(axis.sameRow && axis.sliderBelow && axis.centerHidden, `${label} ${control.id}`).toBe(true);
      expect(axis.mark, `${label} ${control.id} mark`).toBe(axis.centerText !== '');
      expect(axis.markCentered, `${label} ${control.id} mark position`).toBe(true);
    }
  }
}
