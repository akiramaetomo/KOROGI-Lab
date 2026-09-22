import type { AudioEngine } from '../audio/core/AudioEngine';
import type { ChannelSynth } from '../audio/core/ChannelSynth';

/** Gesture ownership stays with the source pressed, even across selection/load changes. */
export class ManualGateController {
  private readonly held = new Map<string, { id: string; synth: ChannelSynth; started: boolean }>();
  private enabled = false;
  private blockedId: string | null = null;
  constructor(private readonly engine: () => AudioEngine | null, private readonly ensureRunning: (forceAttempt?: boolean) => Promise<void>, private readonly beforePress: (id: string) => void = () => {}) {
    window.addEventListener('keydown', event => {
      if (event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if ((event.target as Element | null)?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (!/^[1-8]$/.test(event.key)) return;
      if (this.press(`digit:${event.code}`, event.key)) event.preventDefault();
    });
    window.addEventListener('keyup', event => this.release(`digit:${event.code}`));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }
  setEnabled(enabled: boolean, release = true): void { this.enabled = enabled; if (!enabled && release) this.releaseAll(); }
  blockSource(id: string | null): void { this.blockedId = id; if (id) this.forgetSource(id); }
  bind(button: HTMLButtonElement, sourceId: () => string): void {
    const keyOwner = `button:${button.id}:key`;
    const prefix = `button:${button.id}:pointer:`;
    button.addEventListener('pointerdown', event => {
      if (button.disabled || event.button !== 0) return;
      if (this.press(prefix + event.pointerId, sourceId())) {
        event.preventDefault(); button.setPointerCapture(event.pointerId);
      }
    });
    const release = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' && this.engine()?.context.state !== 'running') void this.ensureRunning(true).catch(() => {});
      this.release(prefix + event.pointerId);
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    };
    button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', event => this.release(prefix + event.pointerId));
    button.addEventListener('keydown', event => {
      if (button.disabled || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.press(keyOwner, sourceId()); }
    });
    button.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.release(keyOwner); } });
    button.addEventListener('blur', () => this.release(keyOwner));
  }
  releaseAll(): void { [...this.held.keys()].forEach(owner => this.release(owner)); }
  forgetSource(id: string): void { [...this.held].filter(([, held]) => held.id === id).forEach(([owner]) => this.release(owner)); }
  private press(owner: string, id: string): boolean {
    const engine = this.engine(); const synth = engine?.getChannel(id);
    if (!this.enabled || id === this.blockedId || !engine || !synth || this.held.has(owner)) return false;
    this.beforePress(id);
    const gesture = { id, synth, started: false };
    this.held.set(owner, gesture);
    void this.ensureRunning().then(() => {
      if (!this.enabled || this.held.get(owner) !== gesture || this.engine()?.getChannel(id) !== synth) return;
      const alreadyStarted = [...this.held.values()].some(held => held !== gesture && held.synth === synth && held.started);
      gesture.started = true;
      if (!alreadyStarted) engine.gateOn(id);
    }).catch(() => this.release(owner));
    return true;
  }
  private release(owner: string): void {
    const held = this.held.get(owner); if (!held) return;
    this.held.delete(owner);
    const engine = this.engine();
    if (held.started && engine?.getChannel(held.id) === held.synth && ![...this.held.values()].some(other => other.synth === held.synth && other.started)) engine.gateOff(held.id);
  }
}
