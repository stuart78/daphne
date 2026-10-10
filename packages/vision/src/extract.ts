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

/**
 * Longest hole, in millimetres, that the printing can be blamed for. The widest
 * thing the sheet prints inside a band is the rail label, at 8.7 mm from the
 * frame; past that a blank is the paper's own.
 */
const MAX_RECOVER_MM = 10;

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

/**
 * Put back what the sheet's own ink hid.
 *
 * The template prints inside the drawing area: rail labels in the corners of
 * every band, a column of frequencies down the pitch band, a centre rail on the
 * bipolar lanes. A stroke drawn across one of those cannot be told from the
 * printing and goes unread, which is right. What is wrong is leaving the hole:
 * an amplitude that drops to silence for the first half second because the line
 * started behind the word "silence", or a vibrato line cut into pieces each
 * time it crosses its own centre rail.
 *
 * So a hole is filled only where the printing explains it: every missing column
 * has to be one where the line, had it been drawn there, would have been inside
 * a printed strip. Anywhere else a blank stays blank, because blank paper is a
 * real thing on a sheet and the engine rests or holds on it.
 *
 * `masks` is the printed strips per column, in the same 0-1 units as `values`.
 * `clamped` marks the columns whose sample was pulled inside the frame, which
 * are not readings of their own column and so never stand in the way. `grace`
 * is how many columns either side of the printing may go unexplained: ink has
 * width, so a stroke running behind a label or a rule also loses the sliver
 * where it touches it. `reach` caps how long a hole may be: the printing this
 * stands for is a label or a rule, both of them small, and a longer hole is
 * either blank paper or a line that ran along a rule for so long that nobody
 * can say what it did there.
 */
const recoverBehindFurniture = (
  values: Float32Array,
  masks: [number, number][][],
  clamped: boolean[],
  grace: number,
  reach: number,
): void => {
  const hidden = (column: number, value: number): boolean =>
    clamped[column] === true ||
    (masks[column] ?? []).some(([low, high]) => value >= low && value <= high);

  const fill = (from: number, to: number, at: (k: number) => number): boolean => {
    if (to - from > reach) return false;
    let unexplained = 0;
    for (let i = from; i < to; i++) if (!hidden(i, at(i))) unexplained++;
    if (unexplained > grace) return false;
    for (let i = from; i < to; i++) values[i] = at(i);
    return true;
  };

  // The ends: a mark that starts or stops inside the printing ran to the edge.
  let first = 0;
  while (first < values.length && !Number.isFinite(values[first]!)) first++;
  if (first >= values.length) return; // nothing was read at all
  if (first > 0) fill(0, first, () => values[first]!);

  let last = values.length - 1;
  while (last >= 0 && !Number.isFinite(values[last]!)) last--;
  if (last < values.length - 1) fill(last + 1, values.length, () => values[last]!);

  // The middle: a line that crossed a rule and came out the other side.
  for (let i = first + 1; i < last; i++) {
    if (Number.isFinite(values[i]!)) continue;
    let end = i;
    while (end <= last && !Number.isFinite(values[end]!)) end++;
    const before = values[i - 1]!;
    const after = values[end]!;
    if (Number.isFinite(before) && Number.isFinite(after)) {
      fill(i, end, (k) => before + ((after - before) * (k - i + 1)) / (end - i + 1));
    }
    i = end;
  }
};

export interface ReadOptions extends ExtractOptions {
  /** Samples across the field. Matches the app's lane resolution. */
  columns: number;
  /** Vertical drift of the printed frame across the page, from `traceDrift`. */
  drift?: Float32Array;
  /** Where this band's own box really is, left and right, from `traceFrameX`. */
  frame?: [number, number];
}

/**
 * Where a band's box actually starts and ends across the page.
 *
 * The homography maps the four corner fiducials exactly, and over the length of
 * a 300 mm field a printer that lays the content a hair small or a hair off
 * centre still leaves a millimetre or two unaccounted for at each end. Taken
 * from the page geometry alone, a band's first second of time lands on the
 * gutter and its last lands inside the frame. Second 12 then is not second 12,
 * and the registered picture sits beside the reading rather than under it.
 *
 * So each band says where its own left and right sides are, by looking for
 * them. The side is a full-height line and nothing else in a band is, so the
 * search is simply: which column, within a few millimetres of where the
 * geometry puts it, has ink all the way down. A band is only moved when the
 * paper says so clearly, as with `traceDrift`; otherwise it stays where the
 * geometry puts it, since on a clean scan that is already right.
 */
