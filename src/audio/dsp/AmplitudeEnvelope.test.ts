import { describe, expect, it } from 'vitest';
import { AmplitudeEnvelope } from './AmplitudeEnvelope';

interface RecordedParamEvent {
  kind: 'cancel-hold' | 'cancel' | 'set' | 'exponential' | 'linear';
  value?: number;
  time: number;
}

class FakeAudioParam {
  value = 0;
  readonly events: RecordedParamEvent[] = [];

  cancelAndHoldAtTime(time: number): AudioParam {
    this.events.push({ kind: 'cancel-hold', time });
    return this as unknown as AudioParam;
  }

  cancelScheduledValues(time: number): AudioParam {
    this.events.push({ kind: 'cancel', time });
    return this as unknown as AudioParam;
  }

  setValueAtTime(value: number, time: number): AudioParam {
    this.events.push({ kind: 'set', value, time });
    return this as unknown as AudioParam;
  }

  exponentialRampToValueAtTime(value: number, time: number): AudioParam {
    this.events.push({ kind: 'exponential', value, time });
    return this as unknown as AudioParam;
  }

  linearRampToValueAtTime(value: number, time: number): AudioParam {
    this.events.push({ kind: 'linear', value, time });
    return this as unknown as AudioParam;
  }
}

function createHarness() {
  const gain = new FakeAudioParam();
  const node = { gain } as unknown as GainNode;
  const context = {
    currentTime: 0,
    createGain: () => node
  } as unknown as AudioContext;
  const envelope = new AmplitudeEnvelope(context, {
    attackSec: 1,
    decaySec: 2,
    sustain: 0.4,
    releaseSec: 3
  });
  return { envelope, gain };
}

describe('AmplitudeEnvelope', () => {
  it('schedules one-shot Release at the end of Decay and ignores Gate OFF', () => {
    const { envelope, gain } = createHarness();
    envelope.setSettings({ attackSec: 1, decaySec: 2, sustain: .4, releaseSec: 3, mode: 'one-shot',
      attackCurve: 'linear', decayCurve: 'linear', releaseCurve: 'linear' });
    envelope.gateOn(10);
    expect(gain.events).toContainEqual({ kind: 'linear', value: 1, time: 11 });
    expect(gain.events).toContainEqual({ kind: 'linear', value: .4, time: 13 });
    expect(gain.events).toContainEqual({ kind: 'linear', value: 1e-4, time: 16 });
    const count = gain.events.length;
    envelope.gateOff(10.5);
    expect(gain.events).toHaveLength(count);
  });
  it('schedules each selected curve and keeps Release from the Gate ON snapshot', () => {
    const { envelope, gain } = createHarness();
    envelope.setSettings({ attackSec: 1, decaySec: 1, sustain: .5, releaseSec: 1,
      attackCurve: 'linear', decayCurve: 'exponential', releaseCurve: 'linear' });
    envelope.gateOn(10);
    envelope.setSettings({ attackSec: 1, decaySec: 1, sustain: .5, releaseSec: 1,
      attackCurve: 'exponential', decayCurve: 'linear', releaseCurve: 'exponential' });
    envelope.gateOff(12);
    expect(gain.events).toContainEqual({ kind: 'linear', value: 1, time: 11 });
    expect(gain.events).toContainEqual({ kind: 'exponential', value: .5, time: 12 });
    expect(gain.events.at(-1)).toEqual({ kind: 'linear', value: 1e-4, time: 13 });
  });
  it('schedules Attack and Decay from the Gate ON settings', () => {
    const { envelope, gain } = createHarness();
    envelope.gateOn(10);

    expect(gain.events).toContainEqual({ kind: 'exponential', value: 1, time: 11 });
    expect(gain.events).toContainEqual({ kind: 'exponential', value: 0.4, time: 13 });
  });

  it('keeps the active Gate release time after panel settings change', () => {
    const { envelope, gain } = createHarness();
    envelope.gateOn(10);
    envelope.setSettings({
      attackSec: 0.1,
      decaySec: 0.2,
      sustain: 0.8,
      releaseSec: 0.5
    });
    envelope.gateOff(13);

    expect(gain.events.at(-1)).toEqual({
      kind: 'exponential',
      value: 1e-4,
      time: 16
    });
  });

  it('uses changed ADSR settings on the next Gate ON', () => {
    const { envelope, gain } = createHarness();
    envelope.setSettings({
      attackSec: 0.1,
      decaySec: 0.2,
      sustain: 0.8,
      releaseSec: 0.5
    });
    envelope.gateOn(20);
    envelope.gateOff(21);

    expect(gain.events).toContainEqual({ kind: 'exponential', value: 1, time: 20.1 });
    expect(gain.events).toContainEqual({ kind: 'exponential', value: 0.8, time: 20.3 });
    expect(gain.events.at(-1)).toEqual({ kind: 'exponential', value: 1e-4, time: 21.5 });
  });

  it('does not use a cancelled future Gate snapshot for an earlier Stop', () => {
    const { envelope, gain } = createHarness();
    envelope.gateOn(10);
    envelope.setSettings({ attackSec: .1, decaySec: .1, sustain: 1, releaseSec: .2 });
    envelope.gateOn(12);
    envelope.gateOff(11);
    expect(gain.events.at(-1)).toEqual({ kind: 'exponential', value: 1e-4, time: 14 });
  });
});
