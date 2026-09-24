/**
 * The performance file: what was drawn, not what was scanned.
 *
 * Plain JSON, one object, documented below and in the README. No framing, no
 * compression, no custom binary. A workshop produces material that outlives the
 * software that made it, and the cost of being able to open a file in a text
 * editor in ten years is a few hundred kilobytes today.
 *
 * The one exception is the painted slides. Those are 512 x 256 opacity fields,
 * and 131072 numbers each written out as decimals would dwarf everything else,
 * so they are base64 of one byte per pixel with the layout spelled out in the
 * file itself.
 *
 * What this is not: it holds extracted performance data, not the scan it came
 * from. A drawn lane and a lane lifted off a photographed sheet are the same
 * thing by the time they reach here, which is the point.
 *
 * ```json
 * {
 *   "format": "daphne-performance",
 *   "version": 1,
 *   "duration": 30,            // seconds the field represents
 *   "columns": 3000,           // samples per lane
 *   "lanes": {
 *     "pitch": {
 *       "values": [null, 0.5, ...],   // 0-1 per column, null where undrawn
 *       "strokes": [[120, 480]]       // inclusive column ranges, one per stroke
 *     }
 *   },
 *   "slides": [
 *     { "width": 512, "height": 256, "layout": "row-major-u8", "opacity": "<base64>" }
 *   ],
 *   "settings": { "globalSpeed": 1, "vibratoCents": 50, "fidelity": {}, ... }
 * }
 * ```
 */

import type { Fidelity, PitchMode, ReverbSpace, Unison, VibratoMode } from '@oramics/engine';

import type { MarkMode } from './music.js';

import { LANE_DEFS, LANE_SAMPLES, SLIDE_HEIGHT, SLIDE_WIDTH, makeAllLanes, type LaneMap } from './lanes.js';

export const SESSION_FORMAT = 'daphne-performance';
export const SESSION_VERSION = 1;
export const SESSION_EXTENSION = 'daphne';

/** Decimal places kept per sample. A lane is 3000 columns over 300 mm of paper. */
const PLACES = 4;

export interface SessionSettings {
  globalSpeed: number;
  vibratoCents: number;
  fidelity: Fidelity;
  /** Pitch as one Hertz line or as a note and an octave. */
  pitchMode: PitchMode;
  /** How note and octave marks are read. */
  markMode: MarkMode;
  /** Root of the key as a row, 0 for C. */
  root: number;
  /** Scale id, see music.ts. */
  scale: string;
  /** Detuned voices per timbre. One voice is the machine as built. */
  unison: Unison[];
  /** The preset each timbre was set from, '' if painted since. For the label only. */
  presets: string[];
  /** Where each timbre sits, -1 left to 1 right. Heard only with Mono off. */
  pan: number[];
  /** What the vibrato strip drives: the pitch, or an echo's time. */
  vibratoMode: VibratoMode;
  /** How much of the echo goes back round, 0 to 0.95. */
  echoFeedback: number;
  /** Where the reverb send goes. */
  reverbSpace: ReverbSpace;
}

export interface Session {
  lanes: LaneMap;
  slides: Float32Array[];
  settings: SessionSettings;
}

// --- writing ---------------------------------------------------------------

/**
 * JSON with objects indented and number arrays left on one line.
 *
 * `JSON.stringify(value, null, 2)` would put each of the 24000 lane samples on
 * its own line, which makes the file unreadable in exactly the way indenting
 * was supposed to prevent.
 */
const stringify = (value: unknown, indent = ''): string => {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v === 'number')) return JSON.stringify(value);
    if (value.length === 0) return '[]';
    const inner = indent + '  ';
    return `[\n${value.map((v) => inner + stringify(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const inner = indent + '  ';
    const body = entries
      .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringify(v, inner)}`)
      .join(',\n');
    return `{\n${body}\n${indent}}`;
  }
  return JSON.stringify(value ?? null);
};

const encodeBytes = (bytes: Uint8Array): string => {
  // In chunks: String.fromCharCode(...bytes) on 131072 arguments overflows the
  // call stack.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const decodeBytes = (text: string): Uint8Array => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/** Maximal runs of one stroke id, as inclusive column ranges. */
const strokeRanges = (strokes: Int32Array): [number, number][] => {
  const ranges: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < strokes.length; i++) {
    const id = strokes[i]!;
    const previous = i > 0 ? strokes[i - 1]! : 0;
    if (id !== 0 && id !== previous) {
      if (start >= 0) ranges.push([start, i - 1]);
      start = i;
    } else if (id === 0 && start >= 0) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) ranges.push([start, strokes.length - 1]);
  return ranges;
};

const round = (v: number): number | null =>
  Number.isFinite(v) ? Number(v.toFixed(PLACES)) : null;

export const encodeSession = (session: Session): string => {
  const lanes: Record<string, unknown> = {};
  for (const def of LANE_DEFS) {
    const track = session.lanes[def.name];
    lanes[def.name] = {
      values: Array.from(track.values, round),
      strokes: strokeRanges(track.strokes),
    };
  }

  return stringify({
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    duration: 30,
    columns: LANE_SAMPLES,
    lanes,
    slides: session.slides.map((field) => ({
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      // Spelled out so the file explains itself: one byte per pixel, left to
      // right then top to bottom, 0 clear glass and 255 opaque enamel.
      layout: 'row-major-u8',
      opacity: encodeBytes(
        Uint8Array.from(field, (v) => Math.max(0, Math.min(255, Math.round(v * 255)))),
      ),
    })),
    settings: session.settings,
  });
};

