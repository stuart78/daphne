/**
 * Bringing a MIDI file into the session.
 *
 * The same shape as the scan importer: the package does the work and knows
 * nothing about browsers, and this turns its lane contours into the lanes the
 * rest of the app already understands. A MIDI line and a drawn line are the
 * same thing by the time they reach the engine.
 */

import { importMidi, type MidiImport, type PerformOptions } from '@oramics/midi';

import { LANE_DEFS, LANE_SAMPLES, makeAllLanes, roleFor, type LaneMap } from './lanes.js';

export interface MidiResult {
  lanes: LaneMap;
  /** Speed the transport has to run at for the piece to sound like the file. */
  rate: number;
  summary: string;
  /** True when the file said more than the machine can. */
  lossy: boolean;
}

/**
 * Mark every unbroken stretch as its own stroke.
 *
 * A note is a gesture, and the gaps between notes are real. Without this the
 * pad would draw one line from the first note to the last, straight through
 * every rest, which is a lie about the piece.
 */
const strokesFrom = (values: Float32Array): Int32Array => {
  const out = new Int32Array(values.length);
  let id = 0;
  let inRun = false;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i]!)) {
      if (!inRun) {
        id++;
        inRun = true;
      }
      out[i] = id;
    } else {
      inRun = false;
    }
  }
  return out;
};

const describe = (result: MidiImport): string => {
  const parts: string[] = [];
  parts.push(`${result.notes} notes`);
  if (result.parts > 1) parts.push(`${result.parts} parts across ${Math.min(result.parts, 4)} timbres`);
  if (result.rate !== 1) parts.push(`${result.fileDuration.toFixed(0)} s fitted, speed ${result.rate.toFixed(2)}x`);
  if (result.masked > 0) parts.push(`${result.masked} notes dropped under the top line`);
  if (result.outOfRange > 0) {
    parts.push(
      'NOTE' in result.lanes
        ? `${result.outOfRange} notes outside octaves 1 to 8`
        : `${result.outOfRange} notes above 1000 Hz`,
    );
  }
  return parts.join(', ');
};

export const toSession = (result: MidiImport): MidiResult => {
  const lanes = makeAllLanes();
  const layout = 'NOTE' in result.lanes ? 'TONE' : 'FULL';
  for (const def of LANE_DEFS) {
    const role = roleFor(def, layout);
    const raw = role ? result.lanes[role] : undefined;
    if (!raw) continue;
    const values = new Float32Array(LANE_SAMPLES);
    for (let i = 0; i < LANE_SAMPLES; i++) {
      const j = Math.round((i / (LANE_SAMPLES - 1)) * (raw.length - 1));
      const v = raw[Math.max(0, Math.min(raw.length - 1, j))]!;
      values[i] = Number.isFinite(v) ? v : Number.NaN;
    }
    lanes[def.name] = { values, strokes: strokesFrom(values) };
  }

  return {
    lanes,
    rate: result.rate,
    summary: describe(result),
    lossy: result.masked > 0 || result.outOfRange > 0,
  };
};

export const readMidiFile = async (file: Blob, opts: PerformOptions = {}): Promise<MidiResult> =>
  toSession(
    importMidi(new Uint8Array(await file.arrayBuffer()), { columns: LANE_SAMPLES, ...opts }),
  );
