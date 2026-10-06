import { describe, expect, it } from 'vitest';
import type { TriggerRecording } from '../audio/types';
import { normalizeTriggerRecording } from './triggerRecording';
import { quantizeGateRecording, type GateQuantizeOptions } from './quantizeGateRecording';

const base = (gates: TriggerRecording['gates']): TriggerRecording => ({
  durationSec: 2, selectionStartSec: 0, selectionEndSec: 2, gates
});
const settings: GateQuantizeOptions = { bars: 1, denominator: 16, mode: 'on', gapSec: .01,
  editStartSec: 0, editEndSec: 2 };

describe('quantizeGateRecording', () => {
  it('keeps one bar anchored while a later edit quantizes only a subsection', () => {
    const original = base([{ onSec: .19, offSec: .31 }, { onSec: .81, offSec: .92 }, { onSec: 1.6, offSec: 1.72 }]);
    const fine = quantizeGateRecording(original, { ...settings, denominator: 32 }).recording;
    const coarse = quantizeGateRecording(fine, { ...settings, denominator: 4, editStartSec: .7, editEndSec: 1.1 }).recording;
    expect(fine.gates[0]!.onSec).toBe(.1875);
    expect(coarse.gates[0]).toEqual(fine.gates[0]);
    expect(coarse.gates[1]!.onSec).toBe(1);
    expect(coarse.gates[2]).toEqual(fine.gates[2]);
    expect(coarse.selectionEndSec).toBe(2);
  });

  it('moves ON and OFF together in ON-only mode, and only selected endpoints in ON/OFF mode', () => {
    const original = base([{ onSec: .8, offSec: 1.2 }, { onSec: 1.2, offSec: 1.7 }]);
    const onOnly = quantizeGateRecording(original, { ...settings, denominator: 4, editStartSec: 1, editEndSec: 1.5 });
    expect(onOnly.recording.gates[1]!.onSec).toBe(1);
    expect(onOnly.recording.gates[1]!.offSec).toBeCloseTo(1.5, 9);
    const both = quantizeGateRecording(original, { ...settings, denominator: 4, mode: 'on-off', editStartSec: 1, editEndSec: 1.5 });
    expect(both.recording.gates).toEqual([{ onSec: .8, offSec: .99 }, { onSec: 1, offSec: 1.7 }]);
  });

  it('gives the later ON priority, creates the requested gap, and allows Gate deletion', () => {
    const shortGap = quantizeGateRecording(base([{ onSec: .01, offSec: .495 }, { onSec: .51, offSec: .65 }]),
      { ...settings, denominator: 4, editStartSec: .5, editEndSec: .6 });
    expect(shortGap.recording.gates[0]!.offSec).toBeCloseTo(.49, 9);
    expect(shortGap.recording.gates[1]!.onSec).toBe(.5);
    const sameOn = quantizeGateRecording(base([{ onSec: .05, offSec: .2 }, { onSec: .21, offSec: .4 }]),
      { ...settings, denominator: 4 });
    expect(sameOn.deletedGates).toBe(1);
    expect(sameOn.recording.gates[0]!.onSec).toBe(0);
    expect(sameOn.recording.gates[0]!.offSec).toBeCloseTo(.19, 9);
    const collapsed = quantizeGateRecording(base([{ onSec: .05, offSec: .07 }]),
      { ...settings, denominator: 4, mode: 'on-off' });
    expect(collapsed.recording.gates).toEqual([]);
    expect(normalizeTriggerRecording(collapsed.recording)).not.toBeNull();
  });

  it('separates the final OFF from the next loop ON', () => {
    const result = quantizeGateRecording(base([{ onSec: 0, offSec: .2 }, { onSec: 1.8, offSec: 2 }]),
      { ...settings, editStartSec: 0, editEndSec: .25 });
    expect(result.recording.gates[1]!.offSec).toBeCloseTo(1.99, 9);
    expect(normalizeTriggerRecording(result.recording)).toEqual(result.recording);
  });

  it('keeps the recorded duration and leaves unrelated small gaps alone', () => {
    const original = base([{ onSec: .1, offSec: .199 }, { onSec: .2, offSec: .35 }, { onSec: 1.1, offSec: 1.3 }]);
    const result = quantizeGateRecording(original, { ...settings, editStartSec: 1, editEndSec: 1.5 });
    expect(result.recording.gates.slice(0, 2)).toEqual(original.gates.slice(0, 2));
    expect(result.recording.durationSec).toBe(2);
  });

  it('anchors an offset selection across multiple bars and is stable on repeated application', () => {
    const original: TriggerRecording = { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
      gates: [{ onSec: 1.12, offSec: 1.3 }, { onSec: 2.37, offSec: 2.52 }] };
    const options: GateQuantizeOptions = { ...settings, bars: 2, denominator: 4, editStartSec: 2.2, editEndSec: 2.5 };
    const first = quantizeGateRecording(original, options);
    expect(first.recording.gates[0]).toEqual(original.gates[0]);
    expect(first.recording.gates[1]!.onSec).toBe(2.25);
    expect(quantizeGateRecording(first.recording, options).recording).toEqual(first.recording);
    expect(original.gates[1]!.onSec).toBe(2.37);
  });

  it('keeps ON-only results inside the recording duration and rejects an invalid Gap', () => {
    const endGate = base([{ onSec: 1.76, offSec: 2 }]);
    const result = quantizeGateRecording(endGate, { ...settings, denominator: 4, editStartSec: 1.7, editEndSec: 1.9 });
    expect(result.recording.gates).toEqual([]);
    expect(() => quantizeGateRecording(endGate, { ...settings, gapSec: .021 })).toThrow(RangeError);
  });

  it('resolves a dense loop seam within the 10,000-Gate recording limit', () => {
    const gates = [{ onSec: 0, offSec: .01 }, ...Array.from({ length: 9_999 }, (_, index) => {
      const onSec = 1.99 + index * .000001;
      return { onSec, offSec: onSec + .0000005 };
    })];
    const result = quantizeGateRecording(base(gates), { ...settings, editStartSec: 0, editEndSec: .01 });
    expect(result.deletedGates).toBe(9_999);
    expect(result.recording.gates).toEqual([{ onSec: 0, offSec: .01 }]);
  });
});
