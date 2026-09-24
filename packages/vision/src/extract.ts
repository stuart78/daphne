/**
 * Reading the marks off a registered sheet.
 *
 * By this point the hard part is done: there is a map from page millimetres to
 * pixels, so every band and panel is exactly where the template says it is and
 * nothing here needs to know what a camera did. What is left is deciding, for
 * each column of each band, whether somebody drew something and how high up.
 *
 * The output is deliberately the same shape the app's own drawing surface
 * produces: one value per column, 0 to 1, NaN where the paper is blank. A drawn
 * lane and a scanned lane are the same thing from here on, which is the whole
 * point of the round trip.
 */

import {
  FIELD_X_MM,
  TIME_FIELD_WIDTH_MM,
  type Layout,
  machineBands,
  sheetFurniture,
  slidePanels,
  type Rect,
} from '@oramics/template';

import { apply, type Matrix3 } from './homography.js';
import { localMean, sample, type Gray } from './image.js';
import { rectify, rectifyOpacity, type Rectified } from './rectify.js';

export interface ExtractOptions {
  /**
   * Floor on how much darker than its surroundings a pixel has to be.
   *
   * Only a floor. The working threshold is set from the sheet itself, and this
   * stops a blank, evenly lit page from resolving into noise when there is no
   * real ink to calibrate against.
   */
  inkMargin?: number;
  /**
   * How black solid black came out on this scan, as a depth below local paper.
   *
   * Measured from the corner fiducials, which are the one thing on the sheet
   * guaranteed to be solid. Everything printed is then a known fraction of it:
   * the dashed octave rules are 55% grey, the second lines 76%. Calibrating
   * against real ink on the same piece of paper is what lets one threshold work
   * for a flatbed scan, a phone under a window, and a photocopy of a photocopy.
   */
  inkDepth?: number;
  /** Samples down a band. Finer costs time and buys nothing past the pen width. */
  stepMm?: number;
  /** Ignore marks thinner than this. Paper speckle and dust. */
  minMarkMm?: number;
  /** A paper reference already computed. Saves recomputing it per stage. */
  paper?: Gray;
}

/**
 * Fraction of solid black a mark has to reach.
 *
 * Set below the 45% the dashed octave rules print at, deliberately. A workshop
 * runs on pencil, and pencil is nowhere near solid black: held above the rules
 * the threshold read a firm biro and missed half of what people actually drew.
 * So the rules do reach it, and the template declares them instead: containment
 * separates a 0.4 mm printed rule from a pencil line laid along the same
 * height, which no threshold on darkness alone could do.
 */
const INK_FRACTION = 0.4;

const DEFAULTS = { inkMargin: 0.14, stepMm: 0.1, minMarkMm: 0.2 };

/**
 * A run of ink down one column, in page millimetres.
 *
 * Two extents. The core is where the ink is unambiguous, and is what the value
 * is read from. The full extent includes the soft edges, and is what decides
 * whether the mark is just a printed rule.
 */
interface Run {
  top: number;
  bottom: number;
  coreTop: number;
  coreBottom: number;
  darkness: number;
}

/**
 * How far a mark may bleed past its solid core, in millimetres.
 *
 * A cap, not a preference. Without one, a single faint feature running the
 * height of the band — the second lines do exactly that — joins every mark in
 * the column into one run reaching from the top rail to the bottom, and the
 * value read from it is the top of the band. Real marks are a pen wide.
 */
const SPREAD_MM = 1;

/**
 * Ink test relative to the local paper brightness.
 *
 * The reference is the same local mean the fiducial search uses, computed once
 * over the whole image. A sheet lit from one side is half a stop brighter at one
 * edge, and a single global threshold either loses the marks in the shadow or
 * turns the bright side into ink.
 */
export interface Ink {
  image: Gray;
  paper: Gray;
  margin: number;
}

/** The paper reference, computed once and shared by everything that needs it. */
export const paperMap = (image: Gray): Gray =>
  localMean(image, Math.max(8, Math.round(Math.max(image.width, image.height) / 40)));

