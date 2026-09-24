import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAITHFUL } from '@oramics/engine';
import { parseMidi, transcribe, writeMidi } from '@oramics/midi';

import { bounce, encodeWav } from './bounce.js';
import { LANE_SAMPLES, makeSlideField } from './lanes.js';

const SHEET_S = 4;

/** A short sheet: A440 in Hertz mode, loud for the first half, silent after. */
const input = (globalSpeed = 1) => {
  const pitch = new Float32Array(LANE_SAMPLES).fill(0.44); // 440 Hz on a 1000 Hz strip
  const amp1 = new Float32Array(LANE_SAMPLES).fill(Number.NaN);
  amp1.fill(0.8, 0, LANE_SAMPLES / 2);
  return {
    lanes: { pitch, amp1 },
    slides: Array.from({ length: 4 }, makeSlideField),
    globalSpeed,
    vibratoCents: 0,
    fidelity: FAITHFUL,
    pitchMode: 'hertz' as const,
    durationS: SHEET_S,
    sampleRate: 16000,
    tailSeconds: 1,
  };
};

test('one pass of the sheet, then the tail', () => {
  const result = bounce(input());
  const seconds = result.audio.length / result.sampleRate;
  assert.ok(Math.abs(seconds - (SHEET_S + 1)) < 0.05, `rendered ${seconds} s`);
  assert.ok(!result.truncated);
});

test('the speed sets how long the pass takes', () => {
  const result = bounce(input(2));
  const seconds = result.audio.length / result.sampleRate;
  assert.ok(Math.abs(seconds - (SHEET_S / 2 + 1)) < 0.05, `rendered ${seconds} s at double speed`);
});

test('it sounds where the amplitude is drawn and not after', () => {
  const { audio, sampleRate } = bounce(input());
  const rms = (from: number, to: number): number => {
    let s = 0;
    for (let i = Math.round(from * sampleRate); i < Math.round(to * sampleRate); i++) s += audio[i]! ** 2;
    return Math.sqrt(s / ((to - from) * sampleRate));
  };
  assert.ok(rms(0.5, 1.5) > 0.01, 'should sound in the drawn half');
  assert.ok(rms(3.5, 4) < rms(0.5, 1.5) / 20, 'should have died away well before the end');
});

test('the trace becomes one A in MIDI, lasting as long as it sounded', () => {
  const { trace } = bounce(input());
  const t = transcribe(trace);
  const song = parseMidi(writeMidi(t.notes, t.controls, { bendRange: t.bendRange }));
  assert.equal(song.notes.length, 1);
  assert.equal(song.notes[0]!.note, 69);
  // The light bulb takes a moment to come up and to die away, so allow slack.
  assert.ok(Math.abs(song.notes[0]!.seconds - SHEET_S / 2) < 0.5, `${song.notes[0]!.seconds} s`);
});

test('a WAV header says what is in it', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 2]), 48000);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 8);
  // Scaled as a whole so the loudest sample sits at -1 dB, the rest in proportion.
  const loudest = view.getInt16(50, true) / 32767;
  assert.ok(Math.abs(loudest - 10 ** (-1 / 20)) < 0.001, `peak ${loudest}`);
  assert.ok(Math.abs(view.getInt16(46, true) / view.getInt16(50, true) - 0.25) < 0.01);
});

test('with Mono off the file is stereo and the pan is in it', () => {
  const result = bounce({ ...input(), fidelity: { ...FAITHFUL, monoSum: false }, pan: [-1, 0, 0, 0] });
  assert.ok(result.right, 'a stereo render should have a right channel');
  const energy = (buf: Float32Array): number => buf.reduce((s, v) => s + v * v, 0);
  assert.ok(energy(result.right!) < energy(result.audio) * 1e-3, 'timbre 1 is hard left');

  const wav = encodeWav(result.audio, result.sampleRate, result.right);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(40, true), result.audio.length * 4);
});

test('with Mono on the file is mono', () => {
  assert.equal(bounce(input()).right, null);
});

test('a quiet piece is brought up to the same peak', () => {
  const wav = encodeWav(new Float32Array([0, 0.02, -0.05]), 48000);
  const view = new DataView(wav.buffer);
  assert.ok(Math.abs(view.getInt16(48, true) / 32767 + 10 ** (-1 / 20)) < 0.001);
});

test('the render honours delay mode and the reverb space', () => {
  // A short burst, then nothing: what is left afterwards is the effect.
  const short = { ...input(), tailSeconds: 2 };
  const amp1 = new Float32Array(LANE_SAMPLES).fill(Number.NaN);
  amp1.fill(1, 0, 60);
  const lanes = { ...short.lanes, amp1, vibrato: new Float32Array(LANE_SAMPLES).fill(0.6) };
  const after = (result: { audio: Float32Array; sampleRate: number }): number => {
    let sum = 0;
    for (let i = Math.round(result.sampleRate * 1.5); i < result.audio.length; i++) {
      sum += result.audio[i]! ** 2;
    }
    return sum;
  };

  const dry = bounce({ ...short, lanes, vibratoMode: 'vibrato' });
  const echoed = bounce({ ...short, lanes, vibratoMode: 'delay', echoFeedback: 0.6 });
  assert.ok(after(echoed) > after(dry) * 10, 'the echoes should still be sounding');

  // The room is the shorter space, so its send leaves less behind.
  const wet = { ...short, lanes: { ...lanes, reverb: new Float32Array(LANE_SAMPLES).fill(1) } };
  assert.ok(after(bounce({ ...wet, reverbSpace: 'room' })) < after(bounce({ ...wet, reverbSpace: 'plate' })));
});
