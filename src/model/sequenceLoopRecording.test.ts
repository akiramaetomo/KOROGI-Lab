import { describe, expect, it } from 'vitest';
import { spliceGateRecording, splicePitchRecording } from './sequenceLoopRecording';
import { normalizePitchRecording, pitchValueAt } from './sequencePitch';
import { normalizeTriggerRecording } from './triggerRecording';

describe('linked circular punch recording', () => {
  it('replaces a full Gate lap, then only the traversed prefix of the next lap', () => {
    const original = { durationSec: 4, selectionStartSec: 1, selectionEndSec: 3,
      gates: [{ onSec: .2, offSec: .4 }, { onSec: 1.2, offSec: 1.6 }, { onSec: 2.2, offSec: 2.7 }, { onSec: 3.3, offSec: 3.5 }] };
    const lap = spliceGateRecording(original, 1, 3, [{ onSec: 1.4, offSec: 1.7 }, { onSec: 2.1, offSec: 2.4 }]);
    const stopped = spliceGateRecording(lap, 1, 1.5, [{ onSec: 1.1, offSec: 1.3 }]);
    expect(normalizeTriggerRecording(stopped)?.gates).toEqual([
      { onSec: .2, offSec: .4 }, { onSec: 1.1, offSec: 1.3 }, { onSec: 1.5, offSec: 1.7 },
      { onSec: 2.1, offSec: 2.4 }, { onSec: 3.3, offSec: 3.5 }
    ]);
  });
  it('keeps old Pitch after a partial second lap while replacing the visited prefix', () => {
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
});