// --- reading ---------------------------------------------------------------

export class SessionError extends Error {}

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionError(`${what} is missing or not an object`);
  }
  return value as Record<string, unknown>;
};

/**
 * Read a lane back, resampling if the file was written at another resolution.
 *
 * Nearest neighbour rather than interpolation, because a lane is mostly blank
 * and averaging across the edge of a mark would invent values in the gap.
 */
const readValues = (raw: unknown, name: string): Float32Array => {
  if (!Array.isArray(raw)) throw new SessionError(`lane ${name} has no values`);
  const out = new Float32Array(LANE_SAMPLES);
  for (let i = 0; i < LANE_SAMPLES; i++) {
    const v = raw[Math.min(raw.length - 1, Math.round((i / (LANE_SAMPLES - 1)) * (raw.length - 1)))];
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
  }
  return out;
};

const readStrokes = (raw: unknown, columns: number): Int32Array => {
  const out = new Int32Array(LANE_SAMPLES);
  if (!Array.isArray(raw)) return out;
  const scale = LANE_SAMPLES / Math.max(1, columns);
  raw.forEach((range, index) => {
    if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') return;
    const from = Math.max(0, Math.round(range[0] * scale));
    const to = Math.min(LANE_SAMPLES - 1, Math.round(range[1] * scale));
    for (let i = from; i <= to; i++) out[i] = index + 1;
  });
  return out;
};

const readSlide = (raw: unknown, index: number): Float32Array => {
  const slide = asRecord(raw, `slide ${index}`);
  if (slide.layout !== 'row-major-u8') {
    throw new SessionError(`slide ${index} has unknown layout "${String(slide.layout)}"`);
  }
  if (typeof slide.opacity !== 'string') throw new SessionError(`slide ${index} has no opacity data`);

  const width = typeof slide.width === 'number' ? slide.width : SLIDE_WIDTH;
  const height = typeof slide.height === 'number' ? slide.height : SLIDE_HEIGHT;
  const bytes = decodeBytes(slide.opacity);
  if (bytes.length !== width * height) {
    throw new SessionError(
      `slide ${index} says ${width}x${height} but carries ${bytes.length} bytes`,
    );
  }

  // Rescale if the file came from a build with a different glass size.
  const out = new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT);
  for (let y = 0; y < SLIDE_HEIGHT; y++) {
    const sy = Math.min(height - 1, Math.round((y / (SLIDE_HEIGHT - 1)) * (height - 1)));
    for (let x = 0; x < SLIDE_WIDTH; x++) {
      const sx = Math.min(width - 1, Math.round((x / (SLIDE_WIDTH - 1)) * (width - 1)));
      out[y * SLIDE_WIDTH + x] = bytes[sy * width + sx]! / 255;
    }
  }
  return out;
};

export const decodeSession = (text: string, fallback: SessionSettings): Session => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SessionError('not JSON');
  }

  const root = asRecord(parsed, 'file');
  if (root.format !== SESSION_FORMAT) {
    throw new SessionError(`not a Daphne performance (format "${String(root.format)}")`);
  }
  if (typeof root.version !== 'number' || root.version > SESSION_VERSION) {
    throw new SessionError(`version ${String(root.version)} is newer than this build reads`);
  }

  const columns = typeof root.columns === 'number' ? root.columns : LANE_SAMPLES;
  const rawLanes = asRecord(root.lanes, 'lanes');
  const lanes = makeAllLanes();
  for (const def of LANE_DEFS) {
    const raw = rawLanes[def.name];
    // A file that predates a lane, or omits one, leaves it blank rather than
    // failing the whole load.
    if (raw === undefined) continue;
    const lane = asRecord(raw, `lane ${def.name}`);
    lanes[def.name] = {
      values: readValues(lane.values, def.name),
      strokes: readStrokes(lane.strokes, columns),
    };
  }

  const rawSlides = Array.isArray(root.slides) ? root.slides : [];
  const slides = Array.from({ length: 4 }, (_, i) =>
    rawSlides[i] === undefined
      ? new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT)
      : readSlide(rawSlides[i], i),
  );

  const rawSettings = root.settings && typeof root.settings === 'object' ? root.settings : {};
  const settings = { ...fallback, ...(rawSettings as Partial<SessionSettings>) };
  settings.fidelity = { ...fallback.fidelity, ...(settings.fidelity ?? {}) };
  if (!Array.isArray(settings.unison) || settings.unison.length !== fallback.unison.length) {
    settings.unison = fallback.unison;
  }
  if (!Array.isArray(settings.presets) || settings.presets.length !== fallback.presets.length) {
    settings.presets = fallback.presets;
  }
  if (!Array.isArray(settings.pan) || settings.pan.length !== fallback.pan.length) {
    settings.pan = fallback.pan;
  }

  return { lanes, slides, settings };
};
