import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { Overlays } from '@oramics/template';

import { hasRasteriser, renderSheet } from './fixture.js';
import type { Gray } from './image.js';
import { importSheet } from './index.js';
import { photograph } from './testing.js';

const skip = hasRasteriser() ? false : 'pdftoppm is not installed';
const COLUMNS = 600;

/** A row centre as a lane value, so a mark sits in the middle of its row. */
const row = (index: number, rows: number): number => (index + 0.5) / rows;

/** Steps through a list of rows, one per equal stretch, blank at both ends. */
const steps = (rows: number[], count: number): Float32Array => {
  const out = new Float32Array(COLUMNS).fill(Number.NaN);
  const from = Math.round(COLUMNS * 0.1);
  const to = Math.round(COLUMNS * 0.9);
  for (let i = from; i < to; i++) {
    const which = Math.min(rows.length - 1, Math.floor(((i - from) / (to - from)) * rows.length));
    out[i] = row(rows[which]!, count);
  }
  return out;
};

const NOTES = [0, 4, 7, 11, 2]; // C E G B D
const OCTAVES = [2, 3, 3, 5, 6];

let drawn: Gray;

before(async () => {
  if (!skip) {
    const overlays: Overlays = { NOTE: steps(NOTES, 12), OCT: steps(OCTAVES, 8) };
    drawn = await renderSheet(200, overlays, 'A3F91C2D', 'TONE');
  }
});

/** Which row a read value falls in. */
const rowOf = (value: number, rows: number): number => Math.floor(value * rows);

/** The row read at the middle of each step. */
const readSteps = (lane: Float32Array, count: number, rows: number): number[] => {
  const out: number[] = [];
  const from = Math.round(COLUMNS * 0.1);
  const to = Math.round(COLUMNS * 0.9);
  for (let k = 0; k < count; k++) {
    const i = Math.round(from + ((k + 0.5) / count) * (to - from));
    out.push(rowOf(lane[i]!, rows));
  }
  return out;
};

test('a note-and-octave sheet says so, and is read as one', { skip }, () => {
  const result = importSheet(drawn, { laneColumns: COLUMNS });
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;

  assert.equal(result.layout, 'TONE');
  assert.ok(result.contents.lanes.NOTE, 'no note band read');
  assert.ok(result.contents.lanes.OCT, 'no octave band read');
  assert.equal(result.contents.lanes.PCH, undefined, 'a tonal sheet has no Hertz band');
});

test('every note and octave comes back in its own row', { skip }, () => {
  /*
   * The rows are printed light enough that the importer never sees them, and a
   * note band is only 2.5 mm a row. Reading a mark into its neighbour's row is a
   * wrong note, not a slightly wrong one, so this is exact.
   */
  const result = importSheet(drawn, { laneColumns: COLUMNS });
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.deepEqual(readSteps(result.contents.lanes.NOTE!, NOTES.length, 12), NOTES);
  assert.deepEqual(readSteps(result.contents.lanes.OCT!, OCTAVES.length, 8), OCTAVES);
});

test('a photographed note sheet still lands every note in its row', { skip }, () => {
  const scan = photograph(drawn, {
    width: 2000,
    perspective: 0.04,
    rotate: -5,
    vignette: 0.3,
    noise: 0.012,
    blur: 1,
    seed: 17,
  });
  const result = importSheet(scan.image, { laneColumns: COLUMNS });
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;

  assert.equal(result.layout, 'TONE');
  assert.deepEqual(readSteps(result.contents.lanes.NOTE!, NOTES.length, 12), NOTES);
  assert.deepEqual(readSteps(result.contents.lanes.OCT!, OCTAVES.length, 8), OCTAVES);
});

test('the printed rows are not read as marks', { skip }, async () => {
  const blank = await renderSheet(200, undefined, 'A3F91C2D', 'TONE');
  const result = importSheet(blank, { laneColumns: COLUMNS });
  assert.ok(result.ok);
  if (!result.ok) return;
  for (const [role, coverage] of Object.entries(result.contents.coverage)) {
    assert.ok(coverage < 0.02, `${role} reads ${(coverage * 100).toFixed(0)}% covered on a blank sheet`);
  }
});
