import { test, expect } from '@playwright/test';

test('Clear and Init sit away from Mute and ask before discarding a timbre', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  if (!(await page.locator('#clear-1').isVisible())) await page.locator('#select-1').click();
  // Under Mute sits Save; the discarding buttons are at the far side of the row.
  const mute = await page.locator('#mute-1').boundingBox(), clear = await page.locator('#clear-1').boundingBox();
  const save = await page.locator('#save-1').boundingBox();
  expect(clear.x + clear.width).toBeLessThan(mute.x);
  expect(save.x + save.width).toBeGreaterThan(mute.x);

  const messages = [];
  page.once('dialog', dialog => { messages.push(dialog.message()); void dialog.dismiss(); });
  await page.locator('#clear-1').click();
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toContain('Clear Timbre 1 (Standard)?');
  await expect(page.locator('#select-1 .slot-name')).toHaveText('Standard');

  page.once('dialog', dialog => { messages.push(dialog.message()); void dialog.dismiss(); });
  await page.locator('#standard-1').click();
  await expect.poll(() => messages.length).toBe(2);
  expect(messages[1]).toContain('Initialize Timbre 1');

  page.once('dialog', dialog => void dialog.accept());
  await page.locator('#clear-1').click();
  await expect(page.locator('#select-1 .slot-name')).toHaveText('Empty');
  // An empty slot has nothing to lose: Init creates a timbre without asking.
  let asked = false; page.once('dialog', dialog => { asked = true; void dialog.dismiss(); });
  await page.locator('#standard-1').click();
  await expect(page.locator('#select-1 .slot-name')).toHaveText('Standard');
  expect(asked).toBe(false);
});
