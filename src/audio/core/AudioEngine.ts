import { ChannelSynth } from './ChannelSynth';
import { WhiteNoiseFactory } from '../dsp/WhiteNoiseFactory';
import { EffectSlot } from '../effects/EffectSlot';
import { LIMITS, PARAM_SMOOTH_SEC } from '../constants';
import { clamp, dbToGain, smoothAudioParam } from '../dsp/params';
import { defaultBus, defaultTimbre, DEFAULT_CHANNEL_MIX, normalizeSession, normalizeTimbre } from '../../model/documents';
import { normalizeTriggerRecording, patternRecording } from '../../model/triggerRecording';
import { PARAMETER_RANGES as P } from '../../config/parameterRanges';
import type { BusAssignment, BusEffectSlotIndex, BusSettings, ChannelMixSettings, EffectParameter, EffectSlotSettings, EffectType, MasterInputMode, PlaybackSource, SessionChannel, SessionDocument, TimbreDocument, TriggerRecording, UserPattern, UserPatternId } from '../types';

export function equalPower(position: number): [number, number] {
  const u = clamp(position, 0, 1);
  if (u === 0) return [1, 0];
  if (u === 1) return [0, 1];
  return [Math.cos(Math.PI * u / 2), Math.sin(Math.PI * u / 2)];
}

class SpaceBus {
  readonly input: GainNode;
  readonly effects: [EffectSlot, EffectSlot];
  readonly gain: GainNode;
  readonly crossfade: GainNode;
  private gainDb: number;
  private gainEnabled: boolean;
  constructor(private readonly context: AudioContext, id: BusAssignment, settings: BusSettings) {
    this.input = context.createGain();
    this.effects = [new EffectSlot(context, `${id}-fx2`, settings.effects[0]), new EffectSlot(context, `${id}-fx3`, settings.effects[1])];
    this.gain = context.createGain(); this.crossfade = context.createGain();
    // A bus is a stereo pair even when a single mono source reaches its Σ.
    for (const node of [this.input, this.gain, this.crossfade]) {
      node.channelCount = 2; node.channelCountMode = 'explicit';
    }
    this.gainDb = settings.gainDb; this.gainEnabled = settings.gainEnabled;
    this.gain.gain.value = this.gainEnabled ? dbToGain(this.gainDb) : 1;
    this.input.connect(this.effects[0].input); this.effects[0].output.connect(this.effects[1].input);
    this.effects[1].output.connect(this.gain); this.gain.connect(this.crossfade);
  }
  setGain(db: number): void {
    if (!Number.isFinite(db)) throw new Error('Invalid bus gain.');
    this.gainDb = clamp(db, LIMITS.busGainDb.min, LIMITS.busGainDb.max);
    smoothAudioParam(this.gain.gain, this.gainEnabled ? dbToGain(this.gainDb) : 1, this.context.currentTime, PARAM_SMOOTH_SEC);
  }
  setGainEnabled(enabled: boolean): void { this.gainEnabled = enabled; this.setGain(this.gainDb); }
  settings(): BusSettings { return { gainDb: this.gainDb, gainEnabled: this.gainEnabled, effects: [this.effects[0].getSettings(), this.effects[1].getSettings()] }; }
  dispose(): void { this.input.disconnect(); this.gain.disconnect(); this.crossfade.disconnect(); this.effects.forEach(fx => fx.dispose()); }
}

