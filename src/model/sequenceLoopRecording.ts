import type { PitchPoint, PitchRecording, TriggerGate, TriggerRecording } from '../audio/types';
import { pitchValueAt, simplifyPitchPoints } from './sequencePitch';

/** Replace only the traversed interval of a circular Gate take. */
export function spliceGateRecording(base: TriggerRecording, start: number, end: number, take: readonly TriggerGate[]): TriggerRecording {
  const retained = base.gates.flatMap(gate => {
    if (gate.offSec <= start || gate.onSec >= end) return [gate];
    const pieces: TriggerGate[] = [];
    if (gate.onSec < start) pieces.push({ onSec: gate.onSec, offSec: start });
    if (gate.offSec > end) pieces.push({ onSec: end, offSec: gate.offSec });
    return pieces;
  });
  const gates = [...retained, ...take.filter(gate => gate.offSec > gate.onSec)].sort((a, b) => a.onSec - b.onSec);
  return { ...base, gates };
}

/** Retain old Pitch outside a punch; a 1 ms join prevents interpolation across the edit boundary. */
export function splicePitchRecording(base: PitchRecording, start: number, end: number, take: readonly PitchPoint[]): PitchRecording {
  const epsilon = Math.min(.001, Math.max(.000001, (end - start) / 4));
  const points: PitchPoint[] = [];
  if (start > 0) {
    points.push(...base.points.filter(point => point.timeSec < start - epsilon));
    points.push({ timeSec: start - epsilon, valueNormalized: pitchValueAt(base.points, start - epsilon) });
  }
  points.push(...take.filter(point => point.timeSec >= start && point.timeSec <= end));
  if (end < base.durationSec) {
    const resume = Math.min(base.durationSec, end + epsilon);
    points.push({ timeSec: resume, valueNormalized: pitchValueAt(base.points, resume) });
    points.push(...base.points.filter(point => point.timeSec > resume));
  }
  const sorted = points.sort((a, b) => a.timeSec - b.timeSec).filter((point, index, array) => index === 0 || point.timeSec > array[index - 1]!.timeSec);
  return { ...base, points: simplifyPitchPoints(sorted) };
}
