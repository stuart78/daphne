/**
 * A control lane: one scanned sheet, compiled to normalised samples, plus the
 * read head travelling across it.
 *
 * The original machine drove all ten strips off one clutch, so they were rigidly
 * synchronised. Each lane here carries its own position and speed anyway —
 * that is the first deliberate break with the machine, and it costs nothing to
 * support, so the faithful behaviour is just every lane sharing a speed of 1.
 */

export class ControlLane {
  /** Normalised 0-1 samples, evenly spaced across `durationS`. */
  private data: Float32Array = new Float32Array([0]);
  private durationS = 1;

  /** Read head position, in seconds from the start of the lane. */
  position = 0;
  /** Speed multiplier. Negative runs the head backwards. */
  speed = 1;
  /** Wrap at the end rather than holding the last value. */
  loop = true;
  /** Value used when the lane has no sheet loaded. */
  defaultValue = 0;

  /**
   * What an undrawn stretch means. Lanes carry NaN wherever nothing was drawn,
   * because a scanned sheet is mostly blank paper and bridging the gaps would
   * invent a line nobody drew.
   *
   *   'rest'  fall back to `defaultValue` — silence on an amplitude lane
   *   'hold'  keep the last value seen, which is what the pitch strips did:
   *           the relays latch, so a frequency persists until new spots
   *           change it, and that is why a painted strip is mostly empty
   */
  gapBehaviour: 'rest' | 'hold' = 'rest';

  /**
   * Blend between neighbouring samples, or step from one to the next.
   *
   * Right for a contour and wrong for a choice. A note lane stepping from E to A
   * between two columns would, interpolated, spend a few milliseconds on F, F#
   * and G on the way, and those are notes nobody wrote. Stepping lanes take the
   * sample to their left and hold it until the next.
   */
  interpolate = true;

  /**
   * Last drawn value seen, for 'hold'. Null until one has been read.
   *
   * "Hold" means sustain the last value; before anything has been drawn there
   * is nothing to sustain, so the lane rests at its default instead. Starting
   * this at zero meant a blank transport strip read as a dead stop and nothing
   * on the machine advanced at all.
   */
  private held: number | null = null;

  private loaded = false;

  get isLoaded(): boolean {
    return this.loaded;
  }

  get duration(): number {
    return this.durationS;
  }

  /** Install a compiled sheet. `durationS` comes from the sheet's own QR. */
  load(data: Float32Array, durationS: number): void {
    if (data.length === 0) throw new Error('ControlLane.load: empty data');
    if (!(durationS > 0)) throw new Error(`ControlLane.load: bad duration ${durationS}`);
    this.data = data;
    this.durationS = durationS;
    this.loaded = true;
  }

  clear(): void {
    this.data = new Float32Array([0]);
    this.loaded = false;
  }

  /** Advance the head by `dt` seconds, scaled by this lane's speed. */
  advance(dt: number): void {
    this.position += dt * this.speed;
    if (this.loop) {
      // Modulo that behaves for negative positions, so reverse playback wraps.
      this.position -= Math.floor(this.position / this.durationS) * this.durationS;
    } else {
      this.position = Math.max(0, Math.min(this.durationS, this.position));
    }
  }

  /**
   * Value under the head right now, linearly interpolated.
   *
   * Interpolation only happens between two drawn samples. Where either side is
   * blank the lane falls back to its gap behaviour rather than ramping into or
   * out of nothing.
   */
  read(): number {
    if (!this.loaded) return this.gap();
    const n = this.data.length;
    const pos = (this.position / this.durationS) * (n - 1);
    const i0 = Math.floor(pos);
    if (i0 < 0) return this.sample(this.data[0]!);
    if (i0 >= n - 1) return this.sample(this.data[n - 1]!);

    const a = this.data[i0]!;
    const b = this.data[i0 + 1]!;
    // A sample's value owns the cell to its right. Blank on the left means the
    // whole cell is a gap, so a drawn stretch never starts early — it begins
    // exactly where it was drawn.
    if (!Number.isFinite(a)) return this.gap();
    if (!Number.isFinite(b) || !this.interpolate) return this.sample(a);

    const f = pos - i0;
    return this.sample(a * (1 - f) + b * f);
  }

  private sample(v: number): number {
    this.held = v;
    return v;
  }

  private gap(): number {
    if (this.gapBehaviour === 'hold' && this.held !== null) return this.held;
    return this.defaultValue;
  }

  reset(): void {
    this.position = 0;
    this.held = null;
  }
}
