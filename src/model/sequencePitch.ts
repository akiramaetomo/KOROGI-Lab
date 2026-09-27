import type { AutoSequence, PitchPoint, PitchRecording, SequenceSettings } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';
import { clamp } from '../audio/dsp/params';
import { isRecord } from './patch';
import { MAX_RECORDING_SEC } from './recordingLimits';

export const MAX_PITCH_POINTS = 20_000;
export const PITCH_SIMPLIFY_TOLERANCE = 1 / P['sequence-pitch-scale'].max;

export function defaultSequenceSettings(): SequenceSettings {
  return {
    filterAmountCent: P['sequence-filter-amount'].defaultValue,
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
    || !isRecord(raw.pitchMode) || typeof raw.pitchMode.kind !== 'string') {
    throw new Error('Invalid sequence settings.');
  }
  const stepsPerSide = raw.pitchMode.stepsPerSide;
  const pitchMode = raw.pitchMode.kind === 'smooth'
    ? { kind: 'smooth' as const }
    : raw.pitchMode.kind === 'stepped' && typeof stepsPerSide === 'number' && Number.isInteger(stepsPerSide)
      && finiteNumber(raw.pitchMode.portamentoSec)
      && stepsPerSide >= P['sequence-pitch-steps'].min
      && stepsPerSide <= P['sequence-pitch-steps'].max
      ? { kind: 'stepped' as const, stepsPerSide,
        portamentoSec: bounded(raw.pitchMode.portamentoSec, {
          min: P['sequence-portamento'].min / 1000, max: P['sequence-portamento'].max / 1000
        }) }
      : null;
  if (!pitchMode) throw new Error('Invalid sequence pitch mode.');
  return {
    filterAmountCent: bounded((raw.filterAmountCent ?? 0) as number, P['sequence-filter-amount']),
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

export function quantizePitchValue(value: number, stepsPerSide: number): number {
  const steps = Math.round(clamp(stepsPerSide, P['sequence-pitch-steps'].min, P['sequence-pitch-steps'].max));
  return clamp(Math.round(clamp(value, -1, 1) * steps) / steps, -1, 1);
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
