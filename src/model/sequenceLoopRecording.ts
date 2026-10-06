import type { PitchPoint, PitchRecording, TriggerGate, TriggerRecording } from '../audio/types';
import { pitchValueAt, simplifyPitchPoints } from './sequencePitch';

/** A later performed Gate owns its overlap with an earlier Gate. */
export function mergeGateGesture(base: TriggerRecording, incoming: TriggerGate, mode: 'replace' | 'overdub'): TriggerRecording {
  if (incoming.offSec <= incoming.onSec) return base;
  const retained = base.gates.flatMap(gate => {
    if (gate.offSec <= incoming.onSec || gate.onSec >= incoming.offSec) return [gate];
    return mode === 'overdub' && gate.onSec < incoming.onSec
      ? [{ onSec: gate.onSec, offSec: incoming.onSec }] : [];
  });
  const gates: TriggerGate[] = [];
  for (const gate of [...retained, incoming].sort((a, b) => a.onSec - b.onSec)) {
    const previous = gates.at(-1);
    if (previous && gate.onSec <= previous.offSec) previous.offSec = Math.max(previous.offSec, gate.offSec);
    else gates.push({ ...gate });
  }
  return { ...base, gates };
}

/** Clear the selected interval for a new Gate take, preserving material outside it. */
export function clearSelectedGates(base: TriggerRecording): TriggerRecording {
  const start = base.selectionStartSec, end = base.selectionEndSec;
  return { ...base, gates: base.gates.flatMap(gate => {
    if (gate.offSec <= start || gate.onSec >= end) return [{ ...gate }];
    const outside: TriggerGate[] = [];
    if (gate.onSec < start) outside.push({ onSec: gate.onSec, offSec: start });
    if (gate.offSec > end) outside.push({ onSec: end, offSec: gate.offSec });
    return outside;
  }) };
}

/** Center is the default Pitch of an active new take; outside the selection stays intact. */
export function centerSelectedPitch(base: PitchRecording): PitchRecording {
  return splicePitchRecording(base, base.selectionStartSec, base.selectionEndSec, [
    { timeSec: base.selectionStartSec, valueNormalized: 0 },
    { timeSec: base.selectionEndSec, valueNormalized: 0 }
  ]);
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
