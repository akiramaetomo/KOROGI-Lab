import { test, expect } from '@playwright/test';

async function start(page, width = 1024, height = 768) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('#play-1')).toBeEnabled();
}

async function chooseDemo(page, name) {
  await page.locator('#demo-menu-button').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  await expect(page.locator('#patch-status')).toHaveText(`Loaded demo: ${name}`);
  await expect(page.locator('#patch-name')).toHaveValue(name);
  await expect(page.locator('#demo-menu')).toBeHidden();
}

test('Demo menu loads the three bundled Sessions without starting playback', async ({ page }) => {
  await start(page);
  await page.locator('#play-1').click();
  await expect(page.locator('#play-1')).toHaveAttribute('aria-pressed', 'true');

  for (const name of ['Akino-mushi', 'Filter-Acid1', 'Filter-Acid2']) {
    await chooseDemo(page, name);
    const playbackStates = await page.locator('[id^="play-"]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-pressed')));
    expect(playbackStates.every(state => state === 'false')).toBe(true);
  }
});

test('Demo menu supports keyboard and outside-pointer dismissal', async ({ page }) => {
  await start(page);
  const toggle = page.locator('#demo-menu-button');
  await toggle.focus();
  await toggle.press('ArrowDown');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'Akino-mushi' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Filter-Acid1' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#demo-menu')).toBeHidden();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await page.mouse.click(1000, 740);
  await expect(page.locator('#demo-menu')).toBeHidden();
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 768 }]) {
  test(`Demo control fits beside the title at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await start(page, viewport.width, viewport.height);
    await expect(page.locator('.brand > span')).toHaveText('8 Timbres · Near / Far');
    const layout = await page.locator('.topbar').evaluate((header) => {
      const title = header.querySelector('.brand strong').getBoundingClientRect();
      const demo = header.querySelector('#demo-menu-button').getBoundingClientRect();
      const rect = header.getBoundingClientRect();
      return { title: title.toJSON(), demo: demo.toJSON(), header: rect.toJSON(), clientWidth: header.clientWidth, scrollWidth: header.scrollWidth };
    });
    expect(Math.abs(layout.title.top - layout.demo.top)).toBeLessThan(8);
    expect(layout.demo.left).toBeGreaterThanOrEqual(layout.title.right);
    expect(layout.demo.right).toBeLessThanOrEqual(layout.header.right);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  });
}
