/**
 * A painted glass slide: a 2-D opacity field, not a curve.
 *
 * Oram's surviving slides carry four thick, irregular ribbons of paint stacked
 * vertically, each spanning the full width, with clear glass above and below.
 * A slide is a library of four waveforms; the numbered stickers down its edges
 * are how you position it to select one. Nothing about that is expressible as a
 * single-valued function of x, which is why this is a field and the oscillator
 * is a servo (see scanner.ts) rather than a table lookup.
 *
 * Opacity is continuous, not binary. Where Oram's paint went thin and scratchy
 * the photomultiplier saw partial light, so the loop's error signal was graded
 * and the spot settled *inside* the stroke. Thresholding to black and white
 * would throw that away.
 */

export const SLIDE_WIDTH = 512;
export const SLIDE_HEIGHT = 256;

export interface SlideOptions {
  /**
   * Radius of the CRT scanning spot, as a fraction of slide height. The spot
   * has real width, so the loop sees a softened version of the paint; baking
   * the blur in at construction makes the per-sample cost one lookup.
   */
  spotSize: number;
}

export const DEFAULT_SLIDE: SlideOptions = { spotSize: 0.012 };

/**
 * Apply the scanning spot's blur to a raw painted field, off the audio thread.
 * Pair with `Slide.preblurred`.
 */
export const blurSpot = (
  field: ArrayLike<number>,
  width: number,
  height: number,
  opts: SlideOptions = DEFAULT_SLIDE,
): Float32Array => blurField(Float32Array.from(field), width, height, opts.spotSize * height);

/** Separable Gaussian blur over a w x h field, clamped at the edges. */
export const blurField = (
  src: Float32Array,
  w: number,
  h: number,
  sigma: number,
): Float32Array => {
  if (sigma <= 0.01) return src;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= sum;

  const clamp = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += src[y * w + clamp(x + k, w - 1)]! * kernel[k + radius]!;
      }
      tmp[y * w + x] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += tmp[clamp(y + k, h - 1) * w + x]! * kernel[k + radius]!;
      }
      out[y * w + x] = acc;
    }
  }
  return out;
};

/** What the scanner needs from a slide. */
export interface ScannableSlide {
  light(x01: number, y01: number): number;
  columnHasPaint(x01: number, threshold?: number): boolean;
  /** False for clear glass: nothing painted anywhere on it. */
  readonly painted: boolean;
}

export class Slide implements ScannableSlide {
  readonly width: number;
  readonly height: number;
  /** 0 = clear glass, 1 = fully opaque paint. Already blurred by the spot. */
  private readonly opacity: Float32Array;
  /** Darkest point in each column, so the scanner can tell bare glass from a gap. */
  private readonly columnPaint: Float32Array;
  /**
   * Is there paint anywhere at all?
   *
   * Clear glass passes the light straight through, so the photocell sees a
   * steady beam and the voice is silent. The scanner sits at the rail in that
   * case, which is a constant rather than a sound, but a constant multiplied by
   * a rising amplitude is a thump. Knowing the slide is empty lets the machine
   * put out nothing at all.
   */
  readonly painted: boolean;

