/** 4/4 is fixed, as in Song Bars and Gate quantize. */
export const BEATS_PER_BAR = 4;
const EPSILON = 1e-6;

/**
 * Bar length in recorded seconds. With a bar count the selection is divided evenly
 * (the Gate quantize grid); without one (Seconds timing) the bar follows the BPM.
 */
export function barSeconds(selectionSec: number, bars: number | null, bpm: number): number {
  return bars && bars > 0 ? selectionSec / bars : BEATS_PER_BAR * 60 / bpm;
}

/**
 * A recording loop clock. Each lap starts again at its first bar, so a lap that is
 * not a whole number of bars cuts its last bar short instead of drifting.
 */
export interface LoopBarClock {
  /** AudioContext time of the first lap start. */
  startedAt: number;
  /** Lap length in recorded seconds. */
  periodSec: number;
  /** Bar length in recorded seconds. */
  barSec: number;
  /** Recorded seconds per real second (Play/Rec Speed). */
  speed: number;
}

export interface ScheduledClick<T> { time: number; step: number; tone: T }

/** Clicks whose times fall in [from, to), spreading `pattern` evenly over every bar. */
export function clickTimes<T>(clock: LoopBarClock, pattern: readonly T[], from: number, to: number): ScheduledClick<T>[] {
  const { startedAt, periodSec, barSec, speed } = clock;
  if (!pattern.length || !(periodSec > 0) || !(barSec > 0) || !(speed > 0) || !(to > from)) return [];
  const stepSec = barSec / pattern.length;
  const lapWall = periodSec / speed;
  const clicks: ScheduledClick<T>[] = [];
  for (let lap = Math.max(0, Math.floor((from - startedAt) / lapWall)); ; lap += 1) {
    const lapStart = startedAt + lap * lapWall;
    if (lapStart >= to) break;
    // Each lap restarts from its own origin so rounding never accumulates across laps.
    for (let step = Math.max(0, Math.ceil((from - lapStart) * speed / stepSec - EPSILON)); step * stepSec < periodSec - EPSILON; step += 1) {
      const time = lapStart + step * stepSec / speed;
      if (time >= to) break;
      if (time >= from) clicks.push({ time, step: step % pattern.length, tone: pattern[step % pattern.length]! });
    }
  }
  return clicks;
}

/** The first bar start at or after `now` (a lap start counts as a bar start). */
export function nextBarTime(clock: LoopBarClock, now: number): number {
  const { startedAt, periodSec, barSec, speed } = clock;
  if (now <= startedAt || !(periodSec > 0) || !(barSec > 0) || !(speed > 0)) return Math.max(now, startedAt);
  const lapWall = periodSec / speed;
  const lapStart = startedAt + Math.floor((now - startedAt) / lapWall) * lapWall;
  const bar = Math.max(0, Math.ceil((now - lapStart) * speed / barSec - EPSILON));
  return bar * barSec < periodSec - EPSILON ? lapStart + bar * barSec / speed : lapStart + lapWall;
}