/**
 * The same for the top and bottom of a rectangle, which the timbre panels need.
 *
 * A band gets its rows from `traceDrift`, which follows the rules across the
 * whole page. A panel is small and sits in its own row of four, so it is
 * cheaper and steadier to find its own two rules. Getting this wrong is not
 * subtle: a panel sampled a millimetre high takes in the title printed above it
 * and the whole top of the slide comes back painted solid.
 */
const traceFrameY = (
  ink: Ink,
  toImage: Matrix3,
  rect: Rect,
  searchMm = 4,
  samples = 24,
): [number, number] => {
  const inset = rect.w * 0.05;
  const score = (y: number): number => {
    let total = 0;
    for (let i = 0; i < samples; i++) {
      const x = rect.x + inset + ((rect.w - inset * 2) * (i + 0.5)) / samples;
      total += isInk(ink, toImage, x, y);
    }
    return total;
  };

  const findEdge = (nominal: number): number => {
    let best = nominal;
    let bestInk = -1;
    for (let d = -searchMm; d <= searchMm; d += 0.05) {
      const total = score(nominal + d);
      if (total > bestInk + 1e-6 || (total > bestInk - 1e-6 && Math.abs(d) < Math.abs(best - nominal))) {
        bestInk = total;
        best = nominal + d;
      }
    }
    return bestInk > score(nominal) * 1.2 ? best : nominal;
  };

  const top = findEdge(rect.y);
  const bottom = findEdge(rect.y + rect.h);
  return bottom - top > rect.h * 0.8 ? [top, bottom] : [rect.y, rect.y + rect.h];
};

/** A rectangle registered on its own printed box, all four sides. */
export const traceFrame = (ink: Ink, toImage: Matrix3, rect: Rect, searchMm = 4): Rect => {
  const [left, right] = traceFrameX(ink, toImage, rect, searchMm);
  const [top, bottom] = traceFrameY(ink, toImage, { ...rect, x: left, w: right - left }, searchMm);
  return { x: left, y: top, w: right - left, h: bottom - top };
};

