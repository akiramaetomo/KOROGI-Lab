export const MAX_RECORDING_SEC = 300;
export function maxSongBars(bpm: number): number { return Math.floor(MAX_RECORDING_SEC * bpm / 240); }
