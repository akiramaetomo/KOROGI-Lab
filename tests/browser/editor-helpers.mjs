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
