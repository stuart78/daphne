/**
 * Laying a MIDI file onto the machine.
 *
 * This is the part with opinions in it, because the machine is not a synth that
 * happens to lack polyphony. It has one pitch strip and four amplitude strips,
 * and the four amplitudes are the four timbres of a single voice, not four
 * voices. A chord cannot be represented at all. Neither can two parts at
 * different pitches.
 *
 * So a file is reduced to one line. The highest sounding note wins by default,
 * which is what a listener hears as the tune, and everything under it becomes
 * silence rather than something the sheet cannot say. That is a real loss and
 * the importer reports it rather than hiding it.
 *
 * What the other lanes get:
 *
 *   amplitude   the sounding note's velocity, in the timbre belonging to the
 *               part it came from, so an arrangement moving between parts
 *               changes timbre the way Oram would have by hand
 *   vibrato     the modulation wheel, or the pitch bend where there is no wheel
 *   reverb      the reverb send, CC 91
 *
 * Nothing is written to the transport strip. A blank transport is normal speed,
 * and a MIDI file has already had its tempo baked into the note times.
 */

import { LOWEST_OCTAVE, NOTE_ROWS, OCTAVE_ROWS, rowValue } from '@oramics/engine';
import { PITCH_MAX_HZ } from '@oramics/template';

import type { ControlEvent, NoteEvent, Song } from './smf.js';

export interface PerformOptions {
  /** Seconds the sheet represents. */
  duration?: number;
  /** Samples per lane. */
  columns?: number;
  /** Which note wins when several sound at once. */
  voice?: 'highest' | 'lowest';
  /**
   * What to do with a file longer than the sheet.
   *
   * `fit` slows the sheet down so the whole piece lands on it, which keeps every
   * note at the cost of the tempo. `truncate` keeps the tempo and takes the
   * opening. Fitting is the default because a workshop wants the tune.
   */
  longer?: 'fit' | 'truncate';
  /** Semitones a full pitch bend covers. Two is the near-universal default. */
  bendRange?: number;
  /**
   * Which pitch strips to write.
   *
   * `hertz` writes one line on the Hertz strip. `notes` writes a note row and
   * an octave row, for the note-and-octave sheet, which is what a MIDI note
   * already is. Bends go to the vibrato strip either way; a note row has no
   * room for them.
   */
  pitch?: 'hertz' | 'notes';
}

export interface Performance {
  /** One contour per lane, keyed by role id, NaN where nothing is written. */
  lanes: Record<string, Float32Array>;
  /** Seconds of the file that reached the sheet. */
  used: number;
  /** Playback rate the sheet has to run at to sound like the file. */
  rate: number;
  /** Notes dropped because something higher was sounding. */
  masked: number;
  /** Notes that fell outside what the pitch strip can spell. */
  outOfRange: number;
  /** How many parts were found, and which timbre each was given. */
  timbres: Record<number, number>;
}

/** Equal temperament, A440. The machine then rounds it to whole Hertz itself. */
export const noteToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

const LANES = ['PCH', 'AMP1', 'AMP2', 'AMP3', 'AMP4', 'VIB', 'REV', 'TRN'];
const TONAL_LANES = ['NOTE', 'OCT', 'AMP1', 'AMP2', 'AMP3', 'AMP4', 'VIB', 'REV', 'TRN'];

/** Latest control value at or before a time, or null if there was never one. */
const controlAt = (events: ControlEvent[], at: number): number | null => {
  let value: number | null = null;
  for (const e of events) {
    if (e.at > at) break;
    value = e.value;
  }
  return value;
};

export const perform = (song: Song, opts: PerformOptions = {}): Performance => {
  const duration = opts.duration ?? 30;
  const columns = opts.columns ?? 3000;
  const bendRange = opts.bendRange ?? 2;
  const notes = opts.pitch === 'notes';

  const lanes: Record<string, Float32Array> = {};
  for (const role of notes ? TONAL_LANES : LANES) lanes[role] = new Float32Array(columns).fill(Number.NaN);

  /*
   * Fit or truncate.
   *
   * Fitting does not resample anything: it maps the file's seconds onto the
   * sheet's and reports the rate the sheet has to run at. The app sets its
   * transport speed from that, so the piece plays at its own tempo on a sheet
   * that is only thirty seconds long.
   */
  const fit = (opts.longer ?? 'fit') === 'fit' && song.duration > duration;
  const span = fit ? song.duration : duration;
  const rate = fit ? song.duration / duration : 1;
  const used = Math.min(song.duration, span);

  // Parts get timbres in the order they first sound, so the first thing you hear
  // is timbre one.
  const timbres: Record<number, number> = {};
  for (const note of [...song.notes].sort((a, b) => a.at - b.at)) {
    if (timbres[note.track] === undefined) {
      timbres[note.track] = Object.keys(timbres).length % 4;
    }
  }

  const bends = song.controls.filter((c) => c.controller === -1);
  const wheels = song.controls.filter((c) => c.controller === 1);
  const reverbs = song.controls.filter((c) => c.controller === 91);
  const hasWheel = wheels.length > 0;

  let masked = 0;
  const seen = new Set<NoteEvent>();
  const unplayable = new Set<NoteEvent>();

  for (let i = 0; i < columns; i++) {
    const at = (span * i) / (columns - 1);
    if (at > song.duration) break;

    // Everything sounding at this instant.
    let winner: NoteEvent | null = null;
    let others = 0;
    for (const note of song.notes) {
      if (note.at > at) continue;
      if (at >= note.at + Math.max(note.seconds, 1e-4)) continue;
      if (!winner) {
        winner = note;
        continue;
      }
      others++;
      const better = (opts.voice ?? 'highest') === 'lowest' ? note.note < winner.note : note.note > winner.note;
      if (better) {
        seen.add(winner);
        winner = note;
      } else {
        seen.add(note);
      }
    }
    if (others > 0) masked = seen.size;
    if (!winner) continue;

    const bend = controlAt(bends, at) ?? 0;
    if (notes) {
      const octave = Math.floor(winner.note / 12) - 1 - LOWEST_OCTAVE;
      if (octave < 0 || octave >= OCTAVE_ROWS) {
        unplayable.add(winner);
        continue;
      }
      lanes.NOTE![i] = rowValue(winner.note % 12, NOTE_ROWS);
      lanes.OCT![i] = rowValue(octave, OCTAVE_ROWS);
    } else {
      const hz = noteToHz(winner.note + bend * bendRange);
      if (hz > PITCH_MAX_HZ) {
        unplayable.add(winner);
        continue;
      }
      lanes.PCH![i] = Math.max(0, Math.min(1, hz / PITCH_MAX_HZ));
    }

    const timbre = timbres[winner.track] ?? 0;
    lanes[`AMP${timbre + 1}`]![i] = winner.velocity;

    /*
     * Vibrato from the wheel where there is one, and from the bend where there
     * is not. The lane is a deviation either side of centre, which is what the
     * machine's vibrato strip is, so a wheel at rest reads as no wobble rather
     * than as a wobble of nothing.
     */
    const wheel = hasWheel ? controlAt(wheels, at) : null;
    if (wheel !== null) lanes.VIB![i] = 0.5 + wheel * 0.5;
    else if (bend !== 0) lanes.VIB![i] = Math.max(0, Math.min(1, 0.5 + bend * 0.5));

    const reverb = controlAt(reverbs, at);
    if (reverb !== null) lanes.REV![i] = reverb;
  }

  return { lanes, used, rate, masked, outOfRange: unplayable.size, timbres };
};
