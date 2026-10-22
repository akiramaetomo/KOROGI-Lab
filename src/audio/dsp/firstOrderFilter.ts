/** 1st-order sections for IIRFilterNode: bilinear transform with the cutoff prewarped.
 * Shelves use the analog prototypes (s + G w)/(s + w) (low) and (G s + w)/(s + w) (high): the corner is the pole frequency. */
export type FirstOrderType = 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf';
export interface IirCoefficients { feedforward: number[]; feedback: number[] }

export function firstOrderCoefficients(type: FirstOrderType, cutoffHz: number, sampleRate: number, gainDb = 0): IirCoefficients {
  const k = Math.tan(Math.PI * cutoffHz / sampleRate);
  const g = 10 ** (gainDb / 20);
  const norm = 1 / (1 + k);
  const feedback = [1, (k - 1) * norm];
  switch (type) {
    case 'lowpass': return { feedforward: [k * norm, k * norm], feedback };
    case 'highpass': return { feedforward: [norm, -norm], feedback };
    case 'lowshelf': return { feedforward: [(1 + g * k) * norm, (g * k - 1) * norm], feedback };
    case 'highshelf': return { feedforward: [(g + k) * norm, (k - g) * norm], feedback };
  }
}

/** Complex response H(e^jw) of a 1st-order section, as [re, im]; used by tests and analysis. */
export function firstOrderResponse({ feedforward: [b0, b1], feedback: [, a1] }: IirCoefficients, hz: number, sampleRate: number): [number, number] {
  const w = 2 * Math.PI * hz / sampleRate;
  const c = Math.cos(w), s = Math.sin(w);
  // (b0 + b1 z^-1) / (1 + a1 z^-1), z^-1 = c - js
  const nr = b0! + b1! * c, ni = -b1! * s;
  const dr = 1 + a1! * c, di = -a1! * s;
  const den = dr * dr + di * di;
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den];
}
