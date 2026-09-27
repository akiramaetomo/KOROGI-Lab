import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openTimbreEditors, openCommonEditors } from './editor-helpers.mjs';

async function start(page) {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
}
async function setColors(page, values) {
  await page.evaluate(values => {
    for (const [name, value] of Object.entries(values)) document.documentElement.style.setProperty(name, value);
  }, values);
}

test('GUI palette is the sole source of explicit colors and every reference is defined', async () => {
  const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
  const palette = await read('src/ui/colors.css');
  const sources = await Promise.all(['src/ui/harness.css', 'index.html', 'src/ui/PitchEnvelopeGuide.ts'].map(read));
  const definitions = [...palette.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2]]);
  expect(new Set(definitions.map(([name]) => name)).size).toBe(definitions.length);
  for (const source of sources) {
    expect(source).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const match of source.matchAll(/var\((--color-[\w-]+)\)/g))
      expect(definitions.some(([name]) => name === match[1]), match[1]).toBe(true);
  }
});

test('shared card palette changes Timbre and COMMON SPACE including hover and grip', async ({ page }) => {
  await start(page);
  await setColors(page, {
    '--color-card-background': '#283747', '--color-card-heading-background': '#394a5b',
    '--color-card-heading-hover-background': '#43576b', '--color-card-content-background': '#203040',
    '--color-card-border': '#8090a0', '--color-grip-dot': '#abcdef',
  });
  for (const common of [false, true]) {
    if (common) await openCommonEditors(page, ['near']); else await openTimbreEditors(page, ['osc1']);
    const card = page.locator(common ? '.space-card.active' : '.editor-card.active');
    await page.mouse.move(0, 0);
    await expect(card).toHaveCSS('background-color', 'rgb(40, 55, 71)');
    await expect(card).toHaveCSS('border-top-color', 'rgb(128, 144, 160)');
    await expect(card.locator('.editor-card-handle')).toHaveCSS('background-color', 'rgb(57, 74, 91)');
    await expect(card.locator('fieldset').first()).toHaveCSS('background-color', 'rgb(32, 48, 64)');
    expect(await card.locator('.editor-card-handle').evaluate(node => getComputedStyle(node, '::before').backgroundImage)).toContain('rgb(171, 205, 239)');
    await card.locator('.editor-card-handle').hover();
    await expect(card.locator('.editor-card-handle')).toHaveCSS('background-color', 'rgb(67, 87, 107)');
  }
});

test('state, signal wire, arrow and SVG guide colors respond to independent variables', async ({ page }) => {
  await start(page); await openTimbreEditors(page, ['aenv']);
  await setColors(page, {
    '--color-segmented-choice-checked-background': '#567856',
    '--color-signal-wires-audio-wire-stroke': '#77aabb', '--color-wire-arrow-fill': '#88bbcc',
    '--color-penv-time-marker-fill': '#aabb66', '--color-penv-rate-marker-fill': '#66bbaa',
    '--color-penv-parallel-mark-background': '#223344',
  });
  await expect(page.locator('.editor-card.active .segmented-choice button[aria-checked="true"]').first()).toHaveCSS('background-color', 'rgb(86, 120, 86)');
  await expect(page.locator('.signal-wires path.audio-wire:not(.send-active)').first()).toHaveCSS('stroke', 'rgb(119, 170, 187)');
  await expect(page.locator('.wire-arrow-head')).toHaveCSS('fill', 'rgb(136, 187, 204)');
  await openTimbreEditors(page, ['penv']); await page.locator('.penv-shape-guide summary').click();
  await expect(page.locator('.time-marker').first()).toHaveCSS('fill', 'rgb(170, 187, 102)');
  await expect(page.locator('.rate-marker').first()).toHaveCSS('fill', 'rgb(102, 187, 170)');
  await expect(page.locator('.parallel-mark-background').first()).toHaveCSS('fill', 'rgb(34, 51, 68)');
});
