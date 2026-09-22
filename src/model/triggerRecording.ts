import type { TriggerGate, TriggerRecording, UserPattern, UserPatternId } from '../audio/types';
import { isRecord } from './patch';

export const MAX_RECORDING_SEC = 300;
export const USER_PATTERN_IDS = ['user-1', 'user-2'] as const satisfies readonly UserPatternId[];
export function emptyUserPatterns(): UserPattern[] {
  return USER_PATTERN_IDS.map(id => ({ id, recording: null }));
}

export function patternRecording(patterns: readonly UserPattern[], patternId: UserPatternId): TriggerRecording | null {
  return patterns.find(pattern => pattern.id === patternId)?.recording ?? null;
}
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Validate file data without silently changing the performance timing. */
export function normalizeTriggerRecording(raw: unknown): TriggerRecording | null {
  if (raw === null) return null;
  if (!isRecord(raw) || !Array.isArray(raw.gates)) throw new Error('Invalid trigger recording.');
  const { durationSec, selectionStartSec, selectionEndSec } = raw;
  if (!finiteNumber(durationSec) || !finiteNumber(selectionStartSec) || !finiteNumber(selectionEndSec)
    || !(durationSec >= .001 && durationSec <= MAX_RECORDING_SEC)
    || !(selectionStartSec >= 0 && selectionEndSec - selectionStartSec >= .000999 && selectionEndSec <= durationSec)) {
    throw new Error('Invalid trigger recording time range.');
  }
  if (raw.gates.length > 10000) throw new Error('Trigger recording has too many gates.');
  let previousOff = 0;
  const gates: TriggerGate[] = raw.gates.map((item: unknown) => {
    if (!isRecord(item) || typeof item.onSec !== 'number' || typeof item.offSec !== 'number'
      || !Number.isFinite(item.onSec) || !Number.isFinite(item.offSec)
      || item.onSec < previousOff || item.onSec < 0 || item.offSec <= item.onSec || item.offSec > durationSec) {
      throw new Error('Invalid trigger gate times.');
    }
    previousOff = item.offSec;
    return { onSec: item.onSec, offSec: item.offSec };
  });
  return { durationSec, selectionStartSec, selectionEndSec, gates };
}

/** Clip notes to the selected interval and rebase it to playback time zero. */
export function selectedTriggerGates(recording: TriggerRecording): TriggerGate[] {
  const { selectionStartSec: start, selectionEndSec: end } = recording;
  return recording.gates.flatMap(gate => {
    const onSec = Math.max(start, gate.onSec);
    const offSec = Math.min(end, gate.offSec);
    return offSec > onSec ? [{ onSec: onSec - start, offSec: offSec - start }] : [];
  });
}
