/**
 * Turning marks in the note and octave bands into the notes that play.
 *
 * Kept apart from the drawing surface and the engine so the rule is written
 * once and tested on its own. The pad draws what somebody marked; this decides
 * what it means; the engine plays the answer. Showing the answer on the pad is
 * what lets a room see "it is reading my mark as F sharp, not G" instead of
 * hearing a wrong note and not knowing why.
 *
 * Two readings of a mark, chosen by the user:
 *
 *   dots   each mark sets a note that holds until the next one. Where a mark
 *          starts is all that counts, not how long it runs. This is how the
 *          1976 design and Richards' build read a score.
 *   lines  the note follows the line as it moves, snapping to the nearest row.
 *
 * Either way the result is snapped to a key and scale, chromatic by default.
 * The printed sheet always carries all twelve rows, so one sheet serves every
 * key and the snapping happens here rather than on the paper.
 */

import { NOTE_ROWS, rowValue } from '@oramics/engine';

export type MarkMode = 'dots' | 'lines';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Rows that are sharps, as on a keyboard's black keys. */
export const SHARP_ROWS = new Set([1, 3, 6, 8, 10]);

export interface Scale {
  id: string;
  name: string;
  /** Semitones above the root that belong to the scale. */
  steps: number[];
}

export const SCALES: Scale[] = [
  { id: 'chromatic', name: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major', name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonic-minor', name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'dorian', name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixolydian', name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'pentatonic', name: 'Pentatonic', steps: [0, 2, 4, 7, 9] },
  { id: 'pentatonic-minor', name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', steps: [0, 3, 5, 6, 7, 10] },
  { id: 'whole-tone', name: 'Whole tone', steps: [0, 2, 4, 6, 8, 10] },
];

export const scaleById = (id: string): Scale => SCALES.find((s) => s.id === id) ?? SCALES[0]!;

export interface Tuning {
  /** Root as a row, 0 for C. */
  root: number;
  scale: string;
}

export const CHROMATIC: Tuning = { root: 0, scale: 'chromatic' };

/** Is this row in the key? */
export const inScale = (row: number, tuning: Tuning): boolean => {
  const steps = scaleById(tuning.scale).steps;
  return steps.includes((((row - tuning.root) % 12) + 12) % 12);
};

/**
 * The nearest row in the key.
 *
 * Stays inside the band rather than wrapping to the next octave: a B snapped
 * in a scale without one goes down to A, not up to the C above, because the
 * octave is somebody else's mark in the band below and quietly changing it
 * would be overriding them. Ties go down, which is arbitrary but consistent.
 */
export const snapNote = (row: number, tuning: Tuning): number => {
  if (inScale(row, tuning)) return row;
  for (let d = 1; d < 12; d++) {
    if (row - d >= 0 && inScale(row - d, tuning)) return row - d;
    if (row + d < NOTE_ROWS && inScale(row + d, tuning)) return row + d;
  }
  return row;
};

/**
 * How far past a row's edge a line has to go before it counts as the next row.
 *
 * Without it, a line drawn along a boundary, which is exactly where a hand
 * resting between two rows puts it, flickers between the two notes every few
 * milliseconds. A quarter of a row is well under a pen's width at 2.5 mm a row.
 */
const HYSTERESIS = 0.25;

/** How many columns of a mark's start decide what a dot means. 80 ms. */
const ONSET_COLUMNS = 8;

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/**
 * Read a band into one chosen row per column, as row-centre lane values.
 *
 * NaN wherever nothing was marked, so the engine holds the last note across
 * the gap exactly as the relays did. A run ends at blank paper or where a new
 * stroke begins, so two dots placed side by side are two notes, not one.
 */
export const readRows = (
  values: Float32Array,
  strokes: Int32Array | null,
  rows: number,
  mode: MarkMode,
  snap: (row: number) => number = (r) => r,
): Float32Array => {
  const out = new Float32Array(values.length).fill(Number.NaN);
  const rowAt = (v: number): number => Math.max(0, Math.min(rows - 1, Math.floor(v * rows)));

  let i = 0;
  while (i < values.length) {
    if (!Number.isFinite(values[i]!)) {
      i++;
      continue;
    }
    // One run: a stretch of marks from a single stroke.
    const start = i;
    const id = strokes?.[i] ?? 0;
    while (
      i < values.length &&
      Number.isFinite(values[i]!) &&
      (strokes === null || strokes[i] === id)
    ) {
      i++;
    }
    const end = i; // exclusive

    if (mode === 'dots') {
      // Where the mark starts, and nothing after. A hand-drawn dot is a blob,
      // so its opening columns are averaged rather than trusting the first.
      const onset: number[] = [];
      for (let k = start; k < Math.min(end, start + ONSET_COLUMNS); k++) onset.push(values[k]!);
      const chosen = rowValue(snap(rowAt(median(onset))), rows);
      for (let k = start; k < end; k++) out[k] = chosen;
      continue;
    }

    let current = rowAt(values[start]!);
    for (let k = start; k < end; k++) {
      const position = values[k]! * rows;
      if (position < current - HYSTERESIS || position > current + 1 + HYSTERESIS) {
        current = rowAt(values[k]!);
      }
      out[k] = rowValue(snap(current), rows);
    }
  }
  return out;
};
