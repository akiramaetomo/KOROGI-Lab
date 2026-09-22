import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const root = process.cwd();
const htmlPath = join(root, 'dist', 'index.html');
const html = await readFile(htmlPath, 'utf8');

if (/\/(?:src)\//.test(html)) {
  throw new Error('Pages artifact still references source files.');
}

const assetUrls = [...html.matchAll(/(?:src|href)="(\/KOROGI-Lab\/assets\/[^"]+)"/g)].map(match => match[1]);
if (assetUrls.length === 0) {
  throw new Error('Pages artifact has no /KOROGI-Lab/assets/ references.');
}
for (const assetUrl of assetUrls) {
  const relativePath = assetUrl.slice('/KOROGI-Lab/'.length);
  const asset = await stat(join(root, 'dist', relativePath));
  if (!asset.isFile()) {
    throw new Error(`Pages asset is not a file: ${assetUrl}`);
  }
}

const server = await preview({
  root,
  base: '/KOROGI-Lab/',
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
});

let browser;
try {
  browser = await chromium.launch({ channel: process.env.KOROGI_BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const response = await page.goto('http://127.0.0.1:4174/KOROGI-Lab/');
  if (!response?.ok()) {
    throw new Error(`Pages preview returned HTTP ${response?.status() ?? 'no response'}.`);
  }
  await page.locator('#play-1').waitFor({ state: 'visible' });
  if (!(await page.locator('#play-1').isEnabled())) {
    throw new Error('Pages preview did not enable the first Timbre controls.');
  }
  if ((await page.locator('.brand > span').textContent())?.trim() !== '8 Timbres · Near / Far') {
    throw new Error('Pages preview has a stale Timbre count.');
  }
  await page.locator('#demo-menu-button').click();
  if (!(await page.getByRole('menuitem', { name: 'Akino-mushi', exact: true }).isVisible())) {
    throw new Error('Pages preview did not open the Demo menu.');
  }
  console.log(`Pages artifact smoke passed with ${assetUrls.length} hashed asset references.`);
} finally {
  await browser?.close();
  await server.close();
}
