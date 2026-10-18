import type { UserPatternId } from '../audio/types';
import { patternBars } from './stretch';

export type PatternCopyPlan = {
  /** New bars of the destination number, or null when they stay. */
  bars: number | null;
  /** The destination holds a Gate or Pitch recording that the copy replaces. */
  overwrite: boolean;
};

/**
 * Copy Pattern carries the source bars to the destination number of the same timbre. Bars belong to each timbre
 * (ADR 0011), so the copy changes no other timbre and asks only before replacing a recording.
 */
export function planPatternCopy(timbre: { patternBars: readonly number[] }, from: UserPatternId, to: UserPatternId,
  state: { sourceRecorded: boolean; destinationRecorded: boolean }): PatternCopyPlan {
  const bars = state.sourceRecorded && patternBars(timbre, from) !== patternBars(timbre, to) ? patternBars(timbre, from) : null;
  return { bars, overwrite: state.destinationRecorded };
}
