import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function saveTimbre(page) {
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  return JSON.parse(await readFile(await (await download).path(), 'utf8'));
}

async function dragEditHandle(page, edge, ratio) {
  const handle = page.locator(`#gate-edit-${edge}-handle`);
  await handle.scrollIntoViewIfNeeded();
  const track = await page.locator('#gate-edit-timeline').boundingBox();
  const target = await handle.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * ratio, track.y + track.height / 2, { steps: 4 });
  await page.mouse.up();
}

test('Gate quantize uses an independent edit range and only the last operation can be undone', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    gates: [{ onSec: .18, offSec: .3 }, { onSec: .81, offSec: .92 }, { onSec: 1.6, offSec: 1.72 }] };
  await page.locator('#timbre-file-1').setInputFiles({ name: 'gate.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  await page.locator('#trigger-menu').click();
  await page.locator('.gate-quantize-details > summary').click();
  await expect(page.locator('#gate-quantize')).toBeDisabled();
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  await expect(page.locator('#gate-quantize')).toBeEnabled();
  await page.locator('#gate-quantize-grid').selectOption('32');
  await page.locator('#gate-quantize').click();
  const fine = (await saveTimbre(page)).gatePatterns[0].recording;
  expect(fine.gates[0].onSec).toBe(.1875);

  await dragEditHandle(page, 'start', .35);
  await dragEditHandle(page, 'end', .6);
  await expect(page.locator('#record-start-value')).toHaveText('0.00 s');
  expect(Number(await page.locator('#gate-edit-start-handle').getAttribute('aria-valuenow'))).toBeCloseTo(.7, 1);
  await page.locator('#gate-quantize-grid').selectOption('4');
  await page.locator('#gate-quantize').click();
  const coarse = (await saveTimbre(page)).gatePatterns[0].recording;
  expect(coarse.gates[0]).toEqual(fine.gates[0]);
  expect(coarse.gates[1].onSec).toBe(1);
  expect(coarse.gates[2]).toEqual(fine.gates[2]);
  await expect(page.locator('#gate-quantize-undo')).toBeEnabled();
  await page.locator('#gate-quantize-undo').click();
  expect((await saveTimbre(page)).gatePatterns[0].recording).toEqual(fine);
  await page.locator('#gate-quantize-redo').click();
  expect((await saveTimbre(page)).gatePatterns[0].recording).toEqual(coarse);
  await page.locator('.song-timing-field [role="radio"][data-value="original"]').click();
  await expect(page.locator('#gate-quantize')).toBeDisabled();
  await expect(page.locator('#gate-quantize-undo')).toBeDisabled();
  await page.locator('#timbre-file-1').setInputFiles({ name: 'quantized.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(await saveTimbre(page))) });
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  await expect(page.locator('#gate-quantize-undo')).toBeDisabled();
  expect((await saveTimbre(page)).gatePatterns[0].recording).toEqual(coarse);
});

test('recorded OFF reaches the engine before the next quantized ON', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.sequence.gateMode = 'user';
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
    gates: [{ onSec: .01, offSec: .495 }, { onSec: .51, offSec: .65 }] };
  await page.locator('#timbre-file-1').setInputFiles({ name: 'gap.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  await page.locator('#trigger-menu').click();
  await page.locator('.gate-quantize-details > summary').click();
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  await page.locator('#gate-quantize-grid').selectOption('4');
  await dragEditHandle(page, 'start', .25);
  await dragEditHandle(page, 'end', .3);
  await page.locator('#gate-quantize').click();
  const gates = (await saveTimbre(page)).gatePatterns[0].recording.gates;
  expect(gates[1].onSec - gates[0].offSec).toBeCloseTo(.01, 9);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('/src/audio/core/AudioEngine.ts');
    window.quantizeCalls = [];
    const on = AudioEngine.prototype.gateOn, off = AudioEngine.prototype.gateOff;
    AudioEngine.prototype.gateOn = function (id, time) { if (id === '1') window.quantizeCalls.push({ kind: 'on', time }); return on.call(this, id, time); };
    AudioEngine.prototype.gateOff = function (id, time) { if (id === '1') window.quantizeCalls.push({ kind: 'off', time }); return off.call(this, id, time); };
  });
  await page.locator('#sequence-panel').click();
  await expect.poll(() => page.evaluate(() => window.quantizeCalls.length), { timeout: 4000 }).toBeGreaterThanOrEqual(4);
  const calls = await page.evaluate(() => window.quantizeCalls);
  expect(calls.slice(0, 4).map(call => call.kind)).toEqual(['on', 'off', 'on', 'off']);
  expect(calls[2].time - calls[1].time).toBeGreaterThanOrEqual(.009);
  await page.locator('#sequence-panel').click();
});

test('dedicated range handles accept touch and keyboard without moving the playback selection', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
  const timbre = await saveTimbre(page);
  timbre.gatePatterns[0].recording = { durationSec: 2, selectionStartSec: .2, selectionEndSec: 1.8,
    gates: [{ onSec: .5, offSec: .8 }] };
  await page.locator('#timbre-file-1').setInputFiles({ name: 'touch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(timbre)) });
  await expect(page.locator('#patch-status')).toContainText('Loaded timbre 1:');
  await page.locator('#trigger-menu').click();
  await page.locator('.gate-quantize-details > summary').click();
  await page.locator('.song-timing-field [role="radio"][data-value="bars"]').click();
  const handle = page.locator('#gate-edit-start-handle');
  await handle.scrollIntoViewIfNeeded();
  const origin = await handle.boundingBox(); const track = await page.locator('#gate-edit-timeline').boundingBox();
  const y = origin.y + origin.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: origin.x + origin.width / 2, y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: track.x + track.width * .4, y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBeCloseTo(.8, 1);
  await handle.focus(); await page.keyboard.press('ArrowRight');
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBeCloseTo(.81, 1);
  await expect(page.locator('#record-start-value')).toHaveText('0.20 s');
  await expect(page.locator('#record-end-value')).toHaveText('1.80 s');
});

test('Gate quantize controls stay reachable at iPad and mobile sizes', async ({ page }) => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/'); await expect(page.locator('#play-1')).toBeEnabled();
    await page.locator('#trigger-menu').click();
    // Quantize is folded by default so the Gate timeline sits right under its Clear button.
    await expect(page.locator('.gate-quantize-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('#gate-quantize')).toBeHidden();
    await page.locator('.gate-quantize-details > summary').click();
    await page.locator('#gate-quantize').scrollIntoViewIfNeeded();
    const button = await page.locator('#gate-quantize').boundingBox();
    const track = await page.locator('#gate-edit-timeline').boundingBox();
    expect(button.width).toBeGreaterThan(50);
    expect(track.width).toBeGreaterThan(150);
    expect(button.x).toBeGreaterThanOrEqual(0);
    expect(button.x + button.width).toBeLessThanOrEqual(viewport.width + 1);
  }
});
