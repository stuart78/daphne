import assert from 'node:assert/strict';
import { test } from 'node:test';

import { randomSlideField } from '@oramics/engine';

import { LANE_SAMPLES, SLIDE_HEIGHT, SLIDE_WIDTH, makeAllLanes } from './lanes.js';
import {
  SESSION_FORMAT,
  SessionError,
  decodeSession,
  encodeSession,
  type Session,
  type SessionSettings,
} from './session.js';

const SETTINGS: SessionSettings = {
  globalSpeed: 1,
  vibratoCents: 50,
  fidelity: {
    integerHzPitch: true,
    linearPitchScale: true,
    relayLag: true,
    opticalAmplitude: true,
    monoSum: true,
    servoScanner: true,
  },
  pitchMode: 'hertz',
  markMode: 'lines',
  root: 0,
  scale: 'chromatic',
  unison: Array.from({ length: 4 }, () => ({ voices: 1, cents: 0 })),
  presets: ['', '', '', ''],
  pan: [0, 0, 0, 0],
  muted: [],
  octaves: [0, 0, 0, 0],
  slip: [0, 0, 0, 0],
  vibratoMode: 'vibrato',
  echoFeedback: 0.35,
  reverbSpace: 'plate',
};

/** A session with two separate marks on the pitch lane and four painted slides. */
const sample = (): Session => {
  const lanes = makeAllLanes();
  const { values, strokes } = lanes.pitch;
  for (let i = 100; i <= 400; i++) {
    values[i] = 0.2 + (i - 100) / 1000;
    strokes[i] = 1;
  }
  for (let i = 900; i <= 1200; i++) {
    values[i] = 0.8;
    strokes[i] = 2;
  }
  for (let i = 0; i < LANE_SAMPLES; i++) lanes.amp1.values[i] = 0.5;
  lanes.amp1.strokes.fill(7);

  return {
    lanes,
    slides: Array.from({ length: 4 }, (_, i) => randomSlideField(i + 1).field),
    settings: { ...SETTINGS, globalSpeed: 1.5, vibratoCents: 120 },
  };
};

// ---------------------------------------------------------------------------

test('a session survives the round trip', () => {
  const before = sample();
  const after = decodeSession(encodeSession(before), SETTINGS);

  for (const name of ['pitch', 'amp1', 'transport'] as const) {
    const a = before.lanes[name].values;
    const b = after.lanes[name].values;
    for (let i = 0; i < LANE_SAMPLES; i++) {
      if (Number.isNaN(a[i]!)) {
        assert.ok(Number.isNaN(b[i]!), `${name}[${i}] should still be blank`);
      } else {
        assert.ok(Math.abs(a[i]! - b[i]!) < 1e-4, `${name}[${i}] moved`);
      }
    }
  }

  assert.equal(after.settings.globalSpeed, 1.5);
  assert.equal(after.settings.vibratoCents, 120);
});

test('blank columns stay blank rather than becoming zero', () => {
  // The distinction the whole lane model rests on: a scanned sheet is mostly
  // blank paper, and blank is not the same as drawn at the bottom of the band.
  const after = decodeSession(encodeSession(sample()), SETTINGS);
  assert.ok(Number.isNaN(after.lanes.pitch.values[0]!), 'leading blank came back as a value');
  assert.ok(Number.isNaN(after.lanes.pitch.values[700]!), 'gap between marks came back filled');
  assert.ok(Math.abs(after.lanes.pitch.values[1000]! - 0.8) < 1e-4);
});

test('separate marks stay separate', () => {
  const after = decodeSession(encodeSession(sample()), SETTINGS);
  const { strokes } = after.lanes.pitch;
  assert.ok(strokes[200]! > 0, 'first mark lost its stroke');
  assert.ok(strokes[1000]! > 0, 'second mark lost its stroke');
  assert.notEqual(strokes[200], strokes[1000], 'two marks came back as one stroke');
  assert.equal(strokes[700], 0, 'the gap between them picked up a stroke');
});

test('painted slides come back to the same opacity', () => {
  const before = sample();
  const after = decodeSession(encodeSession(before), SETTINGS);
  for (let i = 0; i < 4; i++) {
    const a = before.slides[i]!;
    const b = after.slides[i]!;
    assert.equal(b.length, SLIDE_WIDTH * SLIDE_HEIGHT);
    let worst = 0;
    for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k]! - b[k]!));
    // One byte per pixel, so half a step is the most anything can move.
    assert.ok(worst <= 1 / 255 + 1e-6, `slide ${i} drifted by ${worst}`);
  }
});

test('the file is JSON anyone can read', () => {
  const text = encodeSession(sample());
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed.format, SESSION_FORMAT);
  assert.equal(parsed.duration, 30);
  assert.equal(parsed.columns, LANE_SAMPLES);
  // Objects indented, sample arrays on one line. 24000 samples one per line
  // would make the file unreadable in the name of readability.
  assert.ok(text.includes('\n  "lanes"'), 'top level is not indented');
  assert.ok(text.split('\n').length < 200, `${text.split('\n').length} lines is a wall of numbers`);
});

test('a file from elsewhere is refused rather than half read', () => {
  assert.throws(() => decodeSession('not json at all', SETTINGS), SessionError);
  assert.throws(() => decodeSession('{"format":"something-else"}', SETTINGS), SessionError);
  assert.throws(
    () => decodeSession(JSON.stringify({ format: SESSION_FORMAT, version: 99 }), SETTINGS),
    SessionError,
  );
});

test('a lane the file does not carry loads blank', () => {
  // Older files, and anything a future lane gets added to.
  const text = encodeSession(sample());
  const parsed = JSON.parse(text) as { lanes: Record<string, unknown> };
  delete parsed.lanes.reverb;

  const after = decodeSession(JSON.stringify(parsed), SETTINGS);
  assert.equal(after.lanes.reverb.values.length, LANE_SAMPLES);
  assert.ok(Number.isNaN(after.lanes.reverb.values[0]!));
  assert.ok(after.lanes.pitch.values[200]! > 0, 'the rest of the file should still load');
});

test('the pitch settings come back, and an older file falls back to Hertz', () => {
  const before = sample();
  before.settings = { ...SETTINGS, pitchMode: 'notes', markMode: 'dots', root: 2, scale: 'major' };
  const after = decodeSession(encodeSession(before), SETTINGS);
  assert.equal(after.settings.pitchMode, 'notes');
  assert.equal(after.settings.markMode, 'dots');
  assert.equal(after.settings.root, 2);
  assert.equal(after.settings.scale, 'major');

  // A file saved before notes existed has no pitchMode at all.
  const parsed = JSON.parse(encodeSession(sample())) as { settings: Record<string, unknown> };
  delete parsed.settings.pitchMode;
  assert.equal(decodeSession(JSON.stringify(parsed), SETTINGS).settings.pitchMode, 'hertz');
});
