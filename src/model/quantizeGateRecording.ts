import type { TriggerRecording } from '../audio/types';
import { PARAMETER_RANGES as P } from '../config/parameterRanges';

export type GateQuantizeMode = 'on' | 'on-off';
export type GateQuantizeDenominator = 4 | 8 | 16 | 32;

export interface GateQuantizeOptions {
  bars: number;
  denominator: GateQuantizeDenominator;
  mode: GateQuantizeMode;
  gapSec: number;
  editStartSec: number;
  editEndSec: number;
}

export interface GateQuantizeResult {
  recording: TriggerRecording;
  changedGates: number;
  deletedGates: number;
}

type WorkingGate = { onSec: number; offSec: number; originalIndex: number; affected: boolean };

/** Quantize stored Gate times; the result is the only recording that needs to be saved. */
export function quantizeGateRecording(recording: TriggerRecording, options: GateQuantizeOptions): GateQuantizeResult {
  const { selectionStartSec: start, selectionEndSec: end, durationSec } = recording;
  const { bars, denominator, mode, gapSec, editStartSec, editEndSec } = options;
  const gapRange = P['gate-quantize-gap'];
  if (!Number.isInteger(bars) || bars < 1 || ![4, 8, 16, 32].includes(denominator) ||
    (mode !== 'on' && mode !== 'on-off') || !Number.isFinite(gapSec) ||
    gapSec < gapRange.min / 1000 || gapSec > gapRange.max / 1000 ||
    !Number.isFinite(editStartSec) || !Number.isFinite(editEndSec) ||
    editStartSec < start || editEndSec > end || editEndSec <= editStartSec) {
    throw new RangeError('Invalid Gate quantize settings or edit range.');
  }
  const step = (end - start) / (bars * denominator);
  const inRange = (time: number) => time >= editStartSec && time <= editEndSec;
  const snap = (time: number) => {
    const position = (time - start) / step;
    const index = Math.ceil(position - .5 - 1e-9); // Equal distance chooses the earlier grid line.
    return Math.max(start, Math.min(end, start + index * step));
  };
  const work: WorkingGate[] = recording.gates.map((gate, originalIndex) => {
    let { onSec, offSec } = gate;
    const onSelected = inRange(onSec);
    const offSelected = mode === 'on-off' && inRange(offSec);
    if (onSelected) {
      const nextOn = snap(onSec);
      if (mode === 'on') offSec = Math.min(durationSec, offSec + nextOn - onSec);
      onSec = nextOn;
    }
    if (offSelected) offSec = snap(offSec);
    return { onSec, offSec, originalIndex, affected: onSelected || offSelected };
  });

  // Later ON wins. Only pairs reached by this edit are adjusted; unrelated short gaps remain intact.
  const ordered = work.filter(gate => gate.offSec > gate.onSec)
    .sort((a, b) => a.onSec - b.onSec || a.originalIndex - b.originalIndex);
  const resolved: WorkingGate[] = [];
  for (const gate of ordered) {
    while (resolved.length && (resolved.at(-1)!.affected || gate.affected)) {
      const previous = resolved.at(-1)!;
      if (previous.offSec <= gate.onSec - gapSec) break;
      previous.offSec = Math.min(previous.offSec, gate.onSec - gapSec);
      previous.affected = true;
      if (previous.offSec > previous.onSec) break;
      resolved.pop();
      gate.affected = true;
    }
    resolved.push(gate);
  }

  // A selected Gate loop has another adjacency between its last OFF and next-cycle first ON.
  const first = resolved.find(gate => gate.offSec > start && gate.onSec < end);
  for (let index = resolved.length - 1; first && index >= 0; index -= 1) {
    const last = resolved[index]!;
    if (last.offSec <= start || last.onSec >= end) continue;
    if (!first.affected && !last.affected) break;
    const firstOn = Math.max(start, first.onSec);
    const lastOff = Math.min(end, last.offSec);
    const seamGap = end - lastOff + firstOn - start;
    if (seamGap >= gapSec) break;
    last.offSec = Math.min(last.offSec, end + firstOn - start - gapSec);
    last.affected = true;
    if (last.offSec > last.onSec) break;
    resolved.splice(index, 1);
    if (last === first) break;
  }

  const retained = new Map(resolved.map(gate => [gate.originalIndex, gate]));
  const changedGates = recording.gates.reduce((count, gate, index) => {
    const current = retained.get(index);
    return count + (current && (current.onSec !== gate.onSec || current.offSec !== gate.offSec) ? 1 : 0);
  }, 0);
  return { recording: { ...recording, gates: resolved.map(({ onSec, offSec }) => ({ onSec, offSec })) },
    changedGates, deletedGates: recording.gates.length - resolved.length };
}