export const prepare = (image: Gray, opts: ExtractOptions = {}): Ink => {
  // Wide enough to average over paper rather than over the mark itself: at
  // roughly a fortieth of the long edge it spans several millimetres of page.
  const floor = opts.inkMargin ?? DEFAULTS.inkMargin;
  const calibrated = opts.inkDepth === undefined ? floor : opts.inkDepth * INK_FRACTION;
  return { image, paper: opts.paper ?? paperMap(image), margin: Math.max(floor, calibrated) };
};

/**
 * How dark solid black is on this scan, from the corner squares.
 *
 * Averaged over the middle of each mark and taken as the median of the four, so
 * one fiducial catching a highlight does not set the threshold for the page.
 */
export const measureInkDepth = (
  ink: Ink,
  corners: { x: number; y: number }[],
  sizePx: number,
): number => {
  const { image, paper } = ink;
  const half = Math.max(1, Math.round(sizePx * 0.25));

  const depths = corners.map((c) => {
    let total = 0;
    let n = 0;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = Math.round(c.x) + dx;
        const y = Math.round(c.y) + dy;
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        total += paper.data[y * image.width + x]! - image.data[y * image.width + x]!;
        n++;
      }
    }
    return n > 0 ? total / n : 0;
  });

  depths.sort((a, b) => a - b);
  return (depths[1]! + depths[2]!) / 2;
};

/** How far below the local paper brightness this point sits. */
const isInk = (ink: Ink, toImage: Matrix3, x: number, y: number): number => {
  const p = apply(toImage, { x, y });
  if (p.x < 0 || p.y < 0 || p.x >= ink.image.width || p.y >= ink.image.height) return 0;
  return sample(ink.paper, p.x, p.y) - sample(ink.image, p.x, p.y);
};

/** Furniture intervals covering a column, sorted, in page millimetres. */
const maskFor = (furniture: Rect[], x: number): [number, number][] =>
  furniture
    .filter((r) => x >= r.x && x <= r.x + r.w)
    .map((r) => [r.y, r.y + r.h] as [number, number])
    .sort((a, b) => a[0] - b[0]);

/**
 * Is this run just the template's own ink?
 *
 * Containment, not position. Blanking the furniture outright was the obvious
 * thing and it was wrong: the centre rail on a bipolar lane sits at exactly the
 * value people draw around, and the pitch band's dashed rules are the octaves,
 * so blanking them punched holes in every stroke that crossed one. A run only
 * counts as furniture if it fits inside the strip the rule occupies. A pen
 * drawn along the same line makes a thicker run and survives.
 */
const isFurniture = (intervals: [number, number][], run: Run): boolean => {
  for (const [a, b] of intervals) {
    if (run.bottom < a) return false; // sorted, so nothing later can contain it
    if (run.top >= a && run.bottom <= b) return true;
  }
  return false;
};

/**
 * Every run of ink down one column of a rect, by hysteresis.
 *
 * A run has to reach the full threshold somewhere, but it extends outward while
 * the ink is merely half that. One threshold cannot do both jobs: set high
 * enough to reject the printed rules, it also eats the soft edges of a pen
 * stroke until what is left is thinner than the speckle filter and the whole
 * line disappears. Strict about whether a mark is there, generous about where
 * it ends, which is also what makes a stroke drawn along a printed rule come
 * out wider than the rule and so survive the containment test.
 */