export const traceFrameX = (
  ink: Ink,
  toImage: Matrix3,
  rect: Rect,
  searchMm = 4,
  samples = 12,
): [number, number] => {
  const inset = rect.h * 0.08; // clear of the top and bottom rules
  const score = (x: number): number => {
    let total = 0;
    for (let i = 0; i < samples; i++) {
      const y = rect.y + inset + ((rect.h - inset * 2) * (i + 0.5)) / samples;
      total += isInk(ink, toImage, x, y);
    }
    return total;
  };

  const findEdge = (nominal: number): number => {
    let best = nominal;
    let bestInk = -1;
    for (let d = -searchMm; d <= searchMm; d += 0.05) {
      const total = score(nominal + d);
      if (total > bestInk + 1e-6 || (total > bestInk - 1e-6 && Math.abs(d) < Math.abs(best - nominal))) {
        bestInk = total;
        best = nominal + d;
      }
    }
    return bestInk > score(nominal) * 1.2 ? best : nominal;
  };

  const left = findEdge(rect.x);
  const right = findEdge(rect.x + rect.w);
  // A pair that crossed over or collapsed is not a frame; trust the geometry.
  return right - left > rect.w * 0.8 ? [left, right] : [rect.x, rect.x + rect.w];
};

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

  /*
   * The tips of a stroke, where the pen lands and lifts.
   *
   * A cap is shorter than the stroke it ends and often sits low in the column,
   * so the last column or two of a mark can read half a band away from the rest
   * of it. In the middle of a stroke that is a spike and already handled; at the
   * ends there is no neighbour on the far side to disagree with, so it survives
   * and the mark appears to dive as it starts and stops. Dropped rather than
   * corrected: nobody knows where the tip was, only that it was not there.
   */
  const trim = 2;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]!)) continue;
    let end = i;
    while (end < values.length && Number.isFinite(values[end]!)) end++;
    // Judged against the body of the stroke, not against the next column: a
    // cap often spans two columns, and those two agree with each other.
    const head = values[Math.min(i + trim, end - 1)]!;
    for (let k = 0; k < trim && i + k < end - 1; k++) {
      if (Math.abs(values[i + k]! - head) <= tolerance) break;
      values[i + k] = Number.NaN;
    }
    const tail = values[Math.max(end - 1 - trim, i)]!;
    for (let k = 0; k < trim && end - 1 - k > i; k++) {
      if (Math.abs(values[end - 1 - k]! - tail) <= tolerance) break;
      values[end - 1 - k] = Number.NaN;
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
  /** The printed strips at each column, as values rather than millimetres. */
  const masks: [number, number][][] = [];
  /** Columns whose sample position was pulled inside the frame. */
  const clamped: boolean[] = [];

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

  // Where the band's sides really are, so time is measured along the printed
  // band rather than along the geometry's idea of it.
  const [frameLeft, frameRight] = opts.frame ?? [rect.x, rect.x + rect.w];

  for (let i = 0; i < opts.columns; i++) {
    const t = i / (opts.columns - 1);
    // Clamped inside the frame for the same reason the rows are: the left and
    // right borders are full-height ink, and being vertical they cannot be
    // described as a strip at some height the way the rules can. Clamping costs
    // the outer half millimetre of time rather than shifting the axis.
    const wanted = frameLeft + (frameRight - frameLeft) * t;
    const x = Math.min(frameRight - inset, Math.max(frameLeft + inset, wanted));
    clamped.push(x !== wanted);
    // The furniture is quoted against the geometry, so it is looked up there.
    const nominalX = rect.x + rect.w * t;
    // Where the frame actually is, rather than where the geometry says.
    const shift = opts.drift ? driftAt(opts.drift, (x - rect.x) / rect.w) : 0;
    const top = rect.y + shift;
    const bottom = rect.y + rect.h + shift;
    const interior: Rect = { x: rect.x, y: top + inset, w: rect.w, h: rect.h - inset * 2 };

    // Furniture is quoted against the nominal band, so it moves with the frame.
    // Otherwise the centre rail's strip sits a millimetre off the centre rail on
    // a bowed page and stops explaining it.
    const mask = maskFor(furniture, nominalX).map(
      ([a, b]) => [a + shift, b + shift] as [number, number],
    );
    const toValue = (mm: number): number => 1 - (mm - top) / (bottom - top);
    masks.push(mask.map(([a, b]) => [toValue(b), toValue(a)] as [number, number]));

    const y = positionOf(runsInColumn(ink, toImage, interior, x, step), mask, minMark);
    out[i] = Number.isNaN(y) ? Number.NaN : 1 - (y - top) / (bottom - top);
  }
  despeckle(out);
  // The frame's own ink is `inset` wide, so a stroke behind the printing loses
  // that much either side of it as well.
  const perMm = opts.columns / rect.w;
  recoverBehindFurniture(out, masks, clamped, Math.ceil(inset * perMm), Math.round(MAX_RECOVER_MM * perMm));
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

/**
 * Lay a scanned timbre stroke at the weight a painted one has.
 *
 * A slide is read as an opacity field, which keeps everything on the glass. But
 * a pen line on paper is about a twentieth of the panel high, where enamel laid
 * on with a brush is a seventh, and the scanning spot is wider than the pen
 * line is: the servo gets a weak, intermittent edge to ride and the voice comes
 * out several times quieter than the same shape drawn in the app. Pen skips
 * make it worse, because every missing column drops the spot for that part of
 * the cycle.
 *
 * So the traced line is laid again underneath itself at brush weight, with pen
 * skips bridged. The top edge, which is the part the spot rides and the part
 * somebody aimed, is not moved; the original ink is kept, so a second ribbon
 * painted lower down survives. A gap too long to be a skip is left alone: that
 * is somebody dropping the spot on purpose.
 */
/**
 * Rub out the sheet's own printing inside a field.
 *
 * Containment again, as for the bands: a run of ink down a column counts as
 * printing only when it fits inside the strip a printed rule occupies. A drawn
 * stroke crossing the centre rule is thicker than the rule and stays.
 *
 * Rules only, which means strips thinner than a stroke. The panel also prints
 * its +1, zero and -1 labels in a block most of its height, and anything drawn
 * through that block fits inside it: clearing by containment there would rub
 * out the last eighth of every cycle somebody drew.
 */
const clearFurniture = (
  field: Float32Array,
  width: number,
  height: number,
  rect: Rect,
  furniture: Rect[],
): void => {
  const INK = 0.35;
  const toRow = (mm: number): number => ((mm - rect.y) / rect.h) * height;
  const inside = furniture
    .filter(
      (f) =>
        f.x < rect.x + rect.w && f.x + f.w > rect.x && f.y < rect.y + rect.h && f.y + f.h > rect.y,
    )
    .map((f) => ({
      x0: ((f.x - rect.x) / rect.w) * width,
      x1: ((f.x + f.w - rect.x) / rect.w) * width,
      y0: toRow(f.y),
      y1: toRow(f.y + f.h),
      rule: f.h < rect.h * 0.1,
    }));

  /** Every run of ink down one column, as [start, end). */
  const runs = (x: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let y = 0; y < height; y++) {
      if (field[y * width + x]! < INK) continue;
      let end = y;
      while (end < height && field[end * width + x]! >= INK) end++;
      out.push([y, end]);
      y = end;
    }
    return out;
  };

  const erase = (x: number, [from, to]: [number, number]): void => {
    for (let k = from; k < to; k++) field[k * width + x] = 0;
  };

  for (const strip of inside.filter((f) => f.rule)) {
    for (let x = Math.max(0, Math.floor(strip.x0)); x <= Math.min(width - 1, Math.ceil(strip.x1)); x++) {
      for (const run of runs(x)) {
        if (run[0] >= strip.y0 - 0.5 && run[1] - 1 <= strip.y1 + 0.5) erase(x, run);
      }
    }
  }

  /*
   * Blocks of printed text, such as the +1, zero and -1 against the right-hand
   * edge of every timbre panel.
   *
   * Containment cannot help here: the block is most of the panel high, so a
   * stroke drawn through it fits inside it too. What separates them is that the
   * stroke comes from somewhere. Ink inside the block is kept only where it
   * joins up, column by column, with ink outside it; the rest is printing, and
   * it used to show up as a one-pixel tick hanging off a slide.
   */
  for (const block of inside.filter((f) => !f.rule)) {
    const from = Math.max(0, Math.floor(block.x0));
    const to = Math.min(width - 1, Math.ceil(block.x1));
    if (to < from) continue;

    const keep: Set<number>[] = [];
    for (let x = from; x <= to; x++) keep.push(new Set<number>());
    const columns: [number, number][][] = [];
    for (let x = from; x <= to; x++) columns.push(runs(x));

    const touches = (a: [number, number], b: [number, number]): boolean =>
      a[0] <= b[1] && b[0] <= a[1];

    const sweep = (start: number, step: number): void => {
      let previous = runs(start - step); // the column just outside the block
      for (let x = start; x >= from && x <= to; x += step) {
        const here = columns[x - from]!;
        const reached = here.filter((run) => previous.some((p) => touches(run, p)));
        for (const run of reached) keep[x - from]!.add(run[0]);
        previous = reached;
        if (reached.length === 0) break;
      }
    };
    if (from > 0) sweep(from, 1);
    if (to < width - 1) sweep(to, -1);

    for (let x = from; x <= to; x++) {
      for (const run of columns[x - from]!) {
        if (!keep[x - from]!.has(run[0])) erase(x, run);
      }
    }
  }
};

