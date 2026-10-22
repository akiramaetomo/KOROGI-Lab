import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openTimbreEditors } from './editor-helpers.mjs';

// LFSR Noise: a shared ZOH table read by one looping source, re-seeked at every Gate On.

test('LFSR source plays the shared ZOH table verbatim and switches read position sample-exactly at a Gate', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { SourceUnit } = await import('/src/audio/dsp/SourceUnit.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const rate = 48000, seek = 24000;
    const context = new OfflineAudioContext(1, rate, rate);
    const factory = new WhiteNoiseFactory(context);
    const shape = context.createConstantSource(); shape.start();
    const unit = new SourceUnit(context, factory, shape, 'lfsr-noise', 440, [], .5, undefined, { clockHz: 4800, bits: 4 });
    unit.output.connect(context.destination);
    const first = Math.round(unit.lfsrOffsetSec * rate);
    unit.reseekNoiseAt(seek / rate);
    const second = Math.round(unit.lfsrOffsetSec * rate);
    const table = factory.lfsrBank.acquire({ clockHz: 4800, bits: 4 }).buffer.getChannelData(0);
    const out = (await context.startRendering()).getChannelData(0);
    let mismatches = 0;
    for (let i = 0; i < out.length; i += 1) {
      const expected = i < seek ? table[(first + i) % table.length] : table[(second + i - seek) % table.length];
      if (out[i] !== expected) mismatches += 1;
    }
    const levels = new Set(out).size;
    return { mismatches, levels, differentOffsets: first !== second, generated: factory.lfsrBank.generatedCount };
  });
  expect(result).toEqual({ mismatches: 0, levels: 16, differentOffsets: true, generated: 1 });
});

test('a held Gate longer than the 10 s table loops without a gap', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { SourceUnit } = await import('/src/audio/dsp/SourceUnit.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const rate = 8000;
    const context = new OfflineAudioContext(1, rate * 12, rate);
    const shape = context.createConstantSource(); shape.start();
    const unit = new SourceUnit(context, new WhiteNoiseFactory(context), shape, 'lfsr-noise', 440, [], .5, undefined, { clockHz: 8000, bits: 1 });
    unit.output.connect(context.destination);
    const out = (await context.startRendering()).getChannelData(0);
    return { zeros: out.filter(value => value === 0).length, extreme: out.every(value => Math.abs(value) === 1) };
  });
  expect(result).toEqual({ zeros: 0, extreme: true });
});

test('repeated and overlapping Gates pick new offsets, never regenerate, cancel cleanly and release their sources', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new AudioContext();
    await context.resume();
    const factory = new WhiteNoiseFactory(context);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.sourceType = 'lfsr-noise'; settings.osc2.sourceType = 'lfsr-noise';
    settings.osc1.lfsr = { clockHz: 12000, bits: 8 }; settings.osc2.lfsr = { clockHz: 12000, bits: 8 };
    const errors = [];
    const synths = [new ChannelSynth(context, factory, settings, 0, 'a'), new ChannelSynth(context, factory, settings, 0, 'b')];
    const offsets = new Set();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      // Rapid real-time Triggers; Gates that fall on one render time are one Gate.
      for (let i = 0; i < 40; i += 1) {
        for (const synth of synths) synth.trigger(.02);
        await wait(5);
      }
      // Distinct Gate times, 4 ms apart: every one takes its own random read position.
      const base = context.currentTime + .05;
      for (let i = 0; i < 40; i += 1) {
        for (const synth of synths) {
          synth.gateOn(base + i * .004); synth.gateOff(base + i * .004 + .002);
          offsets.add(synth.osc1.lfsrOffsetSec); offsets.add(synth.osc2.lfsrOffsetSec);
        }
      }
      await wait(400);
      // Gate events scheduled ahead, then cancelled before they start.
      const now = context.currentTime;
      for (let i = 1; i <= 5; i += 1) synths[0].gateOn(now + .3 + i * .05);
      const scheduled = synths[0].osc1.current.generations.size;
      synths[0].cancelScheduledGatesFrom(now + .3);
      const afterCancel = synths[0].osc1.current.generations.size;
      // Auto Play and BURST pulses also re-seek through the same Gate path.
      synths[1].setAmplitudeEnvelope({ ...synths[1].getSettings().ampEnvelope, mode: 'one-shot' });
      synths[1].setBurstSettings({ ...synths[1].getSettings().burst, enabled: true, pulseIntervalSec: .01 });
      synths[1].setAutoTrigger({ ...synths[1].getSettings().autoTrigger, tonSec: .03, repeatSec: .06 });
      synths[1].startAutoTrigger();
      await wait(400);
      synths[1].stopAutoTrigger();
      await wait(300);
      const settled = synths.flatMap(synth => [synth.osc1.current.generations.size, synth.osc2.current.generations.size]);
      return { offsets: offsets.size, generated: factory.lfsrBank.generatedCount, tables: factory.lfsrBank.tableCount,
        scheduled, afterCancel, settled, errors };
    } catch (error) {
      errors.push(String(error));
      return { errors };
    } finally {
      synths.forEach(synth => synth.dispose());
      await context.close();
    }
  });
  expect(result.errors).toEqual([]);
  // 40 Gates x 2 timbres x 2 OSCs: random sample offsets in a 10 s table essentially never repeat.
  expect(result.offsets).toBeGreaterThanOrEqual(158);
  expect(result.generated).toBe(1);
  expect(result.tables).toBe(1);
  expect(result.scheduled).toBeGreaterThan(result.afterCancel);
  expect(result.settled).toEqual([1, 1, 1, 1]);
});

