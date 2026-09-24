/**
 * Bringing a photographed or scanned sheet into the session.
 *
 * The vision package does the work and knows nothing about browsers; this is
 * the layer that turns a file the user picked into pixels, and the extracted
 * contours into lanes and slides the rest of the app already understands.
 *
 * The result is deliberately indistinguishable from something drawn on screen.
 * That is the whole point of the round trip, and it is why the extractor
 * produces one value per column with NaN for blank paper rather than some
 * separate "scanned" representation.
 */

import type { Layout } from '@oramics/template';
import { importRgba, type ImportResult, type Rectified } from '@oramics/vision';

import {
  LANE_DEFS,
  LANE_SAMPLES,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  makeAllLanes,
  roleFor,
  type LaneMap,
} from './lanes.js';

export interface ScanResult {
  lanes: LaneMap;
  slides: Float32Array[];
  /**
   * The registered photograph of each band, keyed by lane name.
   *
   * Kept because the lane values are what the machine plays, not what the
   * person drew. A scribble, a word, a face: the machine reads one height per
   * column off it and everything else is gone. Showing the paper underneath is
   * how the piece stays theirs.
   */
  paper: Record<string, Rectified>;
  /** Sheet id from the QR, if it decoded. */
  sheetId: string | null;
  /** Which sheet it was: the original, or the note-and-octave one. */
  layout: Layout;
  /** Seconds the field represents, from the sheet itself where possible. */
  durationS: number;
  /** Worst corner fit in millimetres. Under about half a millimetre is good. */
  fitMm: number;
  /** Which bands carried marks, as a fraction of columns. */
  coverage: Record<string, number>;
}

/**
 * Resample an extracted contour onto the app's lane resolution.
 *
 * Nearest neighbour, not interpolation. A lane is mostly blank and averaging
 * across the end of a stroke would invent values in the gap, which is exactly
 * the distinction the NaN is there to preserve.
 */
const resample = (from: Float32Array, length: number): Float32Array => {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const j = Math.round((i / (length - 1)) * (from.length - 1));
    const v = from[Math.max(0, Math.min(from.length - 1, j))]!;
    out[i] = Number.isFinite(v) ? v : Number.NaN;
  }
  return out;
};

/**
 * Mark every unbroken stretch of a scanned lane as its own stroke.
 *
 * Nobody can say which pen stroke a pixel came from, so this is the honest
 * approximation: a run of drawn columns with blank paper either side was one
 * gesture. It is what stops separate marks being drawn joined up on screen.
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

/** Did the sheet carry any marks at all? */
export const isBlank = (result: ScanResult): boolean =>
  Object.values(result.coverage).every((c) => c < 0.01);

export const toSession = (result: ImportResult): ScanResult => {
  if (!result.ok) throw new Error(result.message);

  const lanes = makeAllLanes();
  const crops: Record<string, Rectified> = {};
  for (const def of LANE_DEFS) {
    // The same lane has a different band on each sheet: pitch is NOTE on the
    // note-and-octave sheet and PCH on the original.
    const role = roleFor(def, result.layout);
    if (!role) continue;
    const crop = result.contents.crops[role];
    if (crop) crops[def.name] = crop;
    const raw = result.contents.lanes[role];
    if (!raw) continue;
    const values = resample(raw, LANE_SAMPLES);
    lanes[def.name] = { values, strokes: strokesFrom(values) };
  }

  return {
    lanes,
    // Already opacity fields at the slide's own resolution: what somebody
    // painted on the panel, handed to the engine as painted glass.
    slides: result.contents.slides,
    paper: crops,
    layout: result.layout,
    sheetId: result.payload?.sheetId ?? null,
    durationS: result.durationS,
    fitMm: result.fitMm,
    coverage: result.contents.coverage,
  };
};

/**
 * Decode an image file and read the sheet in it.
 *
 * Decoding goes through the browser's own image pipeline, so anything the
 * platform can open works: a phone photograph, a flatbed scan, a screenshot.
 * Large photographs are scaled down first — twelve megapixels is far more than
 * registration needs and costs seconds of the user's time to no benefit.
 */
export const scanImageFile = async (file: Blob, maxEdge = 2400): Promise<ScanResult> => {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the image.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, width, height);
  return toSession(
    importRgba(data, width, height, { slideWidth: SLIDE_WIDTH, slideHeight: SLIDE_HEIGHT }),
  );
};

/**
 * Turn the registered crops into bitmaps the pads can blit.
 *
 * Done once at import rather than per repaint: `drawImage` from an ImageBitmap
 * is a blit, while re-uploading an ImageData every frame is not, and these get
 * redrawn on every zoom, pan and meter tick.
 */
export const toBitmaps = async (
  paper: Record<string, Rectified>,
): Promise<Record<string, ImageBitmap>> => {
  const entries = await Promise.all(
    Object.entries(paper).map(async ([name, crop]) => {
      // Copied into a plain ArrayBuffer: ImageData will not take a view that
      // might be backed by shared memory.
      const image = new ImageData(new Uint8ClampedArray(crop.data), crop.width, crop.height);
      return [name, await createImageBitmap(image)] as const;
    }),
  );
  return Object.fromEntries(entries);
};