const runsInColumn = (
  ink: Ink,
  toImage: Matrix3,
  rect: Rect,
  x: number,
  step: number,
): Run[] => {
  const steps = Math.max(2, Math.ceil(rect.h / step) + 1);
  const depth = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    depth[i] = isInk(ink, toImage, x, rect.y + Math.min(rect.h, i * step));
  }

  const weak = ink.margin * 0.45;
  const spread = Math.max(1, Math.round(SPREAD_MM / step));
  const at = (i: number): number => rect.y + Math.min(rect.h, i * step);

  const runs: Run[] = [];
  let i = 0;
  while (i < steps) {
    if (depth[i]! < ink.margin) {
      i++;
      continue;
    }

    // The solid core: everything continuously at or above the full threshold.
    const coreStart = i;
    let darkness = 0;
    while (i < steps && depth[i]! >= ink.margin) {
      darkness += depth[i]!;
      i++;
    }
    const coreEnd = i - 1;

    /*
     * Then out to the soft edges: while the ink is still weakly present, still
     * falling away, and within a pen's width.
     *
     * The falling test is what keeps a mark separate from the second lines
     * printed down the band. Those sit at a constant faint level, so without it
     * the top rail's edge crept a millimetre down the grid line, escaped the
     * strip that explains it, and the whole band read as a mark along its top.
     */
    let top = coreStart;
    while (
      top > 0 &&
      coreStart - top < spread &&
      depth[top - 1]! >= weak &&
      depth[top - 1]! < depth[top]!
    ) {
      top--;
    }
    let bottom = coreEnd;
    while (
      bottom + 1 < steps &&
      bottom - coreEnd < spread &&
      depth[bottom + 1]! >= weak &&
      depth[bottom + 1]! < depth[bottom]!
    ) {
      bottom++;
    }

    const previous = runs[runs.length - 1];
    if (previous && at(top) <= previous.bottom) {
      // Two cores close enough to share their edges are one mark.
      previous.bottom = at(bottom);
      previous.coreBottom = at(coreEnd);
      previous.darkness += darkness;
    } else {
      runs.push({
        top: at(top),
        bottom: at(bottom),
        coreTop: at(coreStart),
        coreBottom: at(coreEnd),
        darkness,
      });
    }
  }
  return runs;
};

/**
 * Where the line is, given the ink found in a column.
 *
 * The topmost run wins. That is not a tie-breaker, it is the rule the machine
 * itself follows: the flying spot rides the top edge of the paint, so the top
 * edge is what a slide means, and a lane exported from the app prints its
 * amplitude bands filled solid below the line exactly as Oram painted her film.
 * Reading the middle of the ink would put a filled band at half its value.
 *
 * The value comes from the middle of the solid core rather than from either
 * edge. For a pen stroke that is where the person aimed. For an amplitude band
 * printed filled, the core is the drawn boundary and the wash below it is not,
 * so the same rule reads both without knowing which it is looking at.
 */
const positionOf = (runs: Run[], mask: [number, number][], minMarkMm: number): number => {
  let best: Run | null = null;
  for (const run of runs) {
    if (run.bottom - run.top < minMarkMm) continue; // speckle
    if (isFurniture(mask, run)) continue;
    if (!best || run.top < best.top) best = run;
  }
  if (!best) return Number.NaN;
  return (best.coreTop + best.coreBottom) / 2;
};

export interface ReadOptions extends ExtractOptions {
  /** Samples across the field. Matches the app's lane resolution. */
  columns: number;
  /** Vertical drift of the printed frame across the page, from `traceDrift`. */
  drift?: Float32Array;
}

/**
 * Drop single columns that disagree with both their neighbours.
 *
 * A pen does not jump half a band and come back within a tenth of a millimetre.
 * The columns that do are the ones sitting on a printed second line, where the
 * faint vertical ink reaches the threshold and the reading comes from the wrong
 * feature. Only isolated columns are touched, and only where the neighbours
 * agree with each other, so a genuine break between two separate strokes is
 * left exactly as drawn.
 */
const despeckle = (values: Float32Array, tolerance = 0.15, maxGap = 3): void => {
  // Spikes: a single column disagreeing with both its neighbours.
  for (let i = 1; i < values.length - 1; i++) {
    const before = values[i - 1]!;
    const after = values[i + 1]!;
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    if (Math.abs(before - after) > tolerance) continue;
    const middle = (before + after) / 2;
    if (Math.abs(values[i]!) >= 0 && Math.abs(values[i]! - middle) > tolerance) values[i] = middle;
  }

  /*
   * Short gaps: a handful of unread columns inside one stroke.
   *
   * Where a line runs along a printed rule for a moment, those columns cannot
   * be told from the rule and go unread. Left as blanks they cut the stroke in
   * two, and the app then draws it as two separate marks, which is a visible
   * lie about what somebody drew. Only bridged when the values either side
   * agree, so a genuine pen lift between two marks at different heights stays a
   * pen lift.
   */
  for (let i = 1; i < values.length - 1; i++) {
    if (Number.isFinite(values[i]!)) continue;
    let end = i;
    while (end < values.length && !Number.isFinite(values[end]!)) end++;
    const gap = end - i;
    const before = values[i - 1]!;
    const after = end < values.length ? values[end]! : Number.NaN;

    if (
      gap <= maxGap &&
      Number.isFinite(before) &&
      Number.isFinite(after) &&
      Math.abs(before - after) <= tolerance
    ) {
      for (let k = 0; k < gap; k++) {
        values[i + k] = before + ((after - before) * (k + 1)) / (gap + 1);
      }
    }
    i = end;
  }
};

