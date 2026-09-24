/**
 * Importing a scanned or photographed sheet.
 *
 * The other half of the workshop loop. You could already draw, hear and print;
 * this is the part that reads the paper back. Somebody marks up a printed sheet
 * by hand, you photograph it, and the marks come back as lanes indistinguishable
 * from ones drawn on screen.
 *
 * Three steps, each of which can fail honestly:
 *
 *   register   find the four corner squares, solve the map onto page space
 *   describe   read the QR, so the sheet says what it is and how long it lasts
 *   extract    sample every band and panel where the template says they are
 *
 * The package has no DOM and no Node, like the engine, so the same code runs in
 * the renderer against a canvas, in a unit test against a rendered sheet, and in
 * a watch folder later.
 */

import {
  PAGE,
  SHEET_DURATION_S,
  layoutOf,
  type Layout,
  type SheetPayload,
} from '@oramics/template';

import { FIDUCIAL_PAGE_POINTS, findFiducials, type FindOptions } from './fiducials.js';
import { invert, residual, solveHomography, type Matrix3 } from './homography.js';
import type { Gray } from './image.js';
import { resolveOrientation, type Orientation } from './orientation.js';
import { readPayload } from './qr.js';
import {
  measureInkDepth,
  paperMap,
  prepare,
  readSheet,
  type ContentsOptions,
  type SheetContents,
} from './extract.js';

export * from './extract.js';
export * from './fiducials.js';
export * from './homography.js';
export * from './image.js';
export * from './orientation.js';
export * from './qr.js';
export * from './rectify.js';
export { photograph, parsePgm, type CameraOptions } from './testing.js';

export interface ImportOptions extends ContentsOptions, FindOptions {}

export type ImportFailure =
  | 'no-fiducials'
  | 'degenerate-fiducials'
  | 'not-a-sheet';

export interface ImportSuccess {
  ok: true;
  contents: SheetContents;
  /** Page millimetres to image pixels. */
  toImage: Matrix3;
  /** Image pixels to page millimetres. */
  toPage: Matrix3;
  /** What the sheet said about itself, or null if the QR could not be read. */
  payload: SheetPayload | null;
  /** Seconds the field represents, from the QR where possible. */
  durationS: number;
  /** Worst corner fit, in millimetres. Over about 0.5 mm, distrust the result. */
  fitMm: number;
  /** Which way up the sheet was, and how sure. */
  orientation: Orientation;
  /** Which bands it carries. */
  layout: Layout;
}

export interface ImportError {
  ok: false;
  reason: ImportFailure;
  message: string;
}

export type ImportResult = ImportSuccess | ImportError;

const fail = (reason: ImportFailure, message: string): ImportError => ({
  ok: false,
  reason,
  message,
});

/**
 * Read a photograph or scan of a sheet.
 *
 * Returns a result rather than throwing, and refuses rather than guesses. Three
 * corner marks and an assumption would produce a map that looks plausible and
 * puts every lane slightly in the wrong place, which is worse than a message
 * saying the photo was no good.
 */
export const importSheet = (image: Gray, opts: ImportOptions = {}): ImportResult => {
  const found = findFiducials(image, opts);
  if (!found) {
    return fail(
      'no-fiducials',
      'Could not find the four corner squares. Get the whole sheet in frame, ' +
        'flat and evenly lit, with all four corners visible.',
    );
  }

  // One paper reference for the whole import: it costs an integral image over
  // every pixel, and orientation, calibration and thresholding all want it.
  const paper = paperMap(image);

  /*
   * Which way up, decided rather than assumed.
   *
   * Four identical corner squares register a portrait photograph onto the
   * page's own transpose without complaint: the fit comes out at zero and every
   * band is read across the sheet instead of along it.
   */
  const oriented = resolveOrientation(image, paper, found.corners);
  if (!oriented) {
    return fail('degenerate-fiducials', 'The four corner squares do not form a page.');
  }
  const corners = oriented.corners;

  const toPage = solveHomography(corners, FIDUCIAL_PAGE_POINTS);
  const toImage = toPage ? invert(toPage) : null;
  if (!toPage || !toImage) {
    return fail('degenerate-fiducials', 'The four corner squares do not form a page.');
  }

  const fitMm = residual(toPage, corners, FIDUCIAL_PAGE_POINTS);
  if (fitMm > 2) {
    return fail(
      'degenerate-fiducials',
      `The corner marks fit the page badly (${fitMm.toFixed(1)} mm out). ` +
        'This is usually a curled or folded sheet.',
    );
  }

  const payload = readPayload(image, toImage);

  // Calibrate against the corner squares before reading anything: they are the
  // only ink on the sheet whose true darkness is known.
  const inkDepth = measureInkDepth(prepare(image, { paper }), corners, found.sizePx);
  // The QR says which bands the sheet carries. A note-and-octave sheet has two
  // pitch bands where the original has one, so reading it as the original
  // would put every band below pitch in the wrong place.
  const layout = layoutOf(payload);
  const contents = readSheet(prepare(image, { paper, inkDepth, ...opts }), toImage, {
    ...opts,
    layout,
  });

  return {
    ok: true,
    contents,
    toImage,
    toPage,
    payload,
    durationS: payload ? payload.durationMs / 1000 : SHEET_DURATION_S,
    fitMm,
    orientation: oriented,
    layout,
  };
};

/** Convenience for callers holding RGBA, which is what a canvas gives you. */
export const importRgba = (
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: ImportOptions & { channel?: 'luma' | 'red' } = {},
): ImportResult => {
  const out = new Float32Array(width * height);
  const red = opts.channel === 'red';
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = red
      ? data[p]! / 255
      : (0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!) / 255;
  }
  return importSheet({ data: out, width, height }, opts);
};

export { PAGE };