/** Post-FX1 controls are instance/mix state, not sound-design state. */
class ChannelStrip {
  readonly synth: ChannelSynth;
  readonly fader: GainNode;
  readonly panner: StereoPannerNode;
  readonly sends: [GainNode, GainNode];
  readonly directTap: GainNode;
  name: string;
  patterns: UserPattern[];
  playbackSource: PlaybackSource;
  mix: ChannelMixSettings;
  private active = false;
  private directSelected = false;
  private disposed = false;
  constructor(private readonly context: AudioContext, noise: WhiteNoiseFactory, id: string, timbre: TimbreDocument, mix: ChannelMixSettings,
    buses: Record<BusAssignment, SpaceBus>, directInput: AudioNode) {
    this.name = timbre.name; this.patterns = structuredClone(timbre.patterns); this.playbackSource = structuredClone(timbre.playbackSource);
    this.mix = { gainDb: mix.gainDb, muted: mix.muted, balance: mix.balance, pan: mix.pan };
    this.synth = new ChannelSynth(context, noise, timbre.settings, timbre.detuneNormalized, id);
    this.synth.setDetuneRangeCent(timbre.detuneRangeCent);
    this.fader = context.createGain(); this.fader.gain.value = 0;
    this.panner = context.createStereoPanner(); this.panner.pan.value = mix.pan;
    this.sends = [context.createGain(), context.createGain()];
    this.directTap = context.createGain(); this.directTap.gain.value = 0;
    const gains = equalPower(mix.balance);
    this.sends.forEach((send, i) => { send.gain.value = gains[i]!; this.panner.connect(send); });
    this.synth.output.connect(this.fader);
    this.synth.output.connect(this.directTap); this.directTap.connect(directInput);
    this.fader.connect(this.panner);
    this.sends[0].connect(buses.near.input); this.sends[1].connect(buses.far.input);
  }
  activate(): void { this.active = true; this.setMix(this.mix); this.updateDirect(); }
  setDirectSelected(selected: boolean): void { this.directSelected = selected; this.updateDirect(); }
  setMix(settings: ChannelMixSettings): void {
    this.mix = { gainDb: clamp(settings.gainDb, LIMITS.channelLevelDb.min, LIMITS.channelLevelDb.max), muted: settings.muted,
      balance: clamp(settings.balance, P.balance.min, P.balance.max), pan: clamp(settings.pan, P.pan.min, P.pan.max) };
    const now = this.context.currentTime;
    smoothAudioParam(this.fader.gain, this.active && !this.mix.muted ? dbToGain(this.mix.gainDb) : 0, now, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.panner.pan, this.mix.pan, now, PARAM_SMOOTH_SEC);
    equalPower(this.mix.balance).forEach((gain, i) => smoothAudioParam(this.sends[i]!.gain, gain, now, PARAM_SMOOTH_SEC));
  }
  timbre(): TimbreDocument {
    return { formatVersion: 'KOROGI-Lab/timbre-v7', name: this.name, settings: this.synth.getSettings(), detuneRangeCent: this.synth.getDetuneRangeCent(), detuneNormalized: this.synth.getDetuneNormalized(), patterns: structuredClone(this.patterns), playbackSource: structuredClone(this.playbackSource) };
  }
  fadeOut(): void {
    smoothAudioParam(this.fader.gain, 0, this.context.currentTime, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.directTap.gain, 0, this.context.currentTime, PARAM_SMOOTH_SEC);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.synth.dispose(); this.fader.disconnect(); this.directTap.disconnect(); this.panner.disconnect(); this.sends.forEach(send => send.disconnect());
  }
  private updateDirect(): void { smoothAudioParam(this.directTap.gain, this.active && this.directSelected ? 1 : 0, this.context.currentTime, PARAM_SMOOTH_SEC); }
}

interface AudioGraph {
  buses: Record<BusAssignment, SpaceBus>;
  strips: Map<string, ChannelStrip>;
  slots: SessionChannel[];
}

