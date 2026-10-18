import { PARAMETER_RANGES as P } from '../config/parameterRanges';
export const MAX_RECORDING_SEC = 300;
/** Whole bars a Pattern may take: the `song-bars` maximum (32), and never longer than one recording at the BPM. */
export function maxSongBars(bpm: number): number { return Math.min(P['song-bars'].max, Math.floor(MAX_RECORDING_SEC * bpm / 240)); }
