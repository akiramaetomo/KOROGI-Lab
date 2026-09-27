import { LIMITS } from '../constants';
import type { AutoTriggerSettings } from '../types';
import { clamp } from '../dsp/params';
import { PARAMETER_RANGES as P } from '../../config/parameterRanges';

export interface GateTarget {
  gateOn(time: number): void;
  gateOff(time: number): void;
  cancelFrom?(time: number): void;
}

type PendingGateEvent =
  | { kind: 'on'; time: number }
  | { kind: 'off'; time: number; nextOnTime: number };

interface ScheduledCycle {
  onTime: number;
  offTime: number;
  nextOnTime: number;
}

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
  private nextEvent: PendingGateEvent | null = null;
  private playSpeed = 1;
  private readonly cycles: ScheduledCycle[] = [];

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

  start(startAt = this.context.currentTime + 0.020, playSpeed = 1): void {
    this.stop(false);
    this.playSpeed = this.sanitizeSpeed(playSpeed);
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
    this.cycles.length = 0;
    if (sendGateOff) {
      this.target.gateOff(this.context.currentTime);
    }
  }

  isRunning(): boolean {
    return this.timerId !== null;
  }

  /** Retimes the active cycle at its current stored-time phase. */
  setPlaybackSpeed(next: number): void {
    const speed = this.sanitizeSpeed(next);
    if (speed === this.playSpeed) return;
    if (!this.isRunning()) { this.playSpeed = speed; return; }
    const now = this.context.currentTime;
    const cycle = this.cycles.find(item => item.onTime <= now && now < item.nextOnTime);
    const futureStart = this.cycles.find(item => now < item.onTime)?.onTime
      ?? (this.nextEvent?.kind === 'on' && this.nextEvent.time > now ? this.nextEvent.time : null);
    this.target.cancelFrom?.(now);
    if (!cycle) {
      this.playSpeed = speed;
      if (futureStart !== null) this.nextEvent = { kind: 'on', time: futureStart };
      this.cycles.length = 0;
      this.tick();
      return;
    }
    const phase = (now - cycle.onTime) * this.playSpeed;
    const onDuration = (cycle.offTime - cycle.onTime) * this.playSpeed;
    const period = (cycle.nextOnTime - cycle.onTime) * this.playSpeed;
    this.playSpeed = speed;
    this.cycles.length = 0;
    if (phase < onDuration) {
      this.target.gateOn(now);
      const offTime = now + (onDuration - phase) / speed;
      const nextOnTime = now + (period - phase) / speed;
      this.nextEvent = offTime < nextOnTime ? { kind: 'off', time: offTime, nextOnTime }
        : { kind: 'on', time: nextOnTime };
    } else {
      this.target.gateOff(now);
      this.nextEvent = { kind: 'on', time: now + (period - phase) / speed };
    }
    this.tick();
  }

  private tick(): void {
    const horizon = this.context.currentTime + this.lookaheadSec;
    while (this.cycles.length > 1 && this.cycles[1]!.onTime <= this.context.currentTime) this.cycles.shift();

    while (this.nextEvent !== null && this.nextEvent.time <= horizon) {
      const event = this.nextEvent;

      if (event.kind === 'on') {
        // Ton and Toff belong to one note cycle. UI changes after this point
        // are intentionally applied to the next Gate ON, not mid-note.
        const eventSettings = { ...this.settings };
        const onDuration = eventSettings.tonSec;
        const period = eventSettings.repeatSec;
        const offTime = event.time + onDuration / this.playSpeed;
        const nextOnTime = event.time + period / this.playSpeed;
        this.target.gateOn(event.time);
        this.cycles.push({ onTime: event.time, offTime, nextOnTime });
        this.nextEvent = offTime < nextOnTime ? { kind: 'off', time: offTime, nextOnTime }
          : { kind: 'on', time: nextOnTime };
      } else {
        this.target.gateOff(event.time);
        this.nextEvent = { kind: 'on', time: event.nextOnTime };
      }
    }
  }

  private sanitize(value: AutoTriggerSettings): AutoTriggerSettings {
    return {
      tonSec: clamp(value.tonSec, LIMITS.triggerSec.min, LIMITS.triggerSec.max),
      repeatSec: clamp(value.repeatSec, P.trepeat.min / 1000, P.trepeat.max / 1000)
    };
  }

  private sanitizeSpeed(value: number): number {
    if (!Number.isFinite(value)) throw new Error('Invalid sequence play speed.');
    return clamp(value, P['sequence-play-speed'].min, P['sequence-play-speed'].max);
  }
}
