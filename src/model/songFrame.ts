import type { GatePattern, PatternBars, PitchPattern } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { maxSongBars } from './recordingLimits';
import { barsFromSeconds } from './stretch';
import { USER_PATTERN_IDS } from './triggerRecording';

/** Bars a Pattern plays inside the SongFrame: its own bars, or the Frame when longer (ADR 0011). */
export function effectivePatternBars(bars: number, frameBars: number): number {
  return Math.min(bars, frameBars);
}

/** Every Pattern number at one bar: a timbre with nothing recorded. */
export function defaultPatternBars(): PatternBars {
  const bar = P['song-bars'].defaultValue;
  return [bar, bar, bar, bar, bar, bar, bar, bar];
}

/**
 * Pattern bars read from a timbre's selections at a BPM: each number takes its Gate selection, else its Pitch
 * selection, through the Seconds → Bars rule. Numbers without a recording keep `fallback` (one bar by default).
 */
export function patternBarsFromSelections(timbre: { gatePatterns: readonly Pick<GatePattern, 'id' | 'recording'>[];
  pitchPatterns: readonly Pick<PitchPattern, 'id' | 'recording'>[] }, bpm: number, fallback: readonly number[] = defaultPatternBars()): PatternBars {
  return USER_PATTERN_IDS.map((id, index) => {
    const recording = timbre.gatePatterns.find(item => item.id === id)?.recording ?? timbre.pitchPatterns.find(item => item.id === id)?.recording;
    return recording ? barsFromSeconds(recording.selectionEndSec - recording.selectionStartSec, bpm, maxSongBars(bpm)) : fallback[index]!;
  }) as PatternBars;
}

/**
 * The Frame that holds every Song cell: the longest Pattern among the Patterns that Song plays (a recorded Gate
 * set to play in Song), rounded up to whole bars. Null when Song plays nothing, so the caller keeps its Frame.
 */
export function frameBarsForSong(timbres: ReadonlyArray<{ gatePatterns: readonly Pick<GatePattern, 'id' | 'recording' | 'inSong'>[];
  patternBars: readonly number[] }>): number | null {
  const bars = timbres.flatMap(timbre => USER_PATTERN_IDS.flatMap((id, index) => {
    const gate = timbre.gatePatterns.find(item => item.id === id);
    return gate?.recording && gate.inSong ? [timbre.patternBars[index]!] : [];
  }));
  if (!bars.length) return null;
  return Math.min(P['song-frame'].max, Math.max(P['song-frame'].min, Math.ceil(Math.max(...bars) - 1e-9)));
}
