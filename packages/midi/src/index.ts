/**
 * Importing a MIDI file.
 *
 * Parsing is one thing and laying the result on the machine is another, so they
 * are separate: `smf.ts` turns bytes into notes and controllers, `perform.ts`
 * decides what a machine with one pitch strip and four timbres can do with them.
 * The second is where the opinions live.
 *
 * No DOM and no Node, like the engine and the vision package, so the same code
 * runs in the app and in a test.
 */

export * from './smf.js';
export * from './perform.js';
export * from './write.js';
export * from './transcribe.js';

import { parseMidi } from './smf.js';
import { perform, type PerformOptions, type Performance } from './perform.js';

export interface MidiImport extends Performance {
  name: string | null;
  /** Seconds the file lasts, before anything is fitted to the sheet. */
  fileDuration: number;
  parts: number;
  notes: number;
}

/** Read a file and lay it out, in one call. */
export const importMidi = (bytes: Uint8Array, opts: PerformOptions = {}): MidiImport => {
  const song = parseMidi(bytes);
  if (song.notes.length === 0) throw new Error('That MIDI file has no notes in it.');
  return {
    ...perform(song, opts),
    name: song.name,
    fileDuration: song.duration,
    parts: song.parts,
    notes: song.notes.length,
  };
};
