/**
 * Export the current session as the same printable sheet contributors draw on.
 *
 * Round trip: draw here, print it, someone marks it up by hand, scan it back.
 * That only works because the app and the printed template share one geometry
 * module — the overlay lands exactly on the band it came from.
 */

import {
  buildDocument,
  makeSheetId,
  sheetPayload,
  type Layout,
  type Overlays,
  type Page,
  type Paper,
} from '@oramics/template';

import { LANE_DEFS, SLIDE_HEIGHT, SLIDE_WIDTH, roleFor, type LaneMap } from './lanes.js';
import { saveBytes } from './save.js';

export interface ExportOptions {
  lanes: LaneMap;
  /** Painted slide opacity fields, one per timbre. */
  slides: Float32Array[];
  sheetId?: string;
  /** Leave bands blank where nothing was drawn, rather than printing the rest line. */
  omitUntouched?: boolean;
  /** Which sheet to print onto. The note-and-octave sheet has pitch in two bands. */
  layout?: Layout;
  /** Paper to print on. Letter holds the same 30 seconds, drawn smaller. */
  paper?: Paper;
}

/**
 * Trace the top edge of each painted stroke — the line the scanner's spot
 * actually rides. The printed sheet shows that rather than the whole painted
 * mass, because the underside is inaudible and drawing it would mislead anyone
 * marking the sheet up by hand.
 */
const topEdge = (field: Float32Array, width: number, height: number): Float32Array => {
  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let found = -1;
    for (let y = 0; y < height; y++) {
      if (field[y * width + x]! >= 0.5) {
        found = y;
        break;
      }
    }
    // Nothing painted: the spot would sit at the bottom rail.
    out[x] = found < 0 ? 0 : 1 - found / (height - 1);
  }
  return out;
};

/** A lane still sitting flat at its rest value was never drawn on. */
const isUntouched = (values: Float32Array, rest: number): boolean => {
  for (const v of values) if (Math.abs(v - rest) > 1e-4) return false;
  return true;
};

export const buildSessionPdf = async (opts: ExportOptions): Promise<Uint8Array> => {
  const sheetId = (opts.sheetId ?? makeSheetId()).toUpperCase();

  // Bands and timbres share one sheet, so they share one overlay map. The keys
  // do not collide: lanes are role ids, timbres are WAV1 to WAV4.
  const layout = opts.layout ?? 'FULL';
  const overlays: Overlays = {};
  for (const def of LANE_DEFS) {
    const role = roleFor(def, layout);
    if (!role) continue; // no band for it on this sheet
    const { values } = opts.lanes[def.name];
    if (opts.omitUntouched !== false && isUntouched(values, def.rest)) continue;
    overlays[role] = values;
  }
  opts.slides.forEach((field, i) => {
    overlays[`WAV${i + 1}`] = topEdge(field, SLIDE_WIDTH, SLIDE_HEIGHT);
  });

  const pages: Page[] = [
    {
      kind: 'machine',
      options: {
        payload: sheetPayload(sheetId, undefined, layout),
        overlays,
        paper: opts.paper ?? 'legal',
      },
    },
  ];

  return buildDocument({ pages, title: `Daphne session — ${sheetId}` });
};

/**
 * The sheet with nothing on it, ready to print and hand out.
 *
 * The same page the app exports a session onto, so a piece drawn on paper and a
 * piece drawn on screen land on identical geometry and import the same way.
 */
export const buildBlankPdf = async (
  sheetId?: string,
  layout: Layout = 'FULL',
  paper: Paper = 'legal',
): Promise<Uint8Array> => {
  const id = (sheetId ?? makeSheetId()).toUpperCase();
  return buildDocument({
    pages: [{ kind: 'machine', options: { payload: sheetPayload(id, undefined, layout), paper } }],
    title: `Daphne sheet ${id}`,
  });
};

const save = (bytes: Uint8Array, name: string): Promise<string | null> => saveBytes(bytes, name, 'pdf');

export const exportSessionPdf = async (opts: ExportOptions): Promise<string | null> =>
  save(await buildSessionPdf(opts), 'daphne-session.pdf');

export const exportBlankPdf = async (
  sheetId?: string,
  layout: Layout = 'FULL',
  paper: Paper = 'legal',
): Promise<string | null> =>
  save(
    await buildBlankPdf(sheetId, layout, paper),
    `daphne-sheet${layout === 'TONE' ? '-notes' : ''}${paper === 'letter' ? '-letter' : ''}.pdf`,
  );
