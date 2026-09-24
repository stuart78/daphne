import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PITCH_MAX_HZ } from '@oramics/template';

import { MidiError, importMidi, noteToHz, parseMidi } from './index.js';

// --- building files to read back -------------------------------------------

const varint = (value: number): number[] => {
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
};

const chunk = (type: string, body: number[]): number[] => [
  ...[...type].map((c) => c.charCodeAt(0)),
  (body.length >> 24) & 0xff,
  (body.length >> 16) & 0xff,
  (body.length >> 8) & 0xff,
  body.length & 0xff,
  ...body,
];

interface Ev {
  tick: number;
  bytes: number[];
}

/** A file with the given tracks, at 480 ticks per quarter. */
const file = (tracks: Ev[][], format = 1, division = 480): Uint8Array => {
  const header = chunk('MThd', [
    0,
    format,
    0,
    tracks.length,
    (division >> 8) & 0xff,
    division & 0xff,
  ]);
  const body: number[] = [];
  for (const events of tracks) {
    const out: number[] = [];
    let previous = 0;
    for (const e of [...events].sort((a, b) => a.tick - b.tick)) {
      out.push(...varint(e.tick - previous), ...e.bytes);
      previous = e.tick;
    }
    out.push(...varint(0), 0xff, 0x2f, 0x00); // end of track
    body.push(...chunk('MTrk', out));
  }
  return Uint8Array.from([...header, ...body]);
};

const noteOn = (tick: number, note: number, velocity = 100, channel = 0): Ev => ({
  tick,
  bytes: [0x90 | channel, note, velocity],
});
const noteOff = (tick: number, note: number, channel = 0): Ev => ({
  tick,
  bytes: [0x80 | channel, note, 0],
});
const tempo = (tick: number, bpm: number): Ev => {
  const us = Math.round(60_000_000 / bpm);
  return { tick, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] };
};

// --- the parser ------------------------------------------------------------

test('notes come back with the times the tempo map implies', () => {
  // 480 ticks a quarter at 120 bpm is half a second a quarter.
  const song = parseMidi(file([[noteOn(0, 60), noteOff(480, 60), noteOn(960, 62), noteOff(1440, 62)]]));
  assert.equal(song.notes.length, 2);
  assert.ok(Math.abs(song.notes[0]!.at - 0) < 1e-6);
  assert.ok(Math.abs(song.notes[0]!.seconds - 0.5) < 1e-6);
  assert.ok(Math.abs(song.notes[1]!.at - 1.0) < 1e-6);
  assert.ok(Math.abs(song.duration - 1.5) < 1e-6);
});

test('a tempo change moves everything after it', () => {
  // Half the piece at 120 bpm, then 240 bpm: the second quarter takes half as
  // long. Assuming one tempo throughout puts every later note in the wrong place.
  const song = parseMidi(
    file([[tempo(0, 120), noteOn(0, 60), noteOff(480, 60), tempo(480, 240), noteOn(480, 62), noteOff(960, 62)]]),
  );
  assert.ok(Math.abs(song.notes[1]!.at - 0.5) < 1e-6, `second note at ${song.notes[1]!.at}`);
  assert.ok(Math.abs(song.notes[1]!.seconds - 0.25) < 1e-6, 'the second note should be half as long');
});

test('running status is understood', () => {
  /*
   * A sequencer writes a run of notes as one status byte and then bare data
   * pairs. A parser that does not expect it reads the data as commands and the
   * file turns to noise, and most real files use it.
   */
  const running: Ev[] = [
    { tick: 0, bytes: [0x90, 60, 100] },
    { tick: 240, bytes: [62, 100] },
    { tick: 240, bytes: [60, 0] },
    { tick: 240, bytes: [62, 0] },
  ];
  const song = parseMidi(file([running]));
  assert.equal(song.notes.length, 2);
  assert.deepEqual(song.notes.map((n) => n.note), [60, 62]);
});

test('a note-on at zero velocity ends the note', () => {
  const song = parseMidi(file([[noteOn(0, 60), noteOn(480, 60, 0)]]));
  assert.equal(song.notes.length, 1);
  assert.ok(Math.abs(song.notes[0]!.seconds - 0.5) < 1e-6);
});

