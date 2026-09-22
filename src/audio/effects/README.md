# effects

`EffectSlot.ts` implements one effect slot with stable input/output nodes and retained settings independent of its ON/OFF switch.
`ChannelSynth` owns source FX1 after the fixed -18 dB reference input. `AudioEngine` owns post-FX1 instance level, stereo pan, and sends before each Near/Far stereo summation; serial FX2 / FX3 and the final crossfade follow on the common buses.
All three roles retain every effect type for research use; their standard uses are distortion, chorus/delay, and reverb.
Current types: OFF / Distortion / Delay / Chorus / Reverb.
The current architecture is documented in [Lab設計](../../../docs/設計.md).
