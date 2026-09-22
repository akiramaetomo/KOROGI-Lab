import { LIMITS } from '../constants';
import { clamp } from '../dsp/params';
import type { BurstSettings } from '../types';

export interface BurstTarget {
  pulse(time: number, displayOffTime: number): void;
  cancelFrom(time: number): void;
}

interface ScheduledGroup { start: number; end: number }

/**
 * Main-thread lookahead scheduler for Timbre articulation.
 * Input Gate edges define a phrase window; output events are AEnv One-shot ONs.
 */
export class BurstScheduler {
  private settings: BurstSettings;
  private timerId: number | null = null;
  private phraseOn = false;
  private nextGroupStart: number | null = null;
  private groups: ScheduledGroup[] = [];

  constructor(
    private readonly context: AudioContext,
    private readonly target: BurstTarget,
    initial: BurstSettings,
    private readonly random: () => number = Math.random,
    private readonly tickMs = 15,
    private readonly lookaheadSec = .100
  ) { this.settings = this.sanitize(initial); }

  setSettings(next: BurstSettings): void {
    this.settings = this.sanitize(next);
    if (!this.phraseOn) return;
    const now = this.context.currentTime;
    const nextGroup = this.groups.find(group => group.start > now);
    if (nextGroup) {
      this.target.cancelFrom(nextGroup.start);
      this.groups = this.groups.filter(group => group.start < nextGroup.start);
      this.nextGroupStart = nextGroup.start;
      this.tick();
    }
  }

  gateOn(time = this.context.currentTime): void {
    if (this.phraseOn) return;
    this.phraseOn = true;
    this.nextGroupStart = Math.max(time, this.context.currentTime);
    this.ensureTimer();
    this.tick();
  }

  /** Stop new groups, but retain every pulse belonging to a group started before OFF. */
  gateOff(time = this.context.currentTime): void {
    if (!this.phraseOn) return;
    this.phraseOn = false;
    const boundary = this.groups.find(group => group.start >= time)?.start;
    if (boundary !== undefined) {
      this.target.cancelFrom(boundary);
      this.groups = this.groups.filter(group => group.start < boundary);
    }
    this.nextGroupStart = null;
    this.clearTimer();
  }

  /** Lifecycle cancellation: discard every unstarted group at or after the boundary. */
  cancelFrom(time: number): void {
    const boundary = Math.max(time, this.context.currentTime);
    this.target.cancelFrom(boundary);
    this.groups = this.groups.filter(group => group.start < boundary);
    if (this.nextGroupStart !== null && this.nextGroupStart >= boundary) this.nextGroupStart = null;
  }

  stop(): void {
    this.phraseOn = false;
    this.nextGroupStart = null;
    this.groups = [];
    this.clearTimer();
  }

  isRunning(): boolean { return this.phraseOn; }

  private ensureTimer(): void {
    if (this.timerId === null) this.timerId = globalThis.setInterval(() => this.tick(), this.tickMs);
  }

  private clearTimer(): void {
    if (this.timerId !== null) globalThis.clearInterval(this.timerId);
    this.timerId = null;
  }

  private tick(): void {
    if (!this.phraseOn || this.nextGroupStart === null) return;
    const horizon = this.context.currentTime + this.lookaheadSec;
    while (this.nextGroupStart <= horizon) {
      const settings = { ...this.settings };
      const start = this.nextGroupStart;
      const count = settings.pulseCountMin + Math.floor(this.unitRandom() * (settings.pulseCountMax - settings.pulseCountMin + 1));
      const pulses = [start];
      for (let index = 1; index < count; index += 1) {
        const interval = Math.max(LIMITS.burstPulseIntervalSec.min,
          settings.pulseIntervalSec * this.jitter(settings.pulseIntervalJitter));
        pulses.push(pulses.at(-1)! + interval);
      }
      const end = pulses.at(-1)!;
      const targetPeriod = settings.groupPeriodSec * this.jitter(settings.groupPeriodJitter);
      const nextGroupStart = Math.max(start + targetPeriod, end + LIMITS.triggerOffSec.min);
      pulses.forEach((time, index) => {
        const next = pulses[index + 1] ?? nextGroupStart;
        this.target.pulse(time, time + Math.min(.05, (next - time) / 2));
      });
      this.groups.push({ start, end });
      this.nextGroupStart = nextGroupStart;
    }
    const now = this.context.currentTime;
    this.groups = this.groups.filter(group => group.end >= now - this.lookaheadSec);
  }

  private jitter(amount: number): number { return 1 + (this.unitRandom() * 2 - 1) * amount; }
  private unitRandom(): number { return Math.min(1 - Number.EPSILON, Math.max(0, this.random())); }

  private sanitize(value: BurstSettings): BurstSettings {
    const min = Math.round(clamp(value.pulseCountMin, LIMITS.burstCount.min, LIMITS.burstCount.max));
    const max = Math.round(clamp(value.pulseCountMax, min, LIMITS.burstCount.max));
    return {
      enabled: !!value.enabled,
      pulseCountMin: min,
      pulseCountMax: max,
      pulseIntervalSec: clamp(value.pulseIntervalSec, LIMITS.burstPulseIntervalSec.min, LIMITS.burstPulseIntervalSec.max),
      pulseIntervalJitter: clamp(value.pulseIntervalJitter, LIMITS.burstJitter.min, LIMITS.burstJitter.max),
      groupPeriodSec: clamp(value.groupPeriodSec, LIMITS.burstGroupPeriodSec.min, LIMITS.burstGroupPeriodSec.max),
      groupPeriodJitter: clamp(value.groupPeriodJitter, LIMITS.burstJitter.min, LIMITS.burstJitter.max)
    };
  }
}
