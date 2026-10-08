import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('loading a current timbre into a slot does not report the legacy PEnv notice', async ({ page }) => {
  await page.goto('/');
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.formatVersion).toBe('KOROGI-Lab/timbre-v17');
  await page.locator('#timbre-file-2').setInputFiles({ name: 'current.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toHaveText(`Loaded timbre 2: ${timbre.name}`);
});