/**
 * How far the printed frame has drifted from where the geometry says it is,
 * measured across the page.
 *
 * Four corner marks fix a plane, and paper is not one. The workshop sheet that
 * showed this up was resting on a spiral notebook: the corners fitted to zero
 * and the middle of the page bowed by about a millimetre, which was enough to
 * bring a band's top rule inside the sampled area. Every column then found the
 * frame before it found the drawing, and the pitch lane came back pinned to the
 * top of the band for the whole thirty seconds — a perfectly steady, perfectly
 * wrong reading.
 *
 * All sixteen band rules are matched at once, not one at a time. They are rigid
 * relative to each other, so one offset explains the lot, and searching for them
 * individually is what goes wrong: the gap between two bands is 1.6 mm, so a
 * window wide enough to follow the bow is also wide enough to lock onto the
 * neighbouring band's rule and swallow a whole lane.
 */
export const traceDrift = (
  ink: Ink,
  toImage: Matrix3,
  slices = 20,
  searchMm = 1.2,
  layout: Layout = 'FULL',
): Float32Array => {
  const rails: number[] = [];
  for (const band of machineBands(layout)) {
    rails.push(band.rect.y, band.rect.y + band.rect.h);
  }

  const drift = new Float32Array(slices);
  const columns = 5;
  for (let s = 0; s < slices; s++) {
    const x0 = FIELD_X_MM + (TIME_FIELD_WIDTH_MM * s) / slices;
    const x1 = FIELD_X_MM + (TIME_FIELD_WIDTH_MM * (s + 1)) / slices;

    const scoreAt = (d: number): number => {
      let total = 0;
      for (const rail of rails) {
        for (let c = 0; c < columns; c++) {
          total += isInk(ink, toImage, x0 + ((x1 - x0) * (c + 0.5)) / columns, rail + d);
        }
      }
      return total;
    };

    let best = 0;
    let bestInk = -1;
    for (let d = -searchMm; d <= searchMm; d += 0.05) {
      const total = scoreAt(d);
      // Ties go to no drift, so a sheet that is genuinely flat stays put.
      if (total > bestInk + 1e-6 || (total > bestInk - 1e-6 && Math.abs(d) < Math.abs(best))) {
        bestInk = total;
        best = d;
      }
    }

    /*
     * Only move when the paper says so.
     *
     * On a flat sheet the rules are already where the geometry puts them, and
     * the best offset is whatever noise happened to favour. Shifting the bands
     * by a fraction of a millimetre for no reason drags every value with it, so
     * a correction has to earn itself by finding materially more of the frame
     * than leaving it alone does.
     */
    drift[s] = bestInk > scoreAt(0) * 1.2 ? best : 0;
  }
  return drift;
};

/** Interpolate the drift at a position across the field. */
const driftAt = (drift: Float32Array, t: number): number => {
  const f = Math.max(0, Math.min(1, t)) * (drift.length - 1);
  const i = Math.min(drift.length - 2, Math.floor(f));
  return drift[i]! + (drift[i + 1]! - drift[i]!) * (f - i);
};

/**
 * Read one rectangle into a normalised contour, 1 at the top and 0 at the
 * bottom, NaN where nothing was drawn.
 */
