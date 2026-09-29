import type { AutoSequence, PitchPoint, PitchRecording, PitchScaleMode, SequenceSettings } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { clamp } from '../audio/dsp/params';
import { isRecord } from './patch';
import { MAX_RECORDING_SEC } from './recordingLimits';

export const MAX_PITCH_POINTS = 20_000;
export const PITCH_SIMPLIFY_TOLERANCE = 1 / P['sequence-pitch-scale'].max;

export function defaultSequenceSettings(): SequenceSettings {
  return {
    filterAmountCent: P['sequence-filter-amount'].defaultValue,
    filterAmountWide: false,
    pitchScaleCent: P['sequence-pitch-scale'].defaultValue,
    pitchMode: { kind: 'smooth' },
    recordSpeed: P['sequence-record-speed'].defaultValue,
    playSpeed: P['sequence-play-speed'].defaultValue
  };
}

export function defaultAutoSequence(): AutoSequence {
  return { pitchRecording: null, settings: defaultSequenceSettings() };
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bounded = (value: number, range: { min: number; max: number }): number => clamp(value, range.min, range.max);

export function normalizeSequenceSettings(raw: unknown): SequenceSettings {
  if (!isRecord(raw) || (raw.filterAmountCent !== undefined && !finiteNumber(raw.filterAmountCent)) || !finiteNumber(raw.pitchScaleCent) || !finiteNumber(raw.recordSpeed) || !finiteNumber(raw.playSpeed)
    || (raw.filterAmountWide !== undefined && typeof raw.filterAmountWide !== 'boolean')
    || !isRecord(raw.pitchMode) || typeof raw.pitchMode.kind !== 'string') {
    throw new Error('Invalid sequence settings.');
  }
  const stepsPerSide = raw.pitchMode.stepsPerSide;
  const scale = raw.pitchMode.scale ?? 'equal';
  if (!(['equal', 'just-major', 'major', 'natural-minor', 'dorian', 'major-blues', 'minor-blues'] as unknown[]).includes(scale)) throw new Error('Invalid pitch scale mode.');
  const pitchMode = raw.pitchMode.kind === 'smooth'
    ? { kind: 'smooth' as const, scale: scale as PitchScaleMode,
      portamentoSec: finiteNumber(raw.pitchMode.portamentoSec) ? bounded(raw.pitchMode.portamentoSec, { min: 0, max: 5 }) : 0 }
    : raw.pitchMode.kind === 'stepped' && typeof stepsPerSide === 'number' && Number.isInteger(stepsPerSide)
      && finiteNumber(raw.pitchMode.portamentoSec)
      && stepsPerSide >= P['sequence-pitch-steps'].min
      && stepsPerSide <= P['sequence-pitch-steps'].max
      ? { kind: 'stepped' as const, stepsPerSide, scale: scale as PitchScaleMode,
        portamentoSec: bounded(raw.pitchMode.portamentoSec, {
          min: 0, max: 5
        }) }
      : null;
  if (!pitchMode) throw new Error('Invalid sequence pitch mode.');
  return {
    filterAmountCent: bounded((raw.filterAmountCent ?? 0) as number, { min: raw.filterAmountWide ? -7200 : -4800, max: raw.filterAmountWide ? 7200 : 4800 }),
    filterAmountWide: raw.filterAmountWide ?? false,
    pitchScaleCent: bounded(raw.pitchScaleCent, P['sequence-pitch-scale']),
    pitchMode,
    recordSpeed: bounded(raw.recordSpeed, P['sequence-record-speed']),
    playSpeed: bounded(raw.playSpeed, P['sequence-play-speed'])
  };
}

/** Validate saved performance data without changing its timing or values. */
export function normalizePitchRecording(raw: unknown): PitchRecording | null {
  if (raw === null) return null;
  if (!isRecord(raw) || !Array.isArray(raw.points)) throw new Error('Invalid pitch recording.');
  const { durationSec, selectionStartSec, selectionEndSec } = raw;
  if (!finiteNumber(durationSec) || !finiteNumber(selectionStartSec) || !finiteNumber(selectionEndSec)
    || !(durationSec >= .001 && durationSec <= MAX_RECORDING_SEC)
    || !(selectionStartSec >= 0 && selectionEndSec - selectionStartSec >= .000999 && selectionEndSec <= durationSec)) {
    throw new Error('Invalid pitch recording time range.');
  }
  if (raw.points.length < 2 || raw.points.length > MAX_PITCH_POINTS) {
    throw new Error(`Pitch recording requires 2 to ${MAX_PITCH_POINTS} points.`);
  }
  const rawPoints = raw.points;
  let previousTime = -Infinity;
  const points = rawPoints.map((item: unknown, index: number): PitchPoint => {
    if (!isRecord(item) || !finiteNumber(item.timeSec) || !finiteNumber(item.valueNormalized)
      || item.timeSec < 0 || item.timeSec > durationSec || item.timeSec <= previousTime
      || item.valueNormalized < P['sequence-pitch-input'].min || item.valueNormalized > P['sequence-pitch-input'].max) {
      throw new Error('Invalid pitch recording point.');
    }
    if ((index === 0 && item.timeSec !== 0) || (index === rawPoints.length - 1 && item.timeSec !== durationSec)) {
      throw new Error('Pitch recording must include its start and end points.');
    }
    previousTime = item.timeSec;
    return { timeSec: item.timeSec, valueNormalized: item.valueNormalized };
  });
  return { durationSec, selectionStartSec, selectionEndSec, points };
}

const SCALE_SEMITONES: Record<Exclude<PitchScaleMode, 'equal' | 'just-major'>, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11], 'natural-minor': [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10], 'major-blues': [0, 2, 3, 4, 7, 9],
  'minor-blues': [0, 3, 5, 6, 7, 10]
};
const JUST_MAJOR = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8];

