export class WhiteNoiseFactory {
  constructor(private readonly context: AudioContext, private readonly durationSec = 4) {}

  createLoopingSource(): AudioBufferSourceNode {
    // A fresh buffer per source prevents OSC1/OSC2 and future channels from
    // sharing an identical noise sequence/phase.
    const frameCount = Math.max(1, Math.ceil(this.context.sampleRate * this.durationSec));
    const buffer = this.context.createBuffer(1, frameCount, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i += 1) {
      channel[i] = Math.random() * 2 - 1;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }
}
