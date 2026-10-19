import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANNEL_SETTINGS } from '../constants';
import { amplitudeSum, formatPartialTable, normalizeAmplitudes, parsePartialTable, resolvePartials, sanitizeMulti, spreadPartials } from './multiOscillator';

describe('Multi OSC partials', () => {
  it('spreads N oscillators symmetrically in cents at 1/N each', () => {
    const partials = spreadPartials(3, 50);
    expect(partials.map(item => 1200 * Math.log2(item.ratio))).toEqual([-50, 0, 50].map(value => expect.closeTo(value, 9)));
    expect(partials.every(item => item.amplitude === 1 / 3)).toBe(true);
    expect(spreadPartials(1, 1200)).toEqual([{ ratio: 1, amplitude: 1 }]);
    expect(spreadPartials(40, 10)).toHaveLength(16);
  });
  it('resolves Single and white noise to one unity partial and Multi to its definition', () => {
    const osc = structuredClone(DEFAULT_CHANNEL_SETTINGS.osc1);
    expect(resolvePartials(osc)).toEqual([{ ratio: 1, amplitude: 1 }]);
    osc.voiceMode = 'multi';
    expect(resolvePartials(osc)).toHaveLength(osc.multi.spread.count);
    osc.multi.definition = 'table'; osc.multi.partials = [{ ratio: .5, amplitude: .2 }, { ratio: 2, amplitude: .3 }];
    expect(resolvePartials(osc)).toEqual(osc.multi.partials);
    expect(resolvePartials({ ...osc, sourceType: 'white-noise' })).toEqual([{ ratio: 1, amplitude: 1 }]);
  });
  it('normalizes amplitudes to a unit sum', () => {
    const partials = normalizeAmplitudes([{ ratio: 1, amplitude: .5 }, { ratio: 2, amplitude: 1.5 }]);
    expect(amplitudeSum(partials)).toBeCloseTo(1, 12);
    expect(partials[1]!.amplitude).toBeCloseTo(.75, 12);
    expect(normalizeAmplitudes([{ ratio: 1, amplitude: 0 }, { ratio: 2, amplitude: 0 }]).map(item => item.amplitude)).toEqual([.5, .5]);
  });
  it('bounds stored Multi values', () => {
    const multi = sanitizeMulti({ definition: 'table', partials: [{ ratio: 1e6, amplitude: 4 }],
      spread: { count: 99.4, spreadCent: -5 } });
    expect(multi.partials).toEqual([{ ratio: 64, amplitude: 1 }]);
    expect(multi.spread).toEqual({ count: 16, spreadCent: 0 });
  });
});

describe('Multi OSC table paste', () => {
  it('reads a Markdown table with No., Hz and Amplitude as ratios to Base', () => {
    const text = `| OSC | Frequency (Hz) | Amplitude |
|---|---|---|
| 1 | 246 | 0.167 |
| 2 | 308 | 0.167 |
| 3 | 367 | 0.167 |
| 4 | 418 | 0.167 |
| 5 | 440 | 0.167 |
| 6 | 627 | 0.167 |`;
    const partials = parsePartialTable(text, 440);
    expect(partials.map(item => item.ratio * 440)).toEqual([246, 308, 367, 418, 440, 627].map(hz => expect.closeTo(hz, 9)));
    expect(partials.every(item => item.amplitude === .167)).toBe(true);
  });
  it('reads tab, comma and space separated Hz with optional amplitude', () => {
    expect(parsePartialTable('Hz\tAmplitude\n100\t0.25\n200\t0.5', 100)).toEqual([{ ratio: 1, amplitude: .25 }, { ratio: 2, amplitude: .5 }]);
    expect(parsePartialTable('100, 0.1\n300, 0.2\n', 100).map(item => item.ratio)).toEqual([1, 3]);
    expect(parsePartialTable('100\n200\n400\n500', 100).map(item => item.amplitude)).toEqual([.25, .25, .25, .25]);
  });
  it('rejects malformed, mixed, out-of-range and oversized tables', () => {
    expect(() => parsePartialTable('100 abc', 100)).toThrow('Row 1');
    expect(() => parsePartialTable('100 0.5\n200', 100)).toThrow('every row or on none');
    expect(() => parsePartialTable('100 2', 100)).toThrow('amplitude');
    expect(() => parsePartialTable('0 0.5', 100)).toThrow('above 0 Hz');
    expect(() => parsePartialTable('100000', 100)).toThrow('Base');
    expect(() => parsePartialTable('Hz', 100)).toThrow('rows');
    expect(() => parsePartialTable(Array.from({ length: 17 }, () => '100').join('\n'), 100)).toThrow('rows');
  });
  it('copies a table that pastes back to the same partials', () => {
    const partials = [{ ratio: .559090909, amplitude: .167 }, { ratio: 1.425, amplitude: .5 }];
    const text = formatPartialTable(partials, 440);
    expect(text.split('\n')[0]).toBe('Hz\tAmplitude');
    parsePartialTable(text, 440).forEach((item, index) => {
      expect(item.ratio).toBeCloseTo(partials[index]!.ratio, 6);
      expect(item.amplitude).toBe(partials[index]!.amplitude);
    });
  });
});
