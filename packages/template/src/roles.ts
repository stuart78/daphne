/**
 * The characteristics a lane can be assigned to.
 *
 * Strips 1-10 of the original machine map onto: three pitch "neume" strips,
 * four amplitude strips (one per timbre), vibrato, reverberation, and
 * transport. The four waveform slides were static painted glass rather than
 * moving film, so they get a sheet whose x axis is one cycle instead of time.
 *
 * Every sheet shares the same field rectangle regardless of role. That is
 * deliberate: the extractor then has exactly one geometry to recover, and the
 * role only decides how the values inside that rectangle are interpreted.
 */

export type FieldKind =
  /** 0 at the bottom rail, 1 at the top rail. */
  | 'unipolar'
  /** -1 at the bottom rail, +1 at the top, 0 on a heavy centre line. */
  | 'bipolar'
  /** Logarithmic frequency, labelled in both Hz and note names. */
  | 'logpitch'
  /** Binary-coded decimal cells — the faithful neume encoding. */
  | 'bcd'
  /** One cycle of a waveform: x is phase, not time. */
  | 'cycle'
  /** Twelve rows, one per semitone, C at the bottom. */
  | 'notes'
  /** Eight rows, one per octave, the lowest at the bottom. */
  | 'octaves';

export interface ReferenceLine {
  /** 0 = bottom rail, 1 = top rail. */
  at: number;
  label: string;
}

export interface RoleDef {
  /** Short code embedded in the QR. Uppercase alphanumeric for QR alnum mode. */
  id: string;
  /** Printed title. */
  title: string;
  /** One-line description of what this characteristic does to the sound. */
  blurb: string;
  kind: FieldKind;
  /** Which strip of the original machine this corresponds to, if any. */
  historicalStrip?: string;
  /** Imperative drawing instructions, printed in the footer strip of a solo sheet. */
  instructions: string[];
  /** One line, printed under the lane name on the combined sheet. Keep it short. */
  shortHint: string;
  /** Labels down the right-hand edge of the field, bottom rail first. */
  railLabels?: [bottom: string, top: string];
  referenceLines?: ReferenceLine[];
}

/**
 * The pitch lane runs linearly from 0 to this, in Hertz.
 *
 * The machine took pitch as a decimal number of cycles per second and its
 * relays switched resistor banks to suit, so frequency is proportional to the
 * painted number. Octaves are therefore unevenly spaced: 110 Hz sits a ninth of
 * the way up, 220 at a fifth, 440 at a little under half, 880 near the top.
 */
export const PITCH_MAX_HZ = 1000;

/** Octaves worth marking on the linear axis. */
export const PITCH_MARKS = [55, 110, 220, 440, 880] as const;

/**
 * Four digits — units, tens, hundreds and thousands of cycles per second —
 * and four tracks each, weighted 1-2-4-2 reading from the film's lower edge.
 *
 * Not 8-4-2-1. Wrench: "The track on the lower edge of the film does nought or
 * one; the next one up does nought and two; the next does nought and four; the
 * top-most track does nought and two again: hence, weighted binary." The four
 * weights sum to 9, so every decimal digit is reachable and several have two
 * paintings.
 */
export const NEUME = {
  digits: 4,
  /** Bottom edge first. */
  weights: [1, 2, 4, 2] as const,
  /**
   * One neume column per second. Wide enough to hand-write a frequency into,
   * and it makes the columns line up exactly with the major ticks on the
   * printed time ruler.
   */
  columnWidthMm: 10,
} as const;

const AMPLITUDE_INSTRUCTIONS = [
  'Draw one continuous line. Its height is loudness: bottom rail is silence, top rail is full.',
  'Leave the paper blank for silence. Fill solid below the line if you prefer — both read the same.',
  'Sharp corners will be softened. The original used a light bulb and a photoresistor to set level,',
  'so attacks always smear by a few tens of milliseconds. Draw the shape you want, not the shape you get.',
];

