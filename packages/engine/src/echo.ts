/**
 * The other thing a control strip can drive: an echo.
 *
 * Not on the machine. The vibrato strip bends the pitch, and that is what strip
 * 8 did, but a line whose height means a time is exactly the sort of use a tape
 * echo in the same room would have been put to, and the workshop wants it.
 *
 * Tape-like in one respect that matters: the delay time is glided to rather
 * than jumped to, so dragging the line up drops the pitch of what is already in
 * the line, the way pulling the heads apart would.
 */

/** Fractional-delay line, as in reverb.ts but with a longer buffer. */
class Tape {
  private readonly buffer: Float32Array;
  private readonly mask: number;
  private write = 0;

  constructor(maxSamples: number) {
    let size = 1;
    while (size < maxSamples + 2) size *= 2;
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
  }

  push(v: number): void {
    this.buffer[this.write] = v;
    this.write = (this.write + 1) & this.mask;
  }

  read(delay: number): number {
    const pos = this.write - delay + this.buffer.length;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    const a = this.buffer[i0 & this.mask]!;
    const b = this.buffer[(i0 + 1) & this.mask]!;
    return a + (b - a) * f;
  }

  clear(): void {
    this.buffer.fill(0);
    this.write = 0;
  }
}

/** Shortest and longest the line goes, in seconds. */
export const ECHO_MIN_S = 0.02;
export const ECHO_MAX_S = 1.2;

/** Lane height to delay time. Exponential, so the useful times are spread out. */
export const echoSeconds = (height: number): number =>
  ECHO_MIN_S * (ECHO_MAX_S / ECHO_MIN_S) ** Math.max(0, Math.min(1, height));

export interface EchoOptions {
  /** How much of the output goes back in, 0 to just under 1. */
  feedback: number;
  /** How much of the echo is added to the dry signal. */
  mix: number;
  /** Seconds for the delay time to reach a new setting. */
  glideS: number;
  /** Rolls the top off each time round, as tape does. */
  dampHz: number;
}

/*
 * Loud enough to be the point.
 *
 * At half mix and a third feedback the first repeat came back about ten
 * decibels under the note and the third was inaudible, which is a hint of an
 * echo rather than an echo. A tape delay in a studio is mixed to sit alongside
 * what it repeats, so the wet is near the dry and the line holds on for half a
 * dozen repeats before it goes.
 */
export const DEFAULT_ECHO: EchoOptions = {
  feedback: 0.5,
  mix: 0.85,
  glideS: 0.08,
  dampHz: 4800,
};

/** Two channels, one time: the echo keeps whatever the pan put in it. */
export class Echo {
  private readonly lines: [Tape, Tape];
  private readonly sampleRate: number;
  private opts: EchoOptions;
  private current: number;
  private damp: [number, number] = [0, 0];

  constructor(sampleRate: number, opts: EchoOptions = DEFAULT_ECHO) {
    this.sampleRate = sampleRate;
    this.opts = opts;
    this.lines = [new Tape(sampleRate * ECHO_MAX_S + 8), new Tape(sampleRate * ECHO_MAX_S + 8)];
    this.current = ECHO_MIN_S * sampleRate;
  }

  setOptions(opts: Partial<EchoOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  clear(): void {
    for (const line of this.lines) line.clear();
    this.damp = [0, 0];
  }

  /**
   * One sample per channel in, the echo out. `height` is the lane, 0 to 1.
   * Returns into `out`, which is not allocated here: this runs per sample.
   */
  process(l: number, r: number, height: number, out: [number, number]): void {
    const target = echoSeconds(height) * this.sampleRate;
    // One pole towards the new time. The glide is what makes it slide in pitch.
    const glide = 1 - Math.exp(-1 / (this.opts.glideS * this.sampleRate));
    this.current += (target - this.current) * glide;

    const damp = Math.min(1, (2 * Math.PI * this.opts.dampHz) / this.sampleRate);
    const feedback = Math.max(0, Math.min(0.95, this.opts.feedback));
    for (let c = 0; c < 2; c++) {
      const line = this.lines[c]!;
      const delayed = line.read(this.current);
      const damped = this.damp[c]! + (delayed - this.damp[c]!) * damp;
      this.damp[c] = damped;
      line.push((c === 0 ? l : r) + damped * feedback);
      out[c] = damped * this.opts.mix;
    }
  }
}
