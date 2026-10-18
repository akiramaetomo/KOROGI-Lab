import { describe, expect, it } from 'vitest';
import { planPatternCopy } from './patternCopy';

const timbre = { patternBars: [2, 1, 1, 1, 1, 1, 1, 1] };
const empty = { sourceRecorded: true, destinationRecorded: false };

describe('planPatternCopy', () => {
  it('carries the source bars to an unused destination number without an overwrite', () => {
    expect(planPatternCopy(timbre, 'user-1', 'user-3', empty)).toEqual({ bars: 2, overwrite: false });
  });
  it('reports a recorded destination', () => {
    expect(planPatternCopy(timbre, 'user-1', 'user-3', { sourceRecorded: true, destinationRecorded: true })).toEqual({ bars: 2, overwrite: true });
  });
  it('leaves the bars alone when they already match or the source is Null', () => {
    expect(planPatternCopy(timbre, 'user-2', 'user-3', empty)).toEqual({ bars: null, overwrite: false });
    expect(planPatternCopy(timbre, 'user-1', 'user-3', { ...empty, sourceRecorded: false })).toEqual({ bars: null, overwrite: false });
  });
});