  private constructor(opacity: Float32Array, width: number, height: number) {
    this.opacity = opacity;
    this.width = width;
    this.height = height;
    this.columnPaint = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let max = 0;
      for (let y = 0; y < height; y++) {
        const v = opacity[y * width + x]!;
        if (v > max) max = v;
      }
      this.columnPaint[x] = max;
    }
    this.painted = this.columnPaint.some((v) => v >= 0.5);
  }

  /**
   * Is there anything to find in this column?
   *
   * The scanner needs this to distinguish "I have lost the stroke, sweep and
   * reacquire" from "there is no slide in the carrier". Without it a blank
   * slide would hunt forever and an unassigned timbre would buzz, where the
   * real machine just sits dark at the rail.
   */
  columnHasPaint(x01: number, threshold = 0.5): boolean {
    const x = Math.floor((x01 - Math.floor(x01)) * this.width) % this.width;
    return this.columnPaint[x]! >= threshold;
  }

  /**
   * Build from a raw opacity field, row 0 at the TOP (y = +1 in audio terms),
   * matching how a paint canvas hands over its pixels.
   */
  static fromField(
    field: ArrayLike<number>,
    width: number,
    height: number,
    opts: SlideOptions = DEFAULT_SLIDE,
  ): Slide {
    if (field.length !== width * height) {
      throw new Error(`Slide.fromField: expected ${width * height} samples, got ${field.length}`);
    }
    const src = Float32Array.from(field);
    return new Slide(blurField(src, width, height, opts.spotSize * height), width, height);
  }

  /**
   * Wrap a field that has already been blurred for the spot.
   *
   * The blur is a few million operations — fine on the main thread, a dropped
   * buffer on the audio thread. The renderer blurs with `blurSpot` before
   * handing the field across, so installing a slide mid-performance costs only
   * the column scan.
   */
  static preblurred(field: ArrayLike<number>, width: number, height: number): Slide {
    if (field.length !== width * height) {
      throw new Error(`Slide.preblurred: expected ${width * height} samples, got ${field.length}`);
    }
    return new Slide(Float32Array.from(field), width, height);
  }

  /**
   * Paint a ribbon whose TOP edge follows a contour in -1..1. This is how a
   * plain drawn line becomes something the scanner can track, and it is what
   * the app's simpler drawing mode produces.
   */
  static fromContour(
    contour: ArrayLike<number>,
    thickness = 0.18,
    opts: SlideOptions = DEFAULT_SLIDE,
  ): Slide {
    const w = SLIDE_WIDTH;
    const h = SLIDE_HEIGHT;
    const field = new Float32Array(w * h);
    const n = contour.length;
    for (let x = 0; x < w; x++) {
      const t = (x / w) * n;
      const i0 = Math.floor(t) % n;
      const i1 = (i0 + 1) % n;
      const f = t - Math.floor(t);
      const v = contour[i0]! * (1 - f) + contour[i1]! * f;
      // -1..1 with +1 at the top maps to row 0 at the top.
      const topRow = ((1 - v) / 2) * (h - 1);
      const bottomRow = topRow + thickness * h;
      for (let y = 0; y < h; y++) {
        if (y >= topRow && y <= bottomRow) field[y * w + x] = 1;
      }
    }
    return Slide.fromField(field, w, h, opts);
  }

  /** A slide with no paint at all — the scanner will simply sit dark at the rail. */
  static blank(): Slide {
    return new Slide(new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT), SLIDE_WIDTH, SLIDE_HEIGHT);
  }

  /** A plain sine ribbon, so an untouched timbre still makes a sound. */
  static sine(): Slide {
    const contour = new Float32Array(SLIDE_WIDTH);
    for (let i = 0; i < SLIDE_WIDTH; i++) {
      contour[i] = Math.sin((2 * Math.PI * i) / SLIDE_WIDTH);
    }
    return Slide.fromContour(contour);
  }

  /**
   * Trace the top edge of the paint, as a contour in -1..1.
   *
   * This is what the servo would settle on given infinite bandwidth, so it is
   * what the wavetable bypass plays — the same slide, minus every artifact the
   * loop contributes. Columns with no paint report the bottom rail, which is
   * where the spot would actually end up.
   */
  topEdgeContour(samples = 1024, threshold = 0.5): Float32Array {
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = Math.min(this.width - 1, Math.round((i / samples) * this.width));
      let found = -1;
      for (let row = 0; row < this.height; row++) {
        if (this.opacity[row * this.width + x]! >= threshold) {
          found = row;
          break;
        }
      }
      out[i] = found < 0 ? -1 : 1 - (found / (this.height - 1)) * 2;
    }
    return out;
  }

  /**
   * Transmitted light at a point, 1 = clear. `x01` wraps (the sweep repeats);
   * `y01` is 0 at the bottom rail and 1 at the top, and clamps.
   */
  light(x01: number, y01: number): number {
    const w = this.width;
    const h = this.height;

    let fx = (x01 - Math.floor(x01)) * w;
    const x0 = Math.floor(fx) % w;
    const x1 = (x0 + 1) % w;
    fx -= Math.floor(fx);

    // y01 runs bottom-up; rows run top-down.
    const fyRaw = (1 - Math.max(0, Math.min(1, y01))) * (h - 1);
    const y0 = Math.floor(fyRaw);
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = fyRaw - y0;

    const o =
      this.opacity[y0 * w + x0]! * (1 - fx) * (1 - fy) +
      this.opacity[y0 * w + x1]! * fx * (1 - fy) +
      this.opacity[y1 * w + x0]! * (1 - fx) * fy +
      this.opacity[y1 * w + x1]! * fx * fy;

    return 1 - o;
  }
}
