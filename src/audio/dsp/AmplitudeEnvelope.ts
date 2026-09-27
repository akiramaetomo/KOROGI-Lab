import { PARAM_SMOOTH_SEC } from '../constants';
import type { AmplitudeEnvelopeSettings } from '../types';
import { holdAudioParam } from './params';
import { EnvelopeTimeline, ENVELOPE_FLOOR_GAIN } from './EnvelopeTimeline';
export { ENVELOPE_FLOOR_GAIN } from './EnvelopeTimeline';

/** Gain output and unity bypass; timing/history are shared with FEnv. */
export class AmplitudeEnvelope extends EnvelopeTimeline {
  readonly node: GainNode;
  constructor(context: AudioContext, initial: AmplitudeEnvelopeSettings) {
    super(context, initial);
    this.node = context.createGain();
    this.node.gain.value = ENVELOPE_FLOOR_GAIN;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.compact();
    this.enabled = enabled;
    const now = this.context.currentTime;
    const current = this.segmentAt(now);
    if (enabled && (current.kind === 'idle' || (current.kind === 'release' &&
      !(this.settingsAt(now).mode === 'one-shot' && current.end > now)))) this.muteReleasedGate(now);
    const resume = now + PARAM_SMOOTH_SEC;
    holdAudioParam(this.node.gain, now);
    this.node.gain.setValueAtTime(this.node.gain.value, now);
    this.node.gain.linearRampToValueAtTime(enabled ? this.valueAt(resume) : 1, resume);
    if (enabled) this.scheduleFrom(resume);
  }

  silence(time = this.context.currentTime): void {
    this.compact();
    time = Math.max(time, this.context.currentTime);
    this.events = [{ kind: 'silence', time }];
    this.rebuild();
    holdAudioParam(this.node.gain, time);
    this.node.gain.setValueAtTime(0, time);
  }


  protected scheduleFrom(time: number): void { this.scheduleParam(this.node.gain, time); }
}