export function pitchPositions(stepsPerSide: number, scale: PitchScaleMode = 'equal', pitchScaleCent = 200): number[] {
  const steps = Math.round(clamp(stepsPerSide, 0, 24));
  if (steps === 0) return [];
  if (scale === 'equal') return Array.from({ length: steps * 2 + 1 }, (_, i) => (i - steps) / steps);
  // With Scale=0, preserve the independent Filter Amount's normalized motion.
  if (pitchScaleCent === 0) return [];
  const positive: number[] = [];
  for (let octave = 0; positive.length < steps && octave < 8; octave += 1) {
    const degrees = scale === 'just-major'
      ? JUST_MAJOR.map(ratio => 1200 * Math.log2(ratio))
      : SCALE_SEMITONES[scale].map(semitone => semitone * 100);
    for (const degree of degrees) {
      const cents = octave * 1200 + degree;
      if (cents <= 0) continue;
      if (cents > pitchScaleCent + 1e-9) return [...[...positive].reverse().map(v => -v), 0, ...positive];
      if (positive.length < steps) positive.push(cents / pitchScaleCent);
    }
  }
  return [...[...positive].reverse().map(v => -v), 0, ...positive];
}

export function quantizePitchValue(value: number, stepsPerSide: number, scale: PitchScaleMode = 'equal', pitchScaleCent = 200): number {
  const positions = pitchPositions(stepsPerSide, scale, pitchScaleCent);
  const bounded = clamp(value, -1, 1);
  if (!positions.length) return bounded;
  return positions.reduce((best, candidate) => Math.abs(candidate - bounded) < Math.abs(best - bounded) ? candidate : best);
}

export function pitchValueAt(points: readonly PitchPoint[], timeSec: number): number {
  if (!points.length) return 0;
  const time = clamp(timeSec, points[0]!.timeSec, points.at(-1)!.timeSec);
  let low = 0, high = points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid]!.timeSec <= time) low = mid; else high = mid - 1;
  }
  const left = points[low]!;
  const right = points[low + 1];
  if (!right || right.timeSec === left.timeSec) return left.valueNormalized;
  const ratio = (time - left.timeSec) / (right.timeSec - left.timeSec);
  return left.valueNormalized + (right.valueNormalized - left.valueNormalized) * ratio;
}

/** RDP simplification measured vertically in normalized pitch space. */
export function simplifyPitchPoints(points: readonly PitchPoint[], tolerance = PITCH_SIMPLIFY_TOLERANCE): PitchPoint[] {
  if (points.length <= 2) return points.map(point => ({ ...point }));
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const first = points[start]!, last = points[end]!;
    const span = last.timeSec - first.timeSec;
    let farthest = -1, maxError = tolerance;
    for (let index = start + 1; index < end; index += 1) {
      const point = points[index]!;
      const ratio = span > 0 ? (point.timeSec - first.timeSec) / span : 0;
      const expected = first.valueNormalized + (last.valueNormalized - first.valueNormalized) * ratio;
      const error = Math.abs(point.valueNormalized - expected);
      if (error > maxError) { maxError = error; farthest = index; }
    }
    if (farthest >= 0) {
      keep[farthest] = 1; stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, index) => keep[index]).map(point => ({ ...point }));
}
