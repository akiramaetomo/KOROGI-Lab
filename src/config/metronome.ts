/**
 * Recording click (metronome) definition.
 *
 * Authors may edit this file directly:
 * - METRONOME_TONES: the frequency (Hz) of each click symbol.
 * - METRONOME_PATTERNS: one bar of clicks per choice. The key is the label shown
 *   next to Off in the RECORD panel; the array lists the symbols played in one bar.
 *   Every array is spread evenly over the bar (4/4), so its length sets the step.
 * - METRONOME_WAVEFORM, METRONOME_NOTE_MS, METRONOME_LEVEL_DB: the sound of every click.
 *
 * The click goes through Master Gain, Master Mute and the limiter, so it follows the
 * app volume. It is a monitoring aid only and is never recorded or saved.
 */
export const METRONOME_TONES = {
  pi: 1760,
  po: 880,
  pu: 440
} as const;

export type MetronomeTone = keyof typeof METRONOME_TONES;

export const METRONOME_PATTERNS: Readonly<Record<string, readonly MetronomeTone[]>> = {
  '1/4': ['pi', 'po', 'po', 'po']
  // Planned, not enabled yet. Removing the comment markers adds the choice to the UI.
  // '1/8': ['pi', 'po', 'po', 'po', 'pu', 'po', 'po', 'po'],
  // '1/16': ['pi', 'po', 'po', 'po', 'po', 'po', 'po', 'po', 'pu', 'po', 'po', 'po', 'po', 'po', 'po', 'po']
};

export const METRONOME_WAVEFORM: OscillatorType = 'triangle';
/** Length of each click, including its fade-in and fade-out. */
export const METRONOME_NOTE_MS = 20;
/** Linear fades at both ends of a click so the triangle wave does not start or stop with a step. */
export const METRONOME_ATTACK_MS = 1;
export const METRONOME_RELEASE_MS = 3;
/** Click level before Master Gain (0 dB = full-scale triangle). */
export const METRONOME_LEVEL_DB = -12;
