/**
 * Writing a Standard MIDI File.
 *
 * The opposite of smf.ts, and much smaller: one track, format 0, a fixed tempo,
 * and times in seconds converted to ticks at a resolution fine enough that
 * nothing audible moves. Everything the machine did is already baked into the
 * times, so there is no tempo map to preserve.
 */

import type { ControlEvent, NoteEvent } from './smf.js';

/** Ticks per quarter note. At 120 bpm that is 960 ticks a second. */
const DIVISION = 480;
const BPM = 120;
const TICKS_PER_SECOND = (DIVISION * BPM) / 60;

export interface WriteOptions {
  /** Semitones a full pitch bend covers. Written into the file as RPN 0. */
  bendRange?: number;
  /** Track name. */
  name?: string;
}

interface Timed {
  tick: number;
  /** Tie-break at one tick: note-offs, then controls, then note-ons. */
  order: number;
  bytes: number[];
}

const varint = (value: number): number[] => {
  const out = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return out;
};

const u32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));

const ticks = (seconds: number): number => Math.max(0, Math.round(seconds * TICKS_PER_SECOND));

/**
 * One channel of notes and controllers as a format 0 file.
 *
 * Controllers use `controller: -1` for pitch bend, as the reader does, with the
 * value from -1 to 1. Everything else is 0 to 1.
 */
export const writeMidi = (
  notes: NoteEvent[],
  controls: ControlEvent[] = [],
  opts: WriteOptions = {},
): Uint8Array => {
  const bendRange = opts.bendRange ?? 2;
  const events: Timed[] = [];

  const usec = Math.round(60_000_000 / BPM);
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (usec >> 16) & 0xff, (usec >> 8) & 0xff, usec & 0xff] });
  if (opts.name) {
    const text = [...new TextEncoder().encode(opts.name)];
    events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...varint(text.length), ...text] });
  }
  // Say how far a bend reaches rather than trusting the synth's default.
  events.push(
    { tick: 0, order: 1, bytes: [0xb0, 101, 0] },
    { tick: 0, order: 1, bytes: [0xb0, 100, 0] },
    { tick: 0, order: 1, bytes: [0xb0, 6, clamp7(bendRange)] },
    { tick: 0, order: 1, bytes: [0xb0, 101, 127] },
    { tick: 0, order: 1, bytes: [0xb0, 100, 127] },
  );

  for (const c of controls) {
    if (c.controller === -1) {
      const v = Math.max(0, Math.min(16383, Math.round((c.value + 1) * 8192)));
      events.push({ tick: ticks(c.at), order: 2, bytes: [0xe0 | c.channel, v & 0x7f, v >> 7] });
    } else {
      events.push({ tick: ticks(c.at), order: 2, bytes: [0xb0 | c.channel, c.controller, clamp7(c.value * 127)] });
    }
  }

  for (const n of notes) {
    const on = ticks(n.at);
    // A note always lasts at least a tick, or the off lands before the on.
    const off = Math.max(on + 1, ticks(n.at + n.seconds));
    events.push({ tick: on, order: 3, bytes: [0x90 | n.channel, n.note, Math.max(1, clamp7(n.velocity * 127))] });
    events.push({ tick: off, order: 0, bytes: [0x80 | n.channel, n.note, 0] });
  }

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  let previous = 0;
  for (const e of events) {
    track.push(...varint(e.tick - previous), ...e.bytes);
    previous = e.tick;
  }
  track.push(0, 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (DIVISION >> 8) & 0xff, DIVISION & 0xff];
  return Uint8Array.from([...header, 0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track]);
};
