import { describe, expect, it } from 'vitest';
import { SequencePitchControl } from './SequencePitchControl';

class FakeAudioParam {
  value = 0;
  readonly calls: Array<{ kind: string; value?: number; time: number }> = [];
  cancelScheduledValues(time: number): AudioParam { this.calls.push({ kind: 'cancel', time }); return this as unknown as AudioParam; }
  setValueAtTime(value: number, time: number): AudioParam { this.calls.push({ kind: 'set', value, time }); this.value = value; return this as unknown as AudioParam; }
  linearRampToValueAtTime(value: number, time: number): AudioParam { this.calls.push({ kind: 'linear', value, time }); this.value = value; return this as unknown as AudioParam; }
}

class FakeConstantSource {
  readonly offset = new FakeAudioParam();
  started = false;
  stopped = false;
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
  connect(): void {}
  disconnect(): void {}
}

function harness() {
  const source = new FakeConstantSource();
  const context = { currentTime: 0, createConstantSource: () => source } as unknown as AudioContext;
  return { source, context: context as AudioContext & { currentTime: number }, control: new SequencePitchControl(context) };
}

describe('SequencePitchControl', () => {
  it('starts neutral and schedules immediate cent targets', () => {
    const { source, control } = harness();
    expect(source.started).toBe(true);
    control.setTarget(300, 1);
    expect(control.valueAt(.5)).toBe(0);
    expect(control.valueAt(1)).toBe(300);
    expect(source.offset.calls.slice(-2)).toEqual([
      { kind: 'set', value: 0, time: 1 }, { kind: 'set', value: 300, time: 1 }
    ]);
  });

  it('restarts an interrupted portamento from the exact in-flight cent value', () => {
    const { context, control } = harness();
    control.setTarget(1200, 0, 2);
    expect(control.valueAt(1)).toBe(600);
    context.currentTime = 1;
    control.setTarget(-1200, 1, 1);
    expect(control.valueAt(1)).toBe(600);
    expect(control.valueAt(1.5)).toBe(-300);
    expect(control.valueAt(2)).toBe(-1200);
  });

  it('holds scheduled automation, clamps the supported span and disposes once', () => {
    const { context, source, control } = harness();
    control.setTarget(4000, 0, 10);
    expect(control.valueAt(5)).toBe(2400);
    context.currentTime = 2.5;
    expect(control.holdAt()).toBe(1200);
    expect(control.valueAt(5)).toBe(1200);
    control.dispose(); control.dispose();
    expect(source.stopped).toBe(true);
    expect(() => control.setTarget(0)).toThrow('disposed');
  });

  it('prunes completed loop automation while retaining the current value', () => {
    const { context, control } = harness();
    for (let index = 0; index < 100; index += 1) {
      context.currentTime = index;
      control.setTarget(index % 2 ? 100 : -100, index);
    }
    expect(control.valueAt(99)).toBe(100);
    expect((control as unknown as { segments: unknown[] }).segments.length).toBeLessThan(4);
  });
});