test('a file that is not one is refused', () => {
  assert.throws(() => parseMidi(Uint8Array.from([1, 2, 3, 4])), MidiError);
  // Format 2 holds separate sequences, not one piece, so playing it as one
  // would be inventing an arrangement nobody wrote.
  assert.throws(() => parseMidi(file([[noteOn(0, 60), noteOff(10, 60)]], 2)), MidiError);
});

// --- laying it on the machine ----------------------------------------------

test('a melody lands on the pitch strip in Hertz', () => {
  const bytes = file([[noteOn(0, 69), noteOff(480, 69), noteOn(480, 81), noteOff(960, 81)]]);
  const result = importMidi(bytes, { columns: 300, duration: 30 });

  // A440 and A880, as fractions of the strip's 1000 Hz.
  const at = (seconds: number): number => result.lanes.PCH![Math.round((seconds / 30) * 299)]!;
  assert.ok(Math.abs(at(0.25) - 440 / PITCH_MAX_HZ) < 0.01, `read ${at(0.25)}`);
  assert.ok(Math.abs(at(0.75) - 880 / PITCH_MAX_HZ) < 0.01, `read ${at(0.75)}`);
  assert.ok(Number.isNaN(at(5)), 'the strip should be blank after the last note');
});

test('the strip is linear in Hertz, so octaves are not evenly spaced', () => {
  // The machine's scale is the frequency itself, which is the whole point of it.
  assert.ok(Math.abs(noteToHz(69) - 440) < 1e-6);
  assert.ok(Math.abs(noteToHz(81) - 880) < 1e-6);
  const a3 = noteToHz(57) / PITCH_MAX_HZ;
  const a4 = noteToHz(69) / PITCH_MAX_HZ;
  const a5 = noteToHz(81) / PITCH_MAX_HZ;
  assert.ok(a5 - a4 > (a4 - a3) * 1.9, 'each octave should take twice the room of the one below');
});

test('a chord is reduced to one line, and says so', () => {
  /*
   * The machine has one pitch strip. Four amplitudes are four timbres of a
   * single voice, not four voices, so a chord cannot be represented at all.
   * Reducing it quietly would be the wrong kind of helpful.
   */
  const chord = file([
    [noteOn(0, 60), noteOn(0, 64), noteOn(0, 67), noteOff(960, 60), noteOff(960, 64), noteOff(960, 67)],
  ]);

  // The chord sounds from 0 to 1 s on a 30 s sheet, so sample inside it.
  const column = Math.round((0.5 / 30) * 199);

  const top = importMidi(chord, { columns: 200 });
  assert.equal(top.masked, 2, 'two of the three notes were dropped');
  const hz = top.lanes.PCH![column]! * PITCH_MAX_HZ;
  assert.ok(Math.abs(hz - noteToHz(67)) < 2, `kept ${hz.toFixed(0)} Hz, expected the top note`);

  const bottom = importMidi(chord, { columns: 200, voice: 'lowest' });
  const low = bottom.lanes.PCH![column]! * PITCH_MAX_HZ;
  assert.ok(Math.abs(low - noteToHz(60)) < 2, `kept ${low.toFixed(0)} Hz, expected the bottom note`);
});

test('parts are given timbres in the order they first sound', () => {
  const bytes = file([
    [noteOn(0, 72), noteOff(480, 72)],
    [noteOn(480, 60), noteOff(960, 60)],
  ]);
  const result = importMidi(bytes, { columns: 300 });

  assert.equal(result.parts, 2);
  const at = (seconds: number, role: string): number =>
    result.lanes[role]![Math.round((seconds / 30) * 299)]!;
  assert.ok(at(0.25, 'AMP1')! > 0.5, 'the first part should drive timbre one');
  assert.ok(Number.isNaN(at(0.25, 'AMP2')), 'timbre two should be silent until its part sounds');
  assert.ok(at(0.75, 'AMP2')! > 0.5, 'the second part should drive timbre two');
});