test('Clock/Bits edits regenerate once after the control settles and apply from the next Gate', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new AudioContext();
    const factory = new WhiteNoiseFactory(context);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.sourceType = 'lfsr-noise';
    const synth = new ChannelSynth(context, factory, settings, 0);
    const before = synth.osc1.current.latest.source.buffer;
    for (let bits = 1; bits <= 16; bits += 1) synth.setOscLfsr(1, { clockHz: 4800, bits });
    const duringDebounce = factory.lfsrBank.generatedCount;
    await new Promise(resolve => setTimeout(resolve, 300));
    const sounding = synth.osc1.current.latest.source.buffer;
    synth.gateOn(context.currentTime + .05);
    const next = synth.osc1.current.latest.source.buffer;
    // Worst case for generation time: the clock at the sample rate with 16 bits.
    synth.setOscLfsr(1, { clockHz: context.sampleRate, bits: 16 });
    await new Promise(resolve => setTimeout(resolve, 300));
    const worstMs = factory.lfsrBank.lastGenerationMs;
    synth.dispose();
    const tablesAfterDispose = factory.lfsrBank.tableCount;
    await context.close();
    return { duringDebounce, generated: factory.lfsrBank.generatedCount, keptOld: sounding === before, usesNew: next !== before && next.length === before.length,
      worstMs, sampleRate: context.sampleRate, tablesAfterDispose };
  });
  console.log(`LFSR worst-case table generation: ${result.worstMs.toFixed(1)} ms at ${result.sampleRate} Hz`);
  expect(result).toMatchObject({ duringDebounce: 1, generated: 3, keptOld: true, usesNew: true, tablesAfterDispose: 0 });
});

test('White Noise and periodic OSCs keep their sources and ignore Gate re-seeks', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ChannelSynth } = await import('/src/audio/core/ChannelSynth.ts');
    const { WhiteNoiseFactory } = await import('/src/audio/dsp/WhiteNoiseFactory.ts');
    const { DEFAULT_CHANNEL_SETTINGS } = await import('/src/audio/constants.ts');
    const context = new OfflineAudioContext(1, 4800, 48000);
    const factory = new WhiteNoiseFactory(context);
    const settings = structuredClone(DEFAULT_CHANNEL_SETTINGS);
    settings.osc1.sourceType = 'white-noise'; settings.osc2.sourceType = 'square';
    settings.phaseMode = 'free';
    const synth = new ChannelSynth(context, factory, settings, 0);
    const white = synth.osc1.current.source;
    const square = [...synth.osc2.current.generations];
    synth.gateOn(0); synth.gateOff(.01); synth.gateOn(.02);
    const kept = synth.osc1.current.source === white && synth.osc2.current.generations.size === 1 && synth.osc2.current.latest === square[0];
    return { kept, kinds: [synth.osc1.current.kind, synth.osc2.current.kind], tables: factory.lfsrBank.generatedCount };
  });
  expect(result).toEqual({ kept: true, kinds: ['noise', 'periodic'], tables: 0 });
});

test('OSC card shows Noise Clock and Bits for LFSR Noise only, and saves them', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto('/');
  await expect(page.locator('#osc1-frequency')).toBeEnabled();
  await openTimbreEditors(page, ['osc1']);
  await expect(page.locator('#osc1-lfsr')).toBeHidden();
  await page.locator('#osc1-type').selectOption('lfsr-noise');
  await expect(page.locator('#osc1-lfsr')).toBeVisible();
  await expect(page.locator('#osc1-lfsr-readout')).toContainText('LFSR shift');
  const sampleRate = await page.evaluate(() => Number(document.querySelector('#osc1-lfsr-clock').dataset.numericMax));
  expect(sampleRate).toBeGreaterThanOrEqual(8000);
  await page.locator('#osc1-lfsr-clock').fill('4800');
  await page.locator('#osc1-lfsr-clock').dispatchEvent('change');
  await page.locator('#osc1-lfsr-bits').fill('4');
  await page.locator('#osc1-lfsr-bits').dispatchEvent('change');
  await expect(page.locator('#osc1-lfsr-readout')).toContainText('4 bit');
  await expect(page.locator('#osc1-lfsr-readout')).toContainText('19200');
  await expect(page.locator('#osc1-detune-readout')).toContainText('N/A (Noise)');
  const download = page.waitForEvent('download');
  await page.locator('#save-1').click();
  const timbre = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  expect(timbre.settings.osc1).toMatchObject({ sourceType: 'lfsr-noise', lfsr: { clockHz: 4800, bits: 4 } });
  await page.locator('#osc1-type').selectOption('sine');
  await expect(page.locator('#osc1-lfsr')).toBeHidden();
});
