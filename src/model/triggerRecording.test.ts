import { describe, expect, it } from 'vitest';
import { normalizeTriggerRecording, selectedTriggerGates } from './triggerRecording';

const sample = { durationSec: 30, selectionStartSec: 5, selectionEndSec: 12,
  gates: [{ onSec: 2, offSec: 6 }, { onSec: 8, offSec: 10 }, { onSec: 11, offSec: 15 }, { onSec: 20, offSec: 21 }] };

describe('trigger recording file and selection boundary', () => {
  it('clips crossing gates, rebases the selection and keeps the raw take intact', () => {
    const original = structuredClone(sample);
    const recording = normalizeTriggerRecording(sample)!;
    expect(selectedTriggerGates(recording)).toEqual([
      { onSec: 0, offSec: 1 }, { onSec: 3, offSec: 5 }, { onSec: 6, offSec: 7 }
    ]);
    expect(sample).toEqual(original);
    expect(recording.gates).toEqual(sample.gates);
  });

  it('accepts an empty performance but rejects malformed timing and excessive length', () => {
    expect(normalizeTriggerRecording({ durationSec: 300, selectionStartSec: 0, selectionEndSec: 300, gates: [] })?.gates).toEqual([]);
    for (const invalid of [
      { ...sample, durationSec: 301 },
      { ...sample, selectionStartSec: 12 },
      { ...sample, selectionEndSec: 31 },
      { ...sample, gates: [{ onSec: 3, offSec: 4 }, { onSec: 3.5, offSec: 5 }] },
      { ...sample, gates: [{ onSec: 0, offSec: Infinity }] },
      { ...sample, gates: [{ onSec: 0, offSec: 31 }] }
    ]) expect(() => normalizeTriggerRecording(invalid)).toThrow();
  });
});