test('velocity becomes amplitude', () => {
  const bytes = file([[noteOn(0, 60, 127), noteOff(240, 60), noteOn(480, 60, 40), noteOff(720, 60)]]);
  const result = importMidi(bytes, { columns: 600 });
  const at = (seconds: number): number => result.lanes.AMP1![Math.round((seconds / 30) * 599)]!;
  assert.ok(Math.abs(at(0.1) - 1) < 0.02, `loud note read ${at(0.1)}`);
  assert.ok(Math.abs(at(0.6) - 40 / 127) < 0.02, `quiet note read ${at(0.6)}`);
});

test('a piece longer than the sheet is fitted, and the rate says by how much', () => {
  // 60 seconds of music onto a 30 second sheet. Every note has to land, so the
  // sheet runs at double speed rather than the tune being cut in half.
  const bytes = file([[noteOn(0, 60), noteOff(480 * 120, 60)]]);
  const fitted = importMidi(bytes, { columns: 200, duration: 30 });
  assert.ok(Math.abs(fitted.fileDuration - 60) < 0.01, `file is ${fitted.fileDuration}s`);
  assert.ok(Math.abs(fitted.rate - 2) < 0.01, `rate ${fitted.rate}`);
  // The very last column lands exactly on the note's end, which is silence, so
  // check the one before it.
  assert.ok(Number.isFinite(fitted.lanes.PCH![198]!), 'the end of the piece should still be on the sheet');

  const cut = importMidi(bytes, { columns: 200, duration: 30, longer: 'truncate' });
  assert.equal(cut.rate, 1);
  assert.ok(Math.abs(cut.used - 30) < 0.01, 'only the opening reaches the sheet');
});

test('notes the strip cannot spell are counted, not clipped silently', () => {
  // The strip stops at 1000 Hz, so anything above about B5 has no place on it.
  const bytes = file([[noteOn(0, 60), noteOff(240, 60), noteOn(240, 108), noteOff(480, 108)]]);
  const result = importMidi(bytes, { columns: 300 });
  assert.ok(result.outOfRange > 0, 'the top note should be reported as unplayable');
  const at = Math.round((0.35 / 30) * 299);
  assert.ok(Number.isNaN(result.lanes.PCH![at]!), 'an unplayable note should leave the strip blank');
});

test('in notes mode a note lands as a note row and an octave row', () => {
  // A4 then C6: rows A and C, octaves 4 and 6. Rows count from the bottom.
  const bytes = file([[noteOn(0, 69), noteOff(480, 69), noteOn(480, 84), noteOff(960, 84)]]);
  const result = importMidi(bytes, { columns: 300, pitch: 'notes' });
  const at = (lane: string, seconds: number, rows: number): number =>
    Math.floor(result.lanes[lane]![Math.round((seconds / 30) * 299)]! * rows);
  assert.equal(at('NOTE', 0.25, 12), 9, 'A is the tenth row');
  assert.equal(at('OCT', 0.25, 8), 3, 'octave 4 is the fourth row up, octave 1 being the first');
  assert.equal(at('NOTE', 0.75, 12), 0);
  assert.equal(at('OCT', 0.75, 8), 5);
  assert.ok(!('PCH' in result.lanes), 'the Hertz strip is not on this sheet');
});

test('in notes mode only notes outside the eight octaves are refused', () => {
  // C8 is above the Hertz strip but on the octave band. C0 is below both.
  const bytes = file([[noteOn(0, 108), noteOff(240, 108), noteOn(240, 12), noteOff(480, 12)]]);
  const result = importMidi(bytes, { columns: 300, pitch: 'notes' });
  assert.equal(result.outOfRange, 1, 'one note, counted once rather than per column');
  assert.ok(Number.isFinite(result.lanes.OCT![Math.round((0.1 / 30) * 299)]!), 'C8 fits');
});

test('the transport strip is left alone', () => {
  // Blank transport is normal speed, and the file's tempo is already baked into
  // the note times.
  const result = importMidi(file([[noteOn(0, 60), noteOff(480, 60)]]), { columns: 100 });
  assert.ok([...result.lanes.TRN!].every((v) => Number.isNaN(v)));
});