export const ROLES: RoleDef[] = [
  ...[1, 2, 3, 4].map((n): RoleDef => ({
    id: `AMP${n}`,
    title: `Amplitude ${n}`,
    blurb: `Loudness of timbre ${n} over time`,
    kind: 'unipolar',
    historicalStrip: `Strip ${3 + n} of 10`,
    shortHint: 'height = loudness',
    instructions: AMPLITUDE_INSTRUCTIONS,
    railLabels: ['silence', 'full'],
    referenceLines: [
      { at: 0.5, label: '-6 dB' },
      { at: 0.25, label: '-20 dB' },
    ],
  })),
  {
    id: 'PCH',
    title: 'Pitch',
    blurb: 'Frequency over time, in cycles per second',
    kind: 'logpitch',
    historicalStrip: 'Strips 1-4, reinterpreted',
    shortHint: 'height = Hertz, linear',
    instructions: [
      'Draw a line. Its height is the frequency in Hertz, measured straight up the scale —',
      'so each octave takes twice the height of the one below it. That is how the machine read pitch.',
      'You need not draw the whole way across: the relays latch, so a frequency holds until you',
      'change it. Use the neume sheet if you want to punch the binary yourself.',
    ],
    railLabels: ['0 Hz', `${PITCH_MAX_HZ} Hz`],
  },
  {
    id: 'NOTE',
    title: 'Note',
    blurb: 'Which of the twelve notes, C at the bottom',
    kind: 'notes',
    historicalStrip: "Oram's 1976 design, as built by Richards",
    shortHint: 'one row per note',
    instructions: [
      'Mark a row to choose a note. With dots, each mark holds until the next one;',
      'with lines, the note follows the line as it moves. Either way the app snaps to the',
      'nearest note, and to the key and scale you pick, so the rows are a guide, not a target.',
    ],
    railLabels: ['C', 'B'],
  },
  {
    id: 'OCT',
    title: 'Octave',
    blurb: 'Which octave the note is in, lowest at the bottom',
    kind: 'octaves',
    historicalStrip: "Oram's 1976 design, as built by Richards",
    shortHint: 'one row per octave',
    instructions: [
      'Mark a row to choose an octave. Leave it blank and the notes play around middle C.',
    ],
    railLabels: ['1', '8'],
  },
  {
    id: 'NEU',
    title: 'Pitch — neumes',
    blurb: 'Frequency in whole Hertz, weighted binary',
    kind: 'bcd',
    historicalStrip: 'Strips 1-4 of 10',
    shortHint: 'whole Hertz, in weighted binary',
    instructions: [
      'Write the frequency in the top row, one whole number of cycles per second per column.',
      'Then fill the cells under each digit that add up to it. The weights are 1 2 4 2, not 8 4 2 1,',
      'so 6 is 4+2, 8 is 2+4+2, and 4 is either the 4 on its own or both 2s — the machine cannot tell.',
      'Columns are one second. Leave one blank to hold the previous pitch: the relays latch.',
    ],
  },
  {
    id: 'VIB',
    title: 'Vibrato',
    blurb: 'Pitch wobble',
    kind: 'bipolar',
    historicalStrip: 'Strip 8 of 10',
    shortHint: 'wobble around the centre',
    instructions: [
      'Draw a wobbly line. Distance from the centre line is how far the pitch bends;',
      'how tightly you wobble is how fast. On the centre line, nothing happens.',
      'Unlike the waveform sheet this one was drawn freehand on film — no solid fill needed.',
      'Overall depth in cents is set in the app; this sheet is the shape.',
    ],
    railLabels: ['bend down', 'bend up'],
  },
  {
    id: 'REV',
    title: 'Reverberation',
    blurb: 'How much of the mix is sent to the plate',
    kind: 'unipolar',
    historicalStrip: 'Strip 9 of 10',
    shortHint: 'up = wetter',
    instructions: [
      'Draw one continuous line. Bottom rail is completely dry, top rail is fully wet.',
      'This applies to the whole four-timbre mix, not to one voice.',
      'Reverb tails outlast the line that made them — expect wet sound after you return to the floor.',
    ],
    railLabels: ['dry', 'wet'],
  },
  {
    id: 'TRN',
    title: 'Transport',
    blurb: 'Speed of the read head itself',
    kind: 'unipolar',
    historicalStrip: 'Strip 10 of 10',
    shortHint: 'centre = normal speed',
    instructions: [
      'Draw one continuous line. The heavy centre line is normal speed; the top rail is double,',
      'the bottom rail a tenth. Everything slows and speeds together, pitch included.',
      'Careful: this sheet warps its own time axis, so the printed ruler stops being true',
      'the moment you leave the centre line.',
    ],
    railLabels: ['0.10x', '2.00x'],
    referenceLines: [{ at: 0.5, label: '1.00x  normal' }],
  },
  ...[1, 2, 3, 4].map((n): RoleDef => ({
    id: `WAV${n}`,
    title: `Waveform slide ${n}`,
    blurb: `The tone colour of timbre ${n} — one single cycle`,
    kind: 'cycle',
    historicalStrip: 'Painted glass slide, not film',
    shortHint: 'one cycle, left to right',
    instructions: [
      'This sheet is ONE CYCLE of a wave, not a stretch of time. Draw left to right without',
      'doubling back — the scanner follows a contour and cannot read a line that loops over itself.',
      'Start and end at the same height or you will hear a click once per cycle.',
      'Fill solid below the line if you like: Oram painted these black underneath.',
    ],
    railLabels: ['-1', '+1'],
  })),
];

export const ROLES_BY_ID = new Map(ROLES.map((r) => [r.id, r]));

export const getRole = (id: string): RoleDef => {
  const role = ROLES_BY_ID.get(id.toUpperCase());
  if (!role) {
    throw new Error(
      `Unknown role "${id}". Known roles: ${ROLES.map((r) => r.id).join(', ')}`,
    );
  }
  return role;
};

/** The ten film strips, in machine order — the default set for a full piece. */
export const FULL_MACHINE: string[] = [
  'NEU',
  'AMP1',
  'AMP2',
  'AMP3',
  'AMP4',
  'VIB',
  'REV',
  'TRN',
  'WAV1',
  'WAV2',
];
