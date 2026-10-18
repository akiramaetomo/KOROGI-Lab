import type { SequenceSelection, SongSettings, UserPatternId } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { USER_PATTERN_IDS } from './triggerRecording';

/**
 * The Pattern whose bars set a Stretch loop: the Gate Pattern when recorded Gates play,
 * otherwise the Pitch Pattern (Auto Gate or a Null Gate Pattern). Gate and Pitch share it.
 */
export function stretchBasePattern(source: Pick<SequenceSelection, 'gateMode' | 'gateUserId' | 'pitchUserId'>,
  hasGateRecording: boolean): UserPatternId {
  return source.gateMode === 'user' && hasGateRecording ? source.gateUserId : source.pitchUserId;
}

/** Bars of one timbre's Pattern number (ADR 0011: each timbre keeps its own). */
export function patternBars(timbre: { patternBars: readonly number[] }, pattern: UserPatternId): number {
  return timbre.patternBars[USER_PATTERN_IDS.indexOf(pattern)]!;
}

/** Real seconds of one Stretch loop: the Pattern's bars at the Session BPM. */
export function stretchLoopSeconds(bars: number, song: Pick<SongSettings, 'bpm'>): number {
  return bars * 240 / song.bpm;
}

/** Recorded seconds per real second that fit a selection to a Stretch loop (playback and recording alike). */
export function stretchSpeed(selectionSec: number, loopSec: number): number {
  return selectionSec / loopSec;
}

/** Bar counts below one bar that a Pattern may take; each divides a bar, so its loops stay on the bar grid. */
export const PATTERN_BAR_FRACTIONS = [1 / 16, 1 / 8, 1 / 4, 1 / 2] as const;

/** A Pattern's bars: 1/2, 1/4, 1/8 or 1/16, or a whole number from the minimum to `maxBars`. */
export function isPatternBars(value: number, maxBars: number): boolean {
  return (PATTERN_BAR_FRACTIONS as readonly number[]).includes(value) ||
    Number.isInteger(value) && value >= P['song-bars'].min && value <= maxBars;
}

/** Every bar count a Pattern may take, shortest first: the Bars menus list exactly these. */
export function patternBarChoices(maxBars: number): number[] {
  return [...PATTERN_BAR_FRACTIONS, ...Array.from({ length: Math.max(0, maxBars - P['song-bars'].min + 1) }, (_, index) => P['song-bars'].min + index)];
}

/** Reads typed bars: `1/4` or `0.25` style numbers. Range is left to `isPatternBars`; null when unreadable. */
export function parsePatternBars(text: string): number | null {
  const trimmed = text.trim();
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(trimmed);
  if (fraction) return Number(fraction[2]) > 0 ? Number(fraction[1]) / Number(fraction[2]) : null;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Bars as shown: `1/4` below one bar, otherwise the number (`2`). */
export function formatBars(bars: number): string {
  return bars > 0 && bars < 1 && Number.isInteger(1 / bars) ? `1/${1 / bars}` : String(bars);
}

/**
 * Bars that a recorded length fills at a BPM, at most `maxBars`: the Seconds → Bars bridge. Below one bar the
 * nearest of 1/16, 1/8, 1/4, 1/2 and 1 on a log scale (0.50 s at 120 BPM → 1/4); from one bar, whole bars.
 */
export function barsFromSeconds(seconds: number, bpm: number, maxBars: number): number {
  const bars = seconds * bpm / 240;
  if (bars < 1) {
    const candidates = [...PATTERN_BAR_FRACTIONS, 1];
    if (!(bars > 0)) return candidates[0]!;
    return candidates.reduce((best, value) => Math.abs(Math.log(bars / value)) < Math.abs(Math.log(bars / best)) ? value : best);
  }
  return Math.min(maxBars, Math.round(bars));
}
