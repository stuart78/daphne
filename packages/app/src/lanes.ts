/**
 * The lane set the UI presents, matching the printed sheet band for band so a
 * scanned page and an on-screen drawing are the same thing.
 */

import {
  DEFAULT_OCTAVE,
  LOWEST_OCTAVE,
  OCTAVE_ROWS,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  rowValue,
  type LaneName,
} from '@oramics/engine';
import type { Layout } from '@oramics/template';

export { SLIDE_WIDTH, SLIDE_HEIGHT };

/**
 * Samples per lane. The field is 300 mm, so this is 10 samples per millimetre —
 * finer than anything a pen can resolve, and 100 samples per second of audio.
 */
export const LANE_SAMPLES = 3000;

/** Points per drawn waveform cycle. The engine resamples to its own table size. */
export const TIMBRE_SAMPLES = 512;

export interface LaneDef {
  /** Engine lane. */
  name: LaneName;
  /** Role id on the printed sheet, used as the PDF overlay key. */
  role: string;
  label: string;
  hint: string;
  /** Value the engine falls back to where nothing is drawn. */
  rest: number;
  /** Undrawn stretches sustain the last value instead of resting. */
  hold?: boolean;
  /** Draw a centre line and read deviation from it. */
  bipolar: boolean;
  /** Relative height, mirroring the printed band weights. */
  weight: number;
  /** Not yet wired to anything in the engine. */
  pending?: boolean;
  /** Only shown when pitch is read as notes. */
  notesOnly?: boolean;
}

export const LANE_DEFS: LaneDef[] = [
  { name: 'pitch', role: 'PCH', label: 'Pitch', hint: 'height = Hertz, linear', rest: 0.5, hold: true, bipolar: false, weight: 2.4 },
  {
    name: 'octave',
    role: 'OCT',
    label: 'Octave',
    hint: 'one row per octave',
    rest: rowValue(DEFAULT_OCTAVE - LOWEST_OCTAVE, OCTAVE_ROWS),
    hold: true,
    bipolar: false,
    // Eight rows want about the same row height as the note band's twelve.
    weight: 2.1,
    notesOnly: true,
  },
  { name: 'amp1', role: 'AMP1', label: 'Amplitude 1', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'amp2', role: 'AMP2', label: 'Amplitude 2', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'amp3', role: 'AMP3', label: 'Amplitude 3', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'amp4', role: 'AMP4', label: 'Amplitude 4', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'vibrato', role: 'VIB', label: 'Vibrato', hint: 'wobble around the centre', rest: 0.5, bipolar: true, weight: 1.1 },
  { name: 'reverb', role: 'REV', label: 'Reverberation', hint: 'up = wetter', rest: 0, bipolar: false, weight: 1 },
  { name: 'transport', role: 'TRN', label: 'Transport', hint: 'centre = normal speed', rest: 0.5, hold: true, bipolar: true, weight: 1 },
];

/**
 * One lane: a value per column, and which stroke put it there.
 *
 * The values are what the engine reads and what the extractor will produce from
 * a scanned sheet. The stroke ids exist only for drawing. A lane holds one
 * value per column, so a new stroke laid over an old one necessarily replaces
 * it — there is no second value to keep. Without a record of where one stroke
 * ended and the next began, the two get joined into a single line and the new
 * mark reads as an extension of the old one rather than as a mark of its own.
 *
 * Zero means "no stroke recorded": blank columns, and anything imported from a
 * scan, where nobody can say which pen stroke a pixel came from.
 */
export interface LaneTrack {
  /** Normalised 0-1, NaN where nothing was drawn. */
  values: Float32Array;
  /** Stroke id per column, 0 where blank or unknown. */
  strokes: Int32Array;
}

/**
 * A blank lane is NaN, not a flat line at rest.
 *
 * Blank means "nothing drawn here", which is a different thing from "drawn at
 * zero" and is what a scanned sheet is mostly made of. The engine falls back to
 * the lane's rest value or holds the last one, depending on the lane.
 */
export const makeLane = (_def?: LaneDef): LaneTrack => ({
  values: new Float32Array(LANE_SAMPLES).fill(Number.NaN),
  strokes: new Int32Array(LANE_SAMPLES),
});

/** A sine, so an untouched timbre still sounds like something. */
export const makeTimbre = (): Float32Array => {
  const out = new Float32Array(TIMBRE_SAMPLES);
  for (let i = 0; i < TIMBRE_SAMPLES; i++) {
    out[i] = Math.sin((2 * Math.PI * i) / TIMBRE_SAMPLES);
  }
  return out;
};

/** The shapes a slide can be painted with in one go. Blank is clear glass. */
export type SlideShape = 'blank' | 'sine' | 'saw' | 'square';

/** One cycle of each shape, phase 0-1 to height -1 to 1. */
const SHAPES: Record<Exclude<SlideShape, 'blank'>, (phase: number) => number> = {
  sine: (p) => Math.sin(2 * Math.PI * p),
  // Rises across the cycle and drops at the end. The servo cannot follow the
  // drop instantly, so the edge rounds off the way a painted one would.
  saw: (p) => 2 * p - 1,
  square: (p) => (p < 0.5 ? 1 : -1),
};

/**
 * A glass slide with one ribbon painted on it in a given shape. The stroke is
 * comfortably wider than the spot, as Oram's are, so the scanner has something
 * to lock onto.
 */
export const paintSlide = (shape: SlideShape): Float32Array => {
  const field = new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT);
  // Clear glass: nothing for the spot to ride, so the timbre falls silent.
  if (shape === 'blank') return field;
  const thickness = Math.round(SLIDE_HEIGHT * 0.14);
  const wave = SHAPES[shape];
  for (let x = 0; x < SLIDE_WIDTH; x++) {
    const v = wave(x / SLIDE_WIDTH);
    const top = Math.round(((1 - v) / 2) * (SLIDE_HEIGHT - 1 - thickness));
    for (let y = top; y < top + thickness; y++) field[y * SLIDE_WIDTH + x] = 1;
  }
  return field;
};

/** A sine slide, so a fresh timbre sounds like something. */
export const makeSlideField = (): Float32Array => paintSlide('sine');

export type LaneMap = Record<LaneName, LaneTrack>;

export const makeAllLanes = (): LaneMap =>
  Object.fromEntries(LANE_DEFS.map((d) => [d.name, makeLane(d)])) as LaneMap;

/**
 * The printed band a lane is read from, on a given sheet.
 *
 * Pitch lives in one band on the original sheet and two on the note-and-octave
 * one, so the same lane has a different band name depending on which sheet it
 * came from or is going to. The octave lane has no band at all on the original.
 */
export const roleFor = (def: LaneDef, layout: Layout): string | null => {
  if (def.name === 'pitch') return layout === 'TONE' ? 'NOTE' : 'PCH';
  if (def.name === 'octave') return layout === 'TONE' ? 'OCT' : null;
  return def.role;
};
