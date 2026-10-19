import { PARAMETER_RANGES as P } from '../../config/parameterRanges';
import type { MultiOscillatorSettings, OscillatorSettings, OscPartial } from '../types';
import { clamp } from './params';

const COUNT = { min: P['osc-multi-count'].min, max: P['osc-multi-count'].max };
const RATIO = { min: P['osc-multi-ratio'].min, max: P['osc-multi-ratio'].max };
const AMPLITUDE = { min: P['osc-multi-amplitude'].min, max: P['osc-multi-amplitude'].max };

/** Single, or the one partial every non-periodic source keeps. */
export const SINGLE_PARTIALS: readonly OscPartial[] = [{ ratio: 1, amplitude: 1 }];

/**
 * Symmetric spread: N oscillators equally spaced in cents from -spread to +spread around Base,
 * each at gain 1/N so the summed peak cannot exceed one waveform's peak.
 */
export function spreadPartials(count: number, spreadCent: number): OscPartial[] {
  const n = Math.round(clamp(count, COUNT.min, COUNT.max));
  return Array.from({ length: n }, (_, index) => ({
    ratio: 2 ** ((n === 1 ? 0 : spreadCent * (2 * index / (n - 1) - 1)) / 1200),
    amplitude: 1 / n
  }));
}

/** Partials that sound: Single (and white noise) is one oscillator at Base with unity gain. */
export function resolvePartials(osc: Pick<OscillatorSettings, 'sourceType' | 'voiceMode' | 'multi'>): OscPartial[] {
  if (osc.voiceMode !== 'multi' || osc.sourceType === 'white-noise') return SINGLE_PARTIALS.map(item => ({ ...item }));
  if (osc.multi.definition === 'spread') return spreadPartials(osc.multi.spread.count, osc.multi.spread.spreadCent);
  return osc.multi.partials.map(item => ({ ...item }));
}

export function amplitudeSum(partials: readonly OscPartial[]): number {
  return partials.reduce((total, item) => total + item.amplitude, 0);
}

/** Scale amplitudes proportionally so they sum to one; all-zero rows become 1/N. */
export function normalizeAmplitudes(partials: readonly OscPartial[]): OscPartial[] {
  const sum = amplitudeSum(partials);
  return partials.map(item => ({ ratio: item.ratio, amplitude: sum > 0 ? item.amplitude / sum : 1 / partials.length }));
}

export function clampPartial(partial: OscPartial): OscPartial {
  return { ratio: clamp(partial.ratio, RATIO.min, RATIO.max), amplitude: clamp(partial.amplitude, AMPLITUDE.min, AMPLITUDE.max) };
}

/** Number of Table rows accepted on load and edit. */
export function isValidPartialCount(count: number): boolean {
  return Number.isInteger(count) && count >= COUNT.min && count <= COUNT.max;
}

/**
 * Parse a pasted table into partials relative to `baseHz`.
 * Rows separate on newlines; columns on tabs, commas, semicolons, spaces or Markdown pipes.
 * Three numbers: index, Hz, amplitude. Two: Hz, amplitude. One: Hz, with amplitude 1/N.
 * Rows without numbers (headers, Markdown separators) are skipped; any other malformed row rejects the paste.
 */
export function parsePartialTable(text: string, baseHz: number): OscPartial[] {
  const rows: { hz: number; amplitude: number | null }[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const cells = line.split(/[\t,;|]|\s+/).map(cell => cell.trim()).filter(cell => cell !== '');
    if (cells.length === 0 || cells.every(cell => !/\d/.test(cell))) return;
    const numbers = cells.map(Number);
    if (numbers.some(value => !Number.isFinite(value)) || numbers.length > 3)
      throw new Error(`Row ${index + 1}: expected Hz, or Hz and Amplitude, or No., Hz and Amplitude.`);
    const [hz, amplitude] = numbers.length === 3 ? numbers.slice(1) : numbers;
    if (!(hz! > 0)) throw new Error(`Row ${index + 1}: frequency must be above 0 Hz.`);
    if (amplitude !== undefined && (amplitude < AMPLITUDE.min || amplitude > AMPLITUDE.max))
      throw new Error(`Row ${index + 1}: amplitude must be from ${AMPLITUDE.min} to ${AMPLITUDE.max}.`);
    rows.push({ hz: hz!, amplitude: amplitude ?? null });
  });
  if (!isValidPartialCount(rows.length)) throw new Error(`Paste ${COUNT.min} to ${COUNT.max} rows.`);
  if (rows.some(row => row.amplitude === null) && rows.some(row => row.amplitude !== null))
    throw new Error('Give an amplitude on every row or on none.');
  return rows.map(row => {
    const ratio = row.hz / baseHz;
    if (ratio < RATIO.min || ratio > RATIO.max)
      throw new Error(`${row.hz} Hz is outside ${RATIO.min}–${RATIO.max} × Base (${baseHz} Hz).`);
    return { ratio, amplitude: row.amplitude ?? 1 / rows.length };
  });
}

/** Tab-separated Hz and amplitude with a header row, for copying into other tools. */
export function formatPartialTable(partials: readonly OscPartial[], baseHz: number): string {
  return ['Hz\tAmplitude', ...partials.map(item => `${roundHz(item.ratio * baseHz)}\t${Number(item.amplitude.toFixed(6))}`)].join('\n');
}

export function roundHz(hz: number): number {
  return Number(hz.toFixed(hz >= 100 ? 3 : 4));
}

/** Bound every Multi value to its range without changing the row count beyond 1 .. 16. */
export function sanitizeMulti(multi: MultiOscillatorSettings): MultiOscillatorSettings {
  const rows = multi.partials.slice(0, COUNT.max).map(clampPartial);
  return {
    definition: multi.definition === 'table' ? 'table' : 'spread',
    partials: rows.length > 0 ? rows : SINGLE_PARTIALS.map(item => ({ ...item })),
    spread: {
      count: Math.round(clamp(multi.spread.count, COUNT.min, COUNT.max)),
      spreadCent: clamp(multi.spread.spreadCent, P['osc-multi-spread'].min, P['osc-multi-spread'].max)
    }
  };
}
