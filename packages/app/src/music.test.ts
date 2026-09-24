import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHROMATIC, inScale, readRows, snapNote, type Tuning } from './music.js';

const NOTE = 12;
const centre = (row: number, rows = NOTE): number => (row + 0.5) / rows;
const rowOf = (value: number, rows = NOTE): number => Math.floor(value * rows);

/** A lane with the given runs, each as [start, end, value], blank elsewhere. */
const lane = (length: number, runs: [number, number, number][]): Float32Array => {
  const out = new Float32Array(length).fill(Number.NaN);
  for (const [from, to, value] of runs) for (let i = from; i < to; i++) out[i] = value;
  return out;
};

// --- keys and scales -------------------------------------------------------

test('chromatic keeps every note', () => {
  for (let row = 0; row < 12; row++) assert.equal(snapNote(row, CHROMATIC), row);
});

test('a scale keeps its own notes and moves the rest to the nearest', () => {
  const cMajor: Tuning = { root: 0, scale: 'major' };
  assert.equal(snapNote(4, cMajor), 4, 'E is in C major');
  assert.equal(snapNote(6, cMajor), 5, 'F sharp goes down to F, ties going down');
  assert.equal(snapNote(10, cMajor), 9, 'B flat goes down to A');
});

test('the root moves the scale', () => {
  // D major has F sharp and C sharp and no F or C.
  const dMajor: Tuning = { root: 2, scale: 'major' };
  assert.ok(inScale(6, dMajor), 'F# is in D major');
  assert.ok(!inScale(5, dMajor), 'F is not in D major');
  assert.equal(snapNote(0, dMajor), 1, 'C goes up to C sharp, the only neighbour in the key');
});

test('snapping stays inside the octave rather than wrapping', () => {
  // A minor pentatonic on C has no B. The nearest note in the key is C above,
  // but that belongs to the next octave, which is the octave band's business.
  const cMinorPentatonic: Tuning = { root: 0, scale: 'pentatonic-minor' };
  assert.equal(snapNote(11, cMinorPentatonic), 10);
});

// --- dots ------------------------------------------------------------------

test('a dot holds its note, and only where it starts counts', () => {
  // A mark that starts on E and wanders up to A is still an E in dot mode: the
  // note is set by the mark arriving, not by where it goes afterwards.
  const values = lane(100, [[10, 40, centre(4)]]);
  for (let i = 25; i < 40; i++) values[i] = centre(9);
  const read = readRows(values, null, NOTE, 'dots');
  for (let i = 10; i < 40; i++) assert.equal(rowOf(read[i]!), 4, `column ${i}`);
});

test('blank paper between dots is left for the engine to hold across', () => {
  const read = readRows(lane(100, [[10, 14, centre(4)], [60, 64, centre(7)]]), null, NOTE, 'dots');
  assert.ok(Number.isNaN(read[30]!), 'the gap should stay blank so the relays hold the E');
  assert.equal(rowOf(read[61]!), 7);
});

test('two dots side by side are two notes', () => {
  // No blank paper between them, so only the stroke ids tell them apart.
  const values = lane(100, [[10, 20, centre(4)], [20, 30, centre(7)]]);
  const strokes = new Int32Array(100);
  for (let i = 10; i < 20; i++) strokes[i] = 1;
  for (let i = 20; i < 30; i++) strokes[i] = 2;
  const read = readRows(values, strokes, NOTE, 'dots');
  assert.equal(rowOf(read[15]!), 4);
  assert.equal(rowOf(read[25]!), 7);
});

test('a dot is snapped to the key', () => {
  const read = readRows(lane(50, [[5, 10, centre(6)]]), null, NOTE, 'dots', (r) =>
    snapNote(r, { root: 0, scale: 'major' }),
  );
  assert.equal(rowOf(read[7]!), 5, 'F sharp in C major reads as F');
});

// --- lines -----------------------------------------------------------------

test('a line follows its own height, one row at a time', () => {
  // A ramp up through the band passes every note on the way.
  const values = new Float32Array(120);
  for (let i = 0; i < 120; i++) values[i] = i / 120;
  const read = readRows(values, null, NOTE, 'lines');
  const heard = new Set<number>();
  for (const v of read) heard.add(rowOf(v));
  assert.equal(heard.size, 12, `the ramp reached ${heard.size} of 12 notes`);
});

test('a line resting on a boundary does not flicker between two notes', () => {
  // Wobbling by a tenth of a row either side of the line between E and F: a
  // hand resting between two rows does exactly this.
  const values = new Float32Array(200);
  for (let i = 0; i < 200; i++) values[i] = (5 + (i % 2 === 0 ? 0.1 : -0.1)) / NOTE;
  const read = readRows(values, null, NOTE, 'lines');
  const heard = new Set<number>();
  for (const v of read) heard.add(rowOf(v));
  assert.equal(heard.size, 1, `flickered between ${[...heard].join(' and ')}`);
});

test('a line moves on once it is clearly in the next row', () => {
  const values = lane(100, [[0, 50, centre(4)], [50, 100, centre(7)]]);
  const read = readRows(values, null, NOTE, 'lines');
  assert.equal(rowOf(read[25]!), 4);
  assert.equal(rowOf(read[75]!), 7);
});
