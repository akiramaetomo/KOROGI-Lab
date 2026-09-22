export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function holdAudioParam(param: AudioParam, time: number): void {
  // cancelAndHoldAtTime preserves the instantaneous value of an in-flight ramp.
  param.cancelAndHoldAtTime(time);
}

export function smoothAudioParam(
  param: AudioParam,
  target: number,
  now: number,
  smoothingSec: number
): void {
  holdAudioParam(param, now);
  // This helper is for live controls at the audio clock's current time.
  // Explicitly anchor a held constant before adding the next ramp.
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + smoothingSec);
}
