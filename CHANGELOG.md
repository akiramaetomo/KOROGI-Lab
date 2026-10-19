# Changelog

## 0.5.0-rc.1 — 2026-10-20 — OSC Multi and OSC2 audio routes Pages candidate

- OSC1 / OSC2 can be Single or Multi: Multi sums 1–16 oscillators of the same waveform, defined by Spread (count, ± cent) or by a Table of Hz and amplitude with paste/copy. Partials keep their ratio to Base Frequency, so PEnv, Detune, Sequence Pitch and FM move them together.
- FILTER2 Destination adds AEnv IN and AEnv OUT, so the OSC2 path can be heard: AEnv IN mixes it at the AEnv1 input, AEnv OUT sends it through a new AEnv2 (own Gate/One-shot, retriggered by BURST pulses) and mixes it after AEnv1.
- A single Balance sets the OSC1 / OSC2 mix in the audio routes, and FEnv reaches Filter2 through a signed Depth (−100…+100 % of Amount, default 0).
- The TIMBRE map is three symmetric rows: OSC1 path on top, PEnv / FEnv / BURST in the middle, OSC2 path below.
- Save formats move to timbre-v20 / session-v23; older files load with their sound unchanged. 0.4.0-rc.1 and earlier cannot read the new files.
- Publish as a release candidate; known: SYNC restarts keep the previous oscillator set running for about 50 ms, multiplied by the Multi count.

## 0.4.0-rc.1 — 2026-10-19 — Bars looper, Loop / Chain and SONG grid Pages candidate

- One Seconds | Bars time mode for the whole app; the app starts in Bars. Bars accepts fractional Pattern lengths (1/2–1/16) and up to 32 bars from a menu.
- In Bars, playback and recording stretch each selection to its Pattern length on one shared BPM bar grid, with record Grid lines, a click and bar-aligned backing; a recording joins a playing grid at the next bar head.
- Pitch settings and Separate stay editable while recording; Song BPM is locked while recording.
- SongFrame: each timbre keeps its own Pattern length, and the Song has one Frame per Session. `⚠ Loops drift` warns only for periods that are not whole multiples.
- SONG grid of Timbre × Pattern: choose Patterns for the Song, jump from a cell or a timbre name to SEQUENCE, and see what Play plays. Pattern edits apply while the Song plays.
- Looper-first SEQUENCE: a header SEQUENCE button, and Loop / Chain at the top of SONG in place of the header Play All.
- Copy Pattern carries Pattern bars; Timbre Clear sits away from Mute and Clear/Init ask for confirmation.
- FILES opens as a dialog, and results show in a header status line.
- Logarithmic PEnv is scheduled with linear ramps, fixing a hang when changing Song BPM during playback.
- Save formats move to timbre-v18 / session-v21; older files are migrated on load.
- Publish as a release candidate pending full real-device and listening acceptance.

## 0.3.0-rc.2 — 2026-10-09 — Sequence Mute and Song BPM Pages candidate

- Lane Mute silences output only; Gate/Pitch loop clocks, cursors and phase keep running in Play, Play All and Song.
- Song BPM is 30–480; Bars timing shows a BPM field and slider in place of Song Speed, which now applies to Seconds timing only.
- Move Copy Pattern into the PATTERN / RECORD / PLAY panel, glow the current Song Pattern, and note when looping timbres drift.
- Pitch Scale spans −2400…+2400 cent symmetrically; Record Write defaults to Overdub; Gate Quantize returns above the Gate timeline.
- Keep the last OSC/Filter structure request during the shared fade, and report the legacy PEnv notice only for timbres before v10.
- Keep timbre-v17 / session-v20.
- Publish as a release candidate pending real-device and listening acceptance.

## 0.3.0-rc.1 — 2026-10-07 — Sequence editing and layout Pages candidate

- Add Gate quantization (Bars timing), Separate Gate control with controller lane ownership, and refined loop recording takes.
- Reorganize SEQUENCE into one PATTERN / RECORD / PLAY panel; default Record to Both and fold Gate Quantize.
- Support iPad Air portrait (820×1180) as the lower display bound with a Map toggle for the signal map.
- Compact Small, Near and Far numeric controls into caption/value, bounds and slider rows.
- Stack up to three cards per column, emphasize the drop target, and grey out OFF cards.
- Add a TIMBRES toggle and tap-to-restore on the collapsed TIMBRES divider.
- Keep timbre-v17 / session-v20; files with three-card columns are rejected by 0.2.0-rc.1.
- Publish as a release candidate pending real-device and listening acceptance.

## 0.2.0-rc.1 — 2026-10-02 — Sequence and Song Pages candidate

- Add USER 1–8 Gate/Pitch patterns, recording, copying, and cyclic Song playback.
- Fit selected Gate and Pitch intervals to Song Bars; provide BPM and Song Speed controls.
- Save session-v20 and display the candidate version with the build commit.
- Publish as a release candidate pending real-device and listening acceptance.

## 0.1.0 — 2026-09-23 — Initial public release

- Completed the first KOROGI-Lab phase with eight independent Timbres and shared stereo Near/Far processing.
- Added Manual, Auto, User 1 and User 2 Gate playback, recording and loop-range control.
- Added Timbre BURST articulation, phase SYNC/FREE, FX1 direct monitoring and three bundled Demo Sessions.
- Added responsive PC, iPad and smartphone layouts, fullscreen support where available and touch-specific audio startup handling.
- Saved new documents as `timbre-v7` and `session-v8`, with explicit migration for supported older versions.
- Added the `/KOROGI-Lab/` GitHub Pages build and deployment workflow and published the site at `https://akiramaetomo.github.io/KOROGI-Lab/`.