export const inkRibbon = (field: Float32Array, width: number, height: number): Float32Array => {
  /** A drawn stroke is this fraction of the panel high, as the app's brush is. */
  const thickness = Math.max(1, Math.round(height * 0.14));
  /** Longer than this and the gap was meant. */
  const maxSkip = Math.max(2, Math.round(width * 0.03));
  const INK = 0.35;
  /*
   * What counts as a stroke at all.
   *
   * The panel's border runs along the top and bottom of the field, and a
   * photograph leaves specks along it. Taken for paint, they put a brush-wide
   * bar across the whole slide, so anything too thin to be a pen, or lying
   * wholly within the border, is rubbed out rather than ridden.
   */
  const minRun = Math.max(2, Math.round(height * 0.012));
  const margin = Math.max(1, Math.round(height * 0.015));
  /** The same for the sides, where the panel's left and right borders run. */
  const sideMargin = Math.max(1, Math.round(width * 0.005));

  const out = new Float32Array(field.length);
  const edge = new Float32Array(width).fill(Number.NaN);
  for (let x = sideMargin; x < width - sideMargin; x++) {
    for (let y = 0; y < height; y++) {
      if (field[y * width + x]! < INK) continue;
      let end = y;
      while (end < height && field[end * width + x]! >= INK) end++;
      const thin = end - y < minRun;
      const onBorder = end <= margin || y >= height - margin;
      if (!thin && !onBorder) {
        for (let k = y; k < end; k++) out[k * width + x] = field[k * width + x]!;
        if (Number.isNaN(edge[x]!)) edge[x] = y;
      }
      y = end;
    }
  }

  let first = 0;
  while (first < width && Number.isNaN(edge[first]!)) first++;
  if (first === width) return out; // clear glass, nothing to lay

  let last = width - 1;
  while (Number.isNaN(edge[last]!)) last--;
  // A pen that started or stopped a little inside the panel still meant to
  // cross it, so long as the shortfall is skip-sized.
  if (first <= maxSkip) edge.fill(edge[first]!, 0, first);
  if (width - 1 - last <= maxSkip) edge.fill(edge[last]!, last + 1, width);

  for (let x = first + 1; x < last; x++) {
    if (!Number.isNaN(edge[x]!)) continue;
    let end = x;
    while (end <= last && Number.isNaN(edge[end]!)) end++;
    if (end - x <= maxSkip) {
      const from = edge[x - 1]!;
      const to = edge[end]!;
      for (let k = x; k < end; k++) edge[k] = from + ((to - from) * (k - x + 1)) / (end - x + 1);
    }
    x = end;
  }

  for (let x = 0; x < width; x++) {
    const top = edge[x]!;
    if (Number.isNaN(top)) continue;
    for (let k = 0; k < thickness; k++) {
      const y = Math.round(top) + k;
      if (y >= height) break;
      out[y * width + x] = 1;
    }
  }
  return out;
};

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
    /*
     * Each band is registered on its own box rather than on the page alone, and
     * the picture is cut to the same box as the reading. Otherwise the paper
     * behind a lane sits a millimetre or two beside the line drawn over it.
     */
    const frame = traceFrameX(ink, toImage, band.rect);
    const shift = driftAt(drift, 0.5);
    crops[band.role] = rectify(
      ink.image,
      toImage,
      { x: frame[0], y: band.rect.y + shift, w: frame[1] - frame[0], h: band.rect.h },
      perMm,
    );
    const values = readRegion(ink, toImage, band.rect, furniture, {
      ...opts,
      columns: laneColumns,
      drift,
      frame,
    });
    lanes[band.role] = values;
    let drawn = 0;
    for (const v of values) if (Number.isFinite(v)) drawn++;
    coverage[band.role] = drawn / values.length;
  }

  const slideWidth = opts.slideWidth ?? 512;
  const slideHeight = opts.slideHeight ?? 256;
  const slides = slidePanels().map((panel) => {
    const box = traceFrame(ink, toImage, panel);
    const field = rectifyOpacity(
      ink.image,
      ink.paper,
      toImage,
      box,
      slideWidth,
      slideHeight,
      ink.margin / INK_FRACTION,
    );
    // The panel prints its own border, centre rule and labels. Left in, the
    // ribbon tracer rides whichever of them is highest in the column.
    // The panel prints its own border, centre rule and labels. Left in, the
    // ribbon tracer rides whichever of them is highest in the column.
    clearFurniture(field, slideWidth, slideHeight, box, furniture);
    return inkRibbon(field, slideWidth, slideHeight);
  });

  return { lanes, slides, crops, coverage };
};
