// Audit 2026-10-19 (base da0d25d): sliders.spec.mjs:128 fails 7/20 alone, always at its line 152. On failure
// #osc1-frequency is 440 with data-last-valid 550: the 4400 edit right after the last page.goto('/') is lost,
// so the Fine slide starts from the default 440. The test, unlike the others in that file, never waits for the app
// to be ready after page.goto. `control` repeats the original steps; `ready` adds only the readiness wait the other
// tests use (#play-1 enabled) after each goto. Expected: control fails intermittently, ready passes every time.
import { test, expect } from '@playwright/test';
// Audit probes run only on request: KOROGI_AUDIT=1, so lab.ps1 check keeps its own baseline.
test.skip(!process.env.KOROGI_AUDIT, 'Audit probe: set KOROGI_AUDIT=1 to run.');

async function edit(page, id, value) {
  await page.locator(`#${id}`).fill(String(value));
  await page.locator(`#${id}`).dispatchEvent('change');
}
async function slide(page, id, value) {
  await page.locator(`#${id}`).evaluate((range, value) => {
    range.value = String(value);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function value(page, id) {
  return Number(await page.locator(`#${id}`).inputValue());
}

async function run(page, waitReady, testInfo) {
  const log = [];
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) log.push(`nav ${frame.url()}`); });
  page.on('console', message => { if (/vite|reload/i.test(message.text())) log.push(`console ${message.text()}`); });
  const open = async () => {
    await page.goto('/');
    if (waitReady) await expect(page.locator('#play-1')).toBeEnabled();
  };
  for (const [percent, expected1, expected2] of [[10, 1100, 110], [30, 1300, 130], [50, 1500, 150]]) {
    const pattern = '**/src/config/parameterRanges.ts*';
    const handler = async route => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: `${body}\nPARAMETER_RANGES["osc1-frequency"].fine = "ratio-${percent}-percent"; PARAMETER_RANGES["osc2-frequency"].fine = "ratio-${percent}-percent";` });
    };
    await page.route(pattern, handler);
    await open();
    await edit(page, 'osc1-frequency', 1000);
    await edit(page, 'osc2-frequency', 100);
    await slide(page, 'osc1-frequency-fine', 10000);
    await slide(page, 'osc2-frequency-fine', 10000);
    expect(await value(page, 'osc1-frequency')).toBe(expected1);
    expect(await value(page, 'osc2-frequency')).toBe(expected2);
    await page.unroute(pattern, handler);
  }
  await open();
  log.push('--- last goto done');
  log.push(`before edit: ${await page.evaluate(() => {
    const input = document.querySelector('#osc1-frequency'), play = document.querySelector('#play-1');
    return JSON.stringify({ disabled: input.disabled, type: input.type, value: input.value, play1: play ? !play.disabled : 'missing',
      ready: document.readyState });
  })}`);
  await page.locator('#osc1-frequency').evaluate(input => {
    input.addEventListener('change', () => { input.dataset.auditChange = `${input.value}@${performance.now().toFixed(0)}`; }, { once: true });
  }).catch(() => {});
  await edit(page, 'osc1-frequency', 4400);
  log.push(`change seen: ${await page.locator('#osc1-frequency').getAttribute('data-audit-change')}; play1 now ${await page.locator('#play-1').isEnabled().catch(() => 'missing')}`);
  log.push(`after edit: ${await page.locator('#osc1-frequency').inputValue()}`);
  await slide(page, 'osc1-frequency-fine', 7500);
  log.push(`after slide: ${await page.locator('#osc1-frequency').inputValue()}`);
  await testInfo.attach('events', { body: log.join('\n'), contentType: 'text/plain' });
  await expect(page.locator('#osc1-frequency')).toHaveValue('5500');
}

test('control: original steps without a readiness wait', async ({ page }, testInfo) => { await run(page, false, testInfo); });
test('ready: the same steps with a readiness wait after each goto', async ({ page }, testInfo) => { await run(page, true, testInfo); });
