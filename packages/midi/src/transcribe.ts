/**
 * Turning a performance back into MIDI.
 *
 * The input is not the drawing but a trace of what the machine actually did,
 * sampled every few milliseconds while it played: the pitch the sheet asked
 * for, the pitch that came out after the relays and the vibrato, and how loud
 * the voice was. Working from the trace means the transport strip, the speed
 * and the relays are already accounted for, and the file plays in time with a
 * bounce of the same sheet.
 *
 * What a MIDI note cannot say is carried alongside it:
 *
 *   pitch bend    the distance from the note to what actually sounded, so a
 *                 glide or a vibrato survives instead of being flattened
 *   expression    CC 11 follows the level, since the machine's amplitude is a
 *                 contour rather than a strike
 *
 * Velocity is fixed. The machine has no attack to measure: its level comes up
 * through a light bulb and a photocell, and the shape is in the expression.
 */

import type { ControlEvent, NoteEvent } from './smf.js';

export interface Trace {
  /** Seconds between samples. */
  step: number;
  /** Requested pitch per sample, Hz. */
  targetHz: Float32Array;
  /** Sounding pitch per sample, Hz. */
  hz: Float32Array;
  /** Loudness per sample, 0-1. */
  level: Float32Array;
}

export interface Transcription {
  notes: NoteEvent[];
  controls: ControlEvent[];
  /** The bend range the bends were written for, in semitones. */
  bendRange: number;
}

/** A note starts above this level and ends below the lower one. */
const ON_LEVEL = 0.03;
const OFF_LEVEL = 0.015;
/** Semitones the pitch must move from the held note before it becomes a new note. */
const NOTE_HYSTERESIS = 0.6;
/** Smallest changes worth writing, so a steady note is not a flood of events. */
const BEND_STEP = 0.02; // semitones
const LEVEL_STEP = 1 / 127;
/** Wide, because vibrato on the machine can reach four semitones. */
const BEND_RANGE = 12;
const VELOCITY = 100 / 127;

const semitones = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

export const transcribe = (trace: Trace): Transcription => {
  const notes: NoteEvent[] = [];
  const controls: ControlEvent[] = [];
  const { step, targetHz, hz, level } = trace;

  let note = -1;
  let startedAt = 0;
  let lastBend = Number.NaN;
  let lastLevel = -1;

  const end = (at: number): void => {
    if (note < 0) return;
    notes.push({ at: startedAt, seconds: at - startedAt, note, velocity: VELOCITY, channel: 0, track: 0 });
    note = -1;
  };

  for (let i = 0; i < level.length; i++) {
    const at = i * step;
    const v = level[i]!;
    const target = targetHz[i]!;
    const playable = target > 8 && Number.isFinite(target);
    const sounding = playable && (note >= 0 ? v > OFF_LEVEL : v > ON_LEVEL);

    if (!sounding) {
      end(at);
      continue;
    }

    const wanted = semitones(target);
    if (note >= 0 && Math.abs(wanted - note) > NOTE_HYSTERESIS) end(at);
    if (note < 0) {
      note = Math.max(0, Math.min(127, Math.round(wanted)));
      startedAt = at;
      lastBend = Number.NaN; // always restate the bend for a new note
    }

    const bend = Math.max(-1, Math.min(1, (semitones(hz[i]!) - note) / BEND_RANGE));
    if (!(Math.abs(bend - lastBend) * BEND_RANGE < BEND_STEP)) {
      controls.push({ at, controller: -1, value: bend, channel: 0, track: 0 });
      lastBend = bend;
    }
    if (Math.abs(v - lastLevel) >= LEVEL_STEP) {
      controls.push({ at, controller: 11, value: Math.min(1, v), channel: 0, track: 0 });
      lastLevel = v;
    }
  }
  end(level.length * step);

  return { notes, controls, bendRange: BEND_RANGE };
};
