import { describe, expect, it } from 'vitest';
import { centerSelectedPitch, clearSelectedGates, mergeGateGesture, splicePitchRecording } from './sequenceLoopRecording';
import { normalizePitchRecording, pitchValueAt } from './sequencePitch';
import { normalizeTriggerRecording } from './triggerRecording';

describe('circular punch recording', () => {
  it('joins touching Overdub Gates without a stored OFF/ON retrigger', () => {
    const base = { durationSec: 4, selectionStartSec: 0, selectionEndSec: 4,
      gates: [{ onSec: 1, offSec: 3 }, { onSec: 3.5, offSec: 3.8 }] };
    expect(mergeGateGesture(base, { onSec: 2, offSec: 2.5 }, 'replace').gates).toEqual([
      { onSec: 2, offSec: 2.5 }, { onSec: 3.5, offSec: 3.8 }
    ]);
    expect(mergeGateGesture(base, { onSec: 2, offSec: 2.5 }, 'overdub').gates).toEqual([
      { onSec: 1, offSec: 2.5 }, { onSec: 3.5, offSec: 3.8 }
    ]);
    expect(normalizeTriggerRecording(mergeGateGesture(base, { onSec: 2, offSec: 2.5 }, 'overdub'))).not.toBeNull();
  });
  it('starts a Replace take with an empty selected Gate interval and retains outside notes', () => {
    const old = { durationSec: 5, selectionStartSec: 1, selectionEndSec: 4,
      gates: [{ onSec: .3, offSec: 1.5 }, { onSec: 2, offSec: 3 }, { onSec: 3.7, offSec: 4.5 }] };
    const empty = clearSelectedGates(old);
    expect(empty.gates).toEqual([{ onSec: .3, offSec: 1 }, { onSec: 4, offSec: 4.5 }]);
    expect(mergeGateGesture(empty, { onSec: 2, offSec: 2.2 }, 'replace').gates).toEqual([
      { onSec: .3, offSec: 1 }, { onSec: 2, offSec: 2.2 }, { onSec: 4, offSec: 4.5 }
    ]);
    expect(old.gates).toHaveLength(3);
  });
  it('sets only the selected Pitch interval to Center for a Replace take', () => {
    const old = { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
      points: [{ timeSec: 0, valueNormalized: .5 }, { timeSec: 4, valueNormalized: .5 }] };
    const centered = centerSelectedPitch(old);
    expect(pitchValueAt(centered.points, .5)).toBeCloseTo(.5, 2);
    expect(pitchValueAt(centered.points, 1.5)).toBe(0);
    expect(pitchValueAt(centered.points, 2.5)).toBe(0);
    expect(pitchValueAt(centered.points, 3.5)).toBeCloseTo(.5, 2);
    expect(normalizePitchRecording(centered)).not.toBeNull();
  });
  it('preserves separate Gates across empty laps and splits a held Gate at a seam', () => {
    const original = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
      gates: [{ onSec: .3, offSec: .5 }, { onSec: 1.2, offSec: 1.4 }] };
    const first = mergeGateGesture(original, { onSec: 1.8, offSec: 2 }, 'replace');
    const second = mergeGateGesture(first, { onSec: 0, offSec: .15 }, 'replace');
    expect(normalizeTriggerRecording(second)?.gates).toEqual([
      { onSec: 0, offSec: .15 }, { onSec: .3, offSec: .5 },
      { onSec: 1.2, offSec: 1.4 }, { onSec: 1.8, offSec: 2 }
    ]);
    expect(mergeGateGesture(second, { onSec: 0, offSec: 0 }, 'replace')).toBe(second);
  });
  it('keeps old Pitch between separate operations and after a later partial lap', () => {
    const original = { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
      points: [{ timeSec: 0, valueNormalized: 0 }, { timeSec: 1, valueNormalized: .2 },
        { timeSec: 2, valueNormalized: .8 }, { timeSec: 3, valueNormalized: -.5 }, { timeSec: 4, valueNormalized: 0 }] };
    const lap = splicePitchRecording(original, 1, 3, [
      { timeSec: 1, valueNormalized: 0 }, { timeSec: 2, valueNormalized: .4 }, { timeSec: 3, valueNormalized: .4 }
    ]);
    const stopped = splicePitchRecording(lap, 1, 1.5, [
      { timeSec: 1, valueNormalized: -.2 }, { timeSec: 1.5, valueNormalized: -.2 }
    ]);
    expect(normalizePitchRecording(stopped)).not.toBeNull();
    expect(pitchValueAt(stopped.points, 1.25)).toBeCloseTo(-.2, 4);
    expect(pitchValueAt(stopped.points, 2.5)).toBeCloseTo(.4, 4);
    expect(pitchValueAt(stopped.points, 3.5)).toBeCloseTo(-.25, 4);
  });
  it('restores the old Pitch between two punches and after Center release', () => {
    const original = { durationSec: 2, selectionStartSec: 0, selectionEndSec: 2,
      points: [{ timeSec: 0, valueNormalized: .2 }, { timeSec: 2, valueNormalized: .2 }] };
    const first = splicePitchRecording(original, .3, .5, [
      { timeSec: .3, valueNormalized: .8 }, { timeSec: .5, valueNormalized: .8 }
    ]);
    const second = splicePitchRecording(first, .8, 1, [
      { timeSec: .8, valueNormalized: 0 }, { timeSec: 1, valueNormalized: 0 }
    ]);
    expect(normalizePitchRecording(second)).not.toBeNull();
    expect(pitchValueAt(second.points, .4)).toBeCloseTo(.8, 4);
    expect(pitchValueAt(second.points, .65)).toBeCloseTo(.2, 4);
    expect(pitchValueAt(second.points, .9)).toBeCloseTo(0, 4);
    expect(pitchValueAt(second.points, 1.2)).toBeCloseTo(.2, 4);
  });
});
