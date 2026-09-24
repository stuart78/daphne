import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMidi, transcribe, writeMidi, type Trace } from './index.js';

const STEP = 0.01;

/** A trace built from [seconds, hz, level] stretches, back to back. */
const trace = (parts: [number, number, number][], sounding?: (i: number) => number): Trace => {
  const total = parts.reduce((s, [d]) => s + Math.round(d / STEP), 0);
  const targetHz = new Float32Array(total);
  const level = new Float32Array(total);
  let i = 0;
  for (const [seconds, hz, v] of parts) {
    for (let k = 0; k < Math.round(seconds / STEP); k++, i++) {
      targetHz[i] = hz;
      level[i] = v;
    }
  }
  const hz = Float32Array.from(targetHz, (v, k) => (sounding ? sounding(k) : v));
  return { step: STEP, targetHz, hz, level };
};

test('a written file reads back with the same notes', () => {
  const bytes = writeMidi([
    { at: 0, seconds: 0.5, note: 60, velocity: 0.8, channel: 0, track: 0 },
    { at: 0.5, seconds: 1, note: 67, velocity: 0.5, channel: 0, track: 0 },
  ]);
  const song = parseMidi(bytes);
  assert.equal(song.notes.length, 2);
  assert.equal(song.notes[0]!.note, 60);
  assert.ok(Math.abs(song.notes[1]!.at - 0.5) < 0.002);
  assert.ok(Math.abs(song.notes[1]!.seconds - 1) < 0.002);
  assert.ok(Math.abs(song.duration - 1.5) < 0.002);
});

test('bends and controllers survive the round trip', () => {
  const bytes = writeMidi(
    [{ at: 0, seconds: 1, note: 60, velocity: 0.8, channel: 0, track: 0 }],
    [
      { at: 0.25, controller: -1, value: 0.5, channel: 0, track: 0 },
      { at: 0.5, controller: 11, value: 0.25, channel: 0, track: 0 },
    ],
  );
  const song = parseMidi(bytes);
  const bend = song.controls.find((c) => c.controller === -1)!;
  assert.ok(Math.abs(bend.value - 0.5) < 0.001);
  assert.ok(Math.abs(bend.at - 0.25) < 0.002);
  const expression = song.controls.find((c) => c.controller === 11)!;
  assert.ok(Math.abs(expression.value - 0.25) < 0.01);
});

test('a steady pitch that sounds is one note', () => {
  const t = transcribe(trace([[1, 440, 0.5]]));
  assert.equal(t.notes.length, 1);
  assert.equal(t.notes[0]!.note, 69);
  assert.ok(Math.abs(t.notes[0]!.seconds - 1) < 0.02);
});

test('silence splits notes, and a pitch change is a new note', () => {
  const t = transcribe(trace([[0.5, 440, 0.5], [0.3, 440, 0], [0.5, 440, 0.5], [0.5, 523.25, 0.5]]));
  assert.deepEqual(
    t.notes.map((n) => n.note),
    [69, 69, 72],
  );
  assert.ok(Math.abs(t.notes[1]!.at - 0.8) < 0.02, `second note at ${t.notes[1]!.at}`);
});

test('vibrato becomes bend, not a run of notes', () => {
  // A semitone either side of A, five times a second.
  const t = transcribe(
    trace([[1, 440, 0.5]], (i) => 440 * 2 ** (Math.sin(2 * Math.PI * 5 * i * STEP) / 12)),
  );
  assert.equal(t.notes.length, 1, 'the target did not move, so the note should not either');
  const bends = t.controls.filter((c) => c.controller === -1).map((c) => c.value * t.bendRange);
  assert.ok(Math.max(...bends) > 0.9 && Math.min(...bends) < -0.9, 'the bend should reach a semitone each way');
});

test('a note that never gets loud enough is not a note', () => {
  assert.equal(transcribe(trace([[1, 440, 0.01]])).notes.length, 0);
});