export const readRegion = (
  ink: Ink,
  toImage: Matrix3,
  rect: Rect,
  furniture: Rect[],
  opts: ReadOptions,
): Float32Array => {
  const step = opts.stepMm ?? DEFAULTS.stepMm;
  const minMark = opts.minMarkMm ?? DEFAULTS.minMarkMm;
  const out = new Float32Array(opts.columns);

  /*
   * Read the interior, not the frame.
   *
   * The band's own frame is printed at full ink weight along the top and bottom
   * of every rect, and any rule for telling it apart from a mark drawn hard
   * against it is a rule that can be wrong. Not sampling it cannot be. The cost
   * is the outermost half millimetre of the band, where a value would read as
   * 0.98 or 0.02 anyway.
   *
   * Where the frame actually is comes from the paper rather than the geometry,
   * because paper bows.
   */
  const inset = 0.6;

  for (let i = 0; i < opts.columns; i++) {
    // Clamped inside the frame for the same reason the rows are: the left and
    // right borders are full-height ink, and being vertical they cannot be
    // described as a strip at some height the way the rules can. Clamping costs
    // the outer half millimetre of time rather than shifting the axis.
    const x = Math.min(
      rect.x + rect.w - inset,
      Math.max(rect.x + inset, rect.x + (rect.w * i) / (opts.columns - 1)),
    );
    // Where the frame actually is, rather than where the geometry says.
    const shift = opts.drift ? driftAt(opts.drift, (x - rect.x) / rect.w) : 0;
    const top = rect.y + shift;
    const bottom = rect.y + rect.h + shift;
    const interior: Rect = { x: rect.x, y: top + inset, w: rect.w, h: rect.h - inset * 2 };

    // Furniture is quoted against the nominal band, so it moves with the frame.
    // Otherwise the centre rail's strip sits a millimetre off the centre rail on
    // a bowed page and stops explaining it.
    const mask = maskFor(furniture, x).map(
      ([a, b]) => [a + shift, b + shift] as [number, number],
    );
    const y = positionOf(runsInColumn(ink, toImage, interior, x, step), mask, minMark);
    out[i] = Number.isNaN(y) ? Number.NaN : 1 - (y - top) / (bottom - top);
  }
  despeckle(out);
  return out;
};

export interface SheetContents {
  /** One contour per band, keyed by role id: PCH, AMP1 and so on. */
  lanes: Record<string, Float32Array>;
  /**
   * One opacity field per timbre panel, left to right, row-major from the top.
   *
   * A field rather than a contour, because a painted slide is a field and the
   * flying spot responds to all of it.
   */
  slides: Float32Array[];
  /**
   * The registered picture of each band, so the app can show what was actually
   * drawn rather than only what was made of it.
   */
  crops: Record<string, Rectified>;
  /** Fraction of columns carrying a mark, per band. Diagnostics, not truth. */
  coverage: Record<string, number>;
}

export interface ContentsOptions extends ExtractOptions {
  /** Which bands the sheet carries. The QR says; FULL when it could not be read. */
  layout?: Layout;
  /** Samples per lane. */
  laneColumns?: number;
  /** Size of the opacity field read out of each timbre panel. */
  slideWidth?: number;
  slideHeight?: number;
  /** Resolution of the registered picture kept for each band, in px per mm. */
  cropPixelsPerMm?: number;
}

export const readSheet = (
  ink: Ink,
  toImage: Matrix3,
  opts: ContentsOptions = {},
): SheetContents => {
  const layout = opts.layout ?? 'FULL';
  const furniture = sheetFurniture(layout);
  const laneColumns = opts.laneColumns ?? 3000;
  const perMm = opts.cropPixelsPerMm ?? 4;

  const drift = traceDrift(ink, toImage, undefined, undefined, layout);

  const lanes: Record<string, Float32Array> = {};
  const crops: Record<string, Rectified> = {};
  const coverage: Record<string, number> = {};
  for (const band of machineBands(layout)) {
    crops[band.role] = rectify(ink.image, toImage, band.rect, perMm);
    const values = readRegion(ink, toImage, band.rect, furniture, {
      ...opts,
      columns: laneColumns,
      drift,
    });
    lanes[band.role] = values;
    let drawn = 0;
    for (const v of values) if (Number.isFinite(v)) drawn++;
    coverage[band.role] = drawn / values.length;
  }

  const slides = slidePanels().map((panel) =>
    rectifyOpacity(
      ink.image,
      ink.paper,
      toImage,
      panel,
      opts.slideWidth ?? 512,
      opts.slideHeight ?? 256,
      ink.margin / INK_FRACTION,
    ),
  );

  return { lanes, slides, crops, coverage };
};
