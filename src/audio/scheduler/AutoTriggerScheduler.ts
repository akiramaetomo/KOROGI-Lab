import { LIMITS } from '../constants';
import type { AutoTriggerSettings } from '../types';
import { clamp } from '../dsp/params';

export interface GateTarget {
  gateOn(time: number): void;
  gateOff(time: number): void;
}

type PendingGateEvent =
  | { kind: 'on'; time: number }
  | { kind: 'off'; time: number; nextOnTime: number };

/**
 * Main-thread lookahead scheduler.
 * setInterval only wakes the scheduler; Web Audio event timing is always
 * expressed on AudioContext.currentTime.
 *
 * CR-2026-09-15-01: it repeats indefinitely until stop() is called.
 */
export class AutoTriggerScheduler {
  private timerId: number | null = null;
  private settings: AutoTriggerSettings;
  private mode: 'gate' | 'one-shot' = 'gate';
  private nextEvent: PendingGateEvent | null = null;

  constructor(
    private readonly context: AudioContext,
    private readonly target: GateTarget,
    initial: AutoTriggerSettings,
    private readonly tickMs = 25,
    private readonly lookaheadSec = 0.100
  ) {
    this.settings = this.sanitize(initial);
  }

  setSettings(next: AutoTriggerSettings): void {
    this.settings = this.sanitize(next);
  }

  setMode(mode: 'gate' | 'one-shot'): void { this.mode = mode; }

  start(startAt = this.context.currentTime + 0.020): void {
    this.stop(false);
    this.nextEvent = { kind: 'on', time: Math.max(startAt, this.context.currentTime + 0.020) };
    this.timerId = globalThis.setInterval(() => this.tick(), this.tickMs);
    this.tick();
  }

  stop(sendGateOff = true): void {
    if (this.timerId !== null) {
      globalThis.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.nextEvent = null;
    if (sendGateOff) {
      this.target.gateOff(this.context.currentTime);
    }
  }

  isRunning(): boolean {
    return this.timerId !== null;
  }

  private tick(): void {
    const horizon = this.context.currentTime + this.lookaheadSec;

    while (this.nextEvent !== null && this.nextEvent.time <= horizon) {
      const event = this.nextEvent;

      if (event.kind === 'on') {
        // Ton and Toff belong to one note cycle. UI changes after this point
        // are intentionally applied to the next Gate ON, not mid-note.
        const eventSettings = { ...this.settings };
        const oneShot = this.mode === 'one-shot';
        const repeat = eventSettings.oneShotRepeatSec!;
        this.target.gateOn(event.time);
        this.nextEvent = {
          kind: 'off',
          time: event.time + (oneShot ? Math.min(.05, repeat / 2) : eventSettings.tonSec),
          nextOnTime: event.time + (oneShot ? repeat : eventSettings.tonSec + eventSettings.toffSec)
        };
      } else {
        this.target.gateOff(event.time);
        this.nextEvent = { kind: 'on', time: event.nextOnTime };
      }
    }
  }

  private sanitize(value: AutoTriggerSettings): AutoTriggerSettings {
    return {
      tonSec: clamp(value.tonSec, LIMITS.triggerSec.min, LIMITS.triggerSec.max),
      toffSec: clamp(value.toffSec, LIMITS.triggerOffSec.min, LIMITS.triggerOffSec.max),
      oneShotRepeatSec: clamp(value.oneShotRepeatSec ?? value.tonSec + value.toffSec, .01, 6)
    };
  }
}