/** DOM-independent runtime. Channel topology belongs to the caller, not the DSP. */
export class AudioEngine {
  readonly context: AudioContext;
  readonly output: DynamicsCompressorNode;
  readonly preLimiterOutput: GainNode;
  private readonly noise: WhiteNoiseFactory;
  private readonly masterGain: GainNode;
  private readonly commonMonitorGain: GainNode;
  private readonly directMonitorGain: GainNode;
  private graph: AudioGraph;
  private crossfade = P.crossfade.defaultValue / 100;
  private masterGainDb = -18;
  private masterMuted = false;
  private masterInputMode: MasterInputMode = 'common-space';
  private directMonitorId: string | null = null;
  private busy = false;
  private disposed = false;
  private sourcesStartedWhileSuspended: boolean;
  private readonly retired = new Map<ChannelStrip, ReturnType<typeof setTimeout>>();
  constructor(context = new AudioContext(), initial?: SessionDocument) {
    this.context = context; this.noise = new WhiteNoiseFactory(context);
    this.sourcesStartedWhileSuspended = context.state !== 'running';
    this.commonMonitorGain = context.createGain(); this.directMonitorGain = context.createGain();
    this.masterGain = context.createGain(); this.preLimiterOutput = context.createGain(); this.output = context.createDynamicsCompressor();
    for (const node of [this.commonMonitorGain, this.directMonitorGain, this.masterGain, this.preLimiterOutput]) {
      node.channelCount = 2; node.channelCountMode = 'explicit';
    }
    this.commonMonitorGain.gain.value = 1; this.directMonitorGain.gain.value = 0;
    this.output.threshold.value = -3; this.output.knee.value = 0; this.output.ratio.value = 20;
    this.output.attack.value = .003; this.output.release.value = .1;
    const session = normalizeSession(initial ?? {
      formatVersion: 'KOROGI-Lab/session-v8', name: 'Untitled', savedAt: '', channels: [{ id: '1', ...DEFAULT_CHANNEL_MIX, timbre: defaultTimbre() }],
      near: defaultBus(), far: defaultBus(), crossfade: P.crossfade.defaultValue / 100, masterGainDb: P['master-gain'].defaultValue, masterMuted: false
    });
    this.graph = this.prepareGraph(session);
    this.crossfade = session.crossfade; this.masterGainDb = session.masterGainDb; this.masterMuted = session.masterMuted;
    this.masterGain.gain.value = dbToGain(this.masterGainDb); this.preLimiterOutput.gain.value = this.masterMuted ? 0 : 1;
    this.connectGraph(this.graph);
    this.commonMonitorGain.connect(this.masterGain); this.directMonitorGain.connect(this.masterGain);
    this.masterGain.connect(this.preLimiterOutput); this.preLimiterOutput.connect(this.output); this.output.connect(context.destination);
  }
  getChannel(id: string): ChannelSynth | undefined { return this.graph.strips.get(id)?.synth; }
  getChannelIds(): string[] { return this.graph.slots.map(slot => slot.id); }
  getChannelMix(id: string): ChannelMixSettings { const slot = this.slot(id); return { gainDb: slot.gainDb, muted: slot.muted, balance: slot.balance, pan: slot.pan }; }
  setChannelMix(id: string, changes: Partial<ChannelMixSettings>): void {
    this.assertReady(); const slot = this.slot(id); const mix = { ...this.getChannelMix(id), ...changes };
    if (!Number.isFinite(mix.gainDb) || !Number.isFinite(mix.balance) || !Number.isFinite(mix.pan) || typeof mix.muted !== 'boolean') throw new Error('Invalid channel mix.');
    slot.gainDb = clamp(mix.gainDb, LIMITS.channelLevelDb.min, LIMITS.channelLevelDb.max); slot.balance = clamp(mix.balance, P.balance.min, P.balance.max); slot.pan = clamp(mix.pan, P.pan.min, P.pan.max); slot.muted = mix.muted;
    this.graph.strips.get(id)?.setMix(this.getChannelMix(id));
  }
  replaceChannel(id: string, raw: TimbreDocument): void {
    this.assertReady(); const timbre = normalizeTimbre(raw); const existing = this.graph.slots.find(slot => slot.id === id);
    if (!id.trim()) throw new Error('Channel ID is empty.');
    const slot = existing ?? { id, ...DEFAULT_CHANNEL_MIX, timbre: null };
    const candidate = new ChannelStrip(this.context, this.noise, id, timbre, slot, this.graph.buses, this.directMonitorGain);
    candidate.setDirectSelected(this.directMonitorId === id);
    const old = this.graph.strips.get(id);
    if (!existing) this.graph.slots.push(slot);
    slot.timbre = timbre; this.graph.strips.set(id, candidate);
    if (old) this.retire(old);
  }
  clearChannel(id: string): void {
    this.assertReady(); const slot = this.slot(id); slot.timbre = null;
    const old = this.graph.strips.get(id); this.graph.strips.delete(id); if (old) this.retire(old);
  }
  removeChannel(id: string): void { this.clearChannel(id); this.graph.slots = this.graph.slots.filter(slot => slot.id !== id); }
  setTimbreName(id: string, name: string): void { this.assertReady(); this.strip(id).name = name.trim() || 'Untitled'; }
  createTimbre(id: string): TimbreDocument { return this.strip(id).timbre(); }
  getPlaybackSource(id: string): PlaybackSource { return structuredClone(this.strip(id).playbackSource); }
  getRecording(id: string, patternId: UserPatternId): TriggerRecording | null { return structuredClone(patternRecording(this.strip(id).patterns, patternId)); }
  setRecording(id: string, patternId: UserPatternId, raw: TriggerRecording | null): void {
    this.assertReady(); const strip = this.strip(id); const pattern = strip.patterns.find(item => item.id === patternId);
    if (!pattern) throw new Error(`Unknown User pattern: ${patternId}`);
    pattern.recording = normalizeTriggerRecording(raw);
  }
  setPlaybackSource(id: string, source: PlaybackSource): void { this.assertReady(); this.strip(id).playbackSource = structuredClone(source); }
  gateOn(id: string, time = this.context.currentTime): void { this.assertReady(); const strip = this.strip(id); strip.activate(); strip.synth.gateOn(time); }
  gateOff(id: string, time = this.context.currentTime): void { if (!this.disposed && !this.busy) this.graph.strips.get(id)?.synth.gateOff(time); }
  triggerGateOn(id: string): void { this.assertReady(); const strip = this.strip(id); strip.activate(); strip.synth.triggerGateOn(); }
  triggerGateOff(id: string): void { if (!this.disposed && !this.busy) this.graph.strips.get(id)?.synth.triggerGateOff(); }
  cancelScheduledGates(id: string): void { if (!this.disposed && !this.busy) this.graph.strips.get(id)?.synth.cancelScheduledGates(); }
  cancelScheduledGatesFrom(id: string, time: number): void { if (!this.disposed && !this.busy) this.graph.strips.get(id)?.synth.cancelScheduledGatesFrom(time); }
  startAuto(id: string, startAt?: number): void { this.assertReady(); const strip = this.strip(id); strip.activate(); strip.synth.startAutoTrigger(startAt); }
  stopAuto(id: string): void { if (!this.disposed && !this.busy) this.graph.strips.get(id)?.synth.stopAutoTrigger(); }
  setCrossfade(position: number): void {
    this.assertReady(); if (!Number.isFinite(position)) throw new Error('Invalid crossfade.'); this.crossfade = clamp(position, P.crossfade.min / 100, P.crossfade.max / 100);
    equalPower(this.crossfade).forEach((gain, i) => smoothAudioParam(this.graph.buses[i === 0 ? 'near' : 'far'].crossfade.gain, gain, this.context.currentTime, PARAM_SMOOTH_SEC));
  }
  getCrossfade(): number { return this.crossfade; }
  setMixGainDb(bus: BusAssignment, db: number): void { this.assertReady(); this.graph.buses[bus].setGain(db); }
  setMixGainEnabled(bus: BusAssignment, enabled: boolean): void { this.assertReady(); this.graph.buses[bus].setGainEnabled(enabled); }
  isMixGainEnabled(bus: BusAssignment): boolean { return this.graph.buses[bus].settings().gainEnabled; }
  getBusSettings(bus: BusAssignment): BusSettings { return this.graph.buses[bus].settings(); }
  setBusEffectEnabled(bus: BusAssignment, slot: BusEffectSlotIndex, enabled: boolean): void { this.assertReady(); this.effectSlot(bus, slot).setEnabled(enabled); }
  async setBusEffectType(bus: BusAssignment, slot: BusEffectSlotIndex, type: EffectType): Promise<void> { this.assertReady(); await this.effectSlot(bus, slot).setType(type); }
  setBusEffectParameter(bus: BusAssignment, slot: BusEffectSlotIndex, parameter: EffectParameter, value: number): void { this.assertReady(); this.effectSlot(bus, slot).setParameter(parameter, value); }
  getBusEffectSettings(bus: BusAssignment, slot: BusEffectSlotIndex): EffectSlotSettings { return this.effectSlot(bus, slot).getSettings(); }
  setMasterInputMode(mode: MasterInputMode): void {
    this.assertReady(); this.masterInputMode = mode;
    const gains = equalPower(mode === 'fx1-direct' ? 1 : 0);
    smoothAudioParam(this.commonMonitorGain.gain, gains[0], this.context.currentTime, PARAM_SMOOTH_SEC);
    smoothAudioParam(this.directMonitorGain.gain, gains[1], this.context.currentTime, PARAM_SMOOTH_SEC);
  }
  getMasterInputMode(): MasterInputMode { return this.masterInputMode; }
  setDirectMonitorId(id: string | null): void {
    this.assertReady(); this.directMonitorId = id;
    this.graph.strips.forEach((strip, stripId) => strip.setDirectSelected(stripId === id));
  }
  setMasterGainDb(db: number): void {
    this.assertReady(); if (!Number.isFinite(db)) throw new Error('Invalid master gain.'); this.masterGainDb = clamp(db, -60, 0);
    smoothAudioParam(this.masterGain.gain, dbToGain(this.masterGainDb), this.context.currentTime, PARAM_SMOOTH_SEC);
  }
  getMasterGainDb(): number { return this.masterGainDb; }
  setMasterMuted(muted: boolean): void { this.assertReady(); this.masterMuted = muted; smoothAudioParam(this.preLimiterOutput.gain, muted ? 0 : 1, this.context.currentTime, PARAM_SMOOTH_SEC); }
  isMasterMuted(): boolean { return this.masterMuted; }
  createSession(name: string): SessionDocument {
    return { formatVersion: 'KOROGI-Lab/session-v8', name: name.trim() || 'Untitled', savedAt: new Date().toISOString(),
      channels: this.graph.slots.map(slot => ({ id: slot.id, ...this.getChannelMix(slot.id), timbre: this.graph.strips.get(slot.id)?.timbre() ?? null })),
      near: this.getBusSettings('near'), far: this.getBusSettings('far'), crossfade: this.crossfade, masterGainDb: this.masterGainDb, masterMuted: this.masterMuted };
  }
  async applySession(raw: SessionDocument): Promise<void> {
    this.assertReady(); const session = normalizeSession(raw); const candidate = this.prepareGraph(session);
    this.busy = true; smoothAudioParam(this.preLimiterOutput.gain, 0, this.context.currentTime, PARAM_SMOOTH_SEC);
    await new Promise<void>(resolve => globalThis.setTimeout(resolve, PARAM_SMOOTH_SEC * 1000 + 2));
    if (this.disposed) { this.disposeGraph(candidate); this.busy = false; return; }
    const old = this.graph; this.graph = candidate; this.connectGraph(candidate); this.disposeGraph(old); this.disposeRetired();
    this.crossfade = session.crossfade; this.masterGainDb = session.masterGainDb; this.masterMuted = session.masterMuted;
    this.masterInputMode = 'common-space'; this.directMonitorId = null;
    this.graph.strips.forEach(strip => strip.setDirectSelected(false));
    this.busy = false; this.setMasterGainDb(this.masterGainDb); this.setMasterMuted(this.masterMuted); this.setMasterInputMode('common-space');
  }
  async start(): Promise<void> {
    if (this.context.state !== 'running') await this.context.resume();
    if (this.sourcesStartedWhileSuspended && this.context.state === 'running') {
      this.graph.strips.forEach(strip => strip.synth.restartSourcesAfterContextResume());
      this.sourcesStartedWhileSuspended = false;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.disposeGraph(this.graph); this.disposeRetired(); this.commonMonitorGain.disconnect(); this.directMonitorGain.disconnect(); this.masterGain.disconnect(); this.preLimiterOutput.disconnect(); this.output.disconnect();
  }
  async close(): Promise<void> { this.dispose(); await this.context.close(); }
  private slot(id: string): SessionChannel { const slot = this.graph.slots.find(slot => slot.id === id); if (!slot) throw new Error(`Unknown channel: ${id}`); return slot; }
  private strip(id: string): ChannelStrip { const strip = this.graph.strips.get(id); if (!strip) throw new Error(`Empty channel: ${id}`); return strip; }
  private effectSlot(bus: BusAssignment, slot: BusEffectSlotIndex): EffectSlot {
    if (slot !== 2 && slot !== 3) throw new Error('Bus slots are FX2 and FX3.'); return this.graph.buses[bus].effects[slot - 2]!;
  }
  private prepareGraph(session: SessionDocument): AudioGraph {
    const buses = {} as Record<BusAssignment, SpaceBus>;
    const graph: AudioGraph = { buses, strips: new Map(), slots: structuredClone(session.channels) };
    try {
      buses.near = new SpaceBus(this.context, 'near', session.near); buses.far = new SpaceBus(this.context, 'far', session.far);
      equalPower(session.crossfade).forEach((gain, i) => { buses[i === 0 ? 'near' : 'far'].crossfade.gain.value = gain; });
      for (const slot of graph.slots) if (slot.timbre) {
        const strip = new ChannelStrip(this.context, this.noise, slot.id, slot.timbre, slot, buses, this.directMonitorGain);
        strip.setDirectSelected(this.directMonitorId === slot.id); graph.strips.set(slot.id, strip);
      }
      return graph;
    } catch (error) { this.disposeGraph(graph); throw error; }
  }
  private connectGraph(graph: AudioGraph): void { Object.values(graph.buses).forEach(bus => bus.crossfade.connect(this.commonMonitorGain)); }
  private disposeGraph(graph: AudioGraph): void { graph.strips.forEach(strip => strip.dispose()); Object.values(graph.buses).forEach(bus => bus.dispose()); }
  private retire(strip: ChannelStrip): void {
    strip.synth.stopAutoTrigger(); strip.synth.gateOff(); strip.fadeOut();
    this.retired.set(strip, globalThis.setTimeout(() => { strip.dispose(); this.retired.delete(strip); }, PARAM_SMOOTH_SEC * 1000 + 2));
  }
  private disposeRetired(): void { this.retired.forEach((timer, strip) => { globalThis.clearTimeout(timer); strip.dispose(); }); this.retired.clear(); }
  private assertReady(): void { if (this.disposed || this.busy) throw new Error(this.disposed ? 'Audio engine is disposed.' : 'Session load is in progress.'); }
}
