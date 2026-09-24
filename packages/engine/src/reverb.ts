/**
 * The reverberation strip's destination.
 *
 * Strip 9 controlled how much of the four-timbre mix went to reverb. What it
 * went *to* is not recorded in the sources I have — a Radiophonic Workshop room
 * of that period would have had a plate, a spring, an echo chamber and tape
 * delay available, and Oram's own studio at Tower Folly was her own equipment.
 * So this is a plate: the most likely candidate, the most characteristic of the
 * era, and the one whose sound is least like a modern algorithmic reverb.
 *
 * A Dattorro tank — input diffusers feeding a figure-of-eight of delays with
 * damping and modulated taps. Modulation matters: an unmodulated tank rings on
 * sustained tones, and this instrument holds notes for a long time.
 */

/** Fractional-delay line with a modulated read tap. */
class DelayLine {
  private readonly buffer: Float32Array;
  private readonly mask: number;
  private write = 0;

  constructor(maxSamples: number) {
    // Power of two so wrapping is a mask rather than a modulo.
    let size = 1;
    while (size < maxSamples + 2) size *= 2;
    this.buffer = new Float32Array(size);
    this.mask = size - 1;
  }

  push(v: number): void {
    this.buffer[this.write] = v;
    this.write = (this.write + 1) & this.mask;
  }

  /** Read `delay` samples back, linearly interpolated. */
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

/** All-pass diffuser. */
class AllPass {
  private readonly line: DelayLine;
  constructor(
    private readonly delay: number,
    private readonly gain: number,
  ) {
    this.line = new DelayLine(delay + 4);
  }
  process(x: number, modulation = 0): number {
    const delayed = this.line.read(this.delay + modulation);
    const v = x + delayed * -this.gain;
    this.line.push(v);
    return delayed + v * this.gain;
  }
  clear(): void {
    this.line.clear();
  }
}

/**
 * Which space the send goes to.
 *
 * `plate` is the machine's own answer, or the likeliest one. `room` is the same
 * tank run small and dry, with early reflections in front of it: an echo
 * chamber rather than a sheet of steel, which the Workshop also had.
 */
export type ReverbSpace = 'plate' | 'room';

export interface PlateOptions {
  /** 0-1. Higher holds longer. */
  decay: number;
  /** 0-1. Higher rolls the top off faster, as a real plate does. */
  damping: number;
  /** How much the input is smeared before it reaches the tank. */
  diffusion: number;
  /** Tank modulation depth in samples — stops sustained notes ringing. */
  modulationDepth: number;
  /** Tank modulation rate in Hz. */
  modulationHz: number;
  /** Roll off the input before the tank, so the plate does not fizz. */
  inputCutoffHz: number;
  /**
   * Scales every delay in the tank. 1 is the plate; smaller is a smaller space,
   * which arrives sooner and repeats faster.
   */
  size: number;
  /**
   * Level of the early reflections in front of the tank. A plate has none: it
   * is one sheet, struck all over at once. A room is defined by them.
   */
  earlyLevel: number;
}

export const DEFAULT_PLATE: PlateOptions = {
  decay: 0.72,
  damping: 0.42,
  diffusion: 0.72,
  modulationDepth: 8,
  modulationHz: 0.9,
  inputCutoffHz: 7200,
  size: 1,
  earlyLevel: 0,
};

/**
 * A room: short, damped, less smeared, with distinct early reflections. The
 * tail is the same tank at about a third of the size, which is what makes it
 * sound like walls rather than steel.
 */
export const DEFAULT_ROOM: PlateOptions = {
  decay: 0.55,
  damping: 0.62,
  diffusion: 0.5,
  modulationDepth: 3,
  modulationHz: 1.3,
  inputCutoffHz: 5200,
  size: 0.34,
  earlyLevel: 0.7,
};

export const reverbOptions = (space: ReverbSpace): PlateOptions =>
  space === 'room' ? DEFAULT_ROOM : DEFAULT_PLATE;

/**
 * Early reflections: first bounces off the walls, before the tail builds. Times
 * in milliseconds with their levels, from a small hard room.
 */
const EARLY: [number, number][] = [
  [7, 0.84],
  [13, 0.68],
  [19, 0.55],
  [29, 0.46],
  [37, 0.38],
  [53, 0.3],
  [67, 0.24],
];

/** Dattorro's tank, scaled from his 29.76 kHz prototype to the actual rate. */
const TANK = {
  preA: 142,
  preB: 107,
  preC: 379,
  preD: 277,
  aInner: 672,
  aOuter: 1800,
  aDelay1: 4453,
  aDelay2: 3720,
  bInner: 908,
  bOuter: 2656,
  bDelay1: 4217,
  bDelay2: 3163,
} as const;

/**
 * Trims the tank so a full send sits near unity with the dry signal. Applied
 * to the output taps only, so it has no bearing on the feedback loop's
 * stability.
 */
const OUTPUT_GAIN = 3;

export class PlateReverb {
  private readonly preDiffusers: AllPass[];
  private readonly innerA: AllPass;
  private readonly outerA: AllPass;
  private readonly innerB: AllPass;
  private readonly outerB: AllPass;
  private readonly delayA1: DelayLine;
  private readonly delayA2: DelayLine;
  private readonly delayB1: DelayLine;
  private readonly delayB2: DelayLine;
  private readonly earlyLine: DelayLine;
  private readonly early: [number, number][];

  private readonly aLen1: number;
  private readonly aLen2: number;
  private readonly bLen1: number;
  private readonly bLen2: number;

  private inputLp = 0;
  private dampA = 0;
  private dampB = 0;
  private phase = 0;
  private opts: PlateOptions;
  private readonly sampleRate: number;

  constructor(sampleRate: number, opts: PlateOptions = DEFAULT_PLATE) {
    this.sampleRate = sampleRate;
    this.opts = opts;
    const scale = (sampleRate / 29761) * opts.size;
    const s = (n: number): number => Math.max(1, Math.round(n * scale));

    // Scaled with the space, so a small room's first bounces arrive sooner.
    this.early = EARLY.map(([ms, level]) => [
      Math.max(1, Math.round((ms / 1000) * sampleRate * opts.size)),
      level,
    ]);
    this.earlyLine = new DelayLine(Math.max(...this.early.map(([d]) => d)) + 8);

    this.preDiffusers = [
      new AllPass(s(TANK.preA), 0.75),
      new AllPass(s(TANK.preB), 0.75),
      new AllPass(s(TANK.preC), 0.625),
      new AllPass(s(TANK.preD), 0.625),
    ];
    this.innerA = new AllPass(s(TANK.aInner), 0.7);
    this.outerA = new AllPass(s(TANK.aOuter), 0.5);
    this.innerB = new AllPass(s(TANK.bInner), 0.7);
    this.outerB = new AllPass(s(TANK.bOuter), 0.5);

    this.aLen1 = s(TANK.aDelay1);
    this.aLen2 = s(TANK.aDelay2);
    this.bLen1 = s(TANK.bDelay1);
    this.bLen2 = s(TANK.bDelay2);
    this.delayA1 = new DelayLine(this.aLen1 + 8);
    this.delayA2 = new DelayLine(this.aLen2 + 8);
    this.delayB1 = new DelayLine(this.bLen1 + 8);
    this.delayB2 = new DelayLine(this.bLen2 + 8);
  }

  /**
   * Everything but `size` and the early reflection times, which are built into
   * the delay lines. Changing those means a new reverb.
   */
  setOptions(opts: PlateOptions): void {
    this.opts = opts;
  }

  clear(): void {
    for (const d of this.preDiffusers) d.clear();
    this.innerA.clear();
    this.outerA.clear();
    this.innerB.clear();
    this.outerB.clear();
    this.delayA1.clear();
    this.delayA2.clear();
    this.delayB1.clear();
    this.delayB2.clear();
    this.earlyLine.clear();
    this.inputLp = 0;
    this.dampA = 0;
    this.dampB = 0;
    this.phase = 0;
  }

  /** One sample in, one sample of wet out. Mono, as the machine was. */
  process(x: number): number {
    const { decay, damping, diffusion, modulationDepth, modulationHz } = this.opts;

    const lpCoeff = Math.min(1, (2 * Math.PI * this.opts.inputCutoffHz) / this.sampleRate);
    this.inputLp += (x - this.inputLp) * lpCoeff;

    /*
     * The early reflections, where there are any. They are heard in their own
     * right and they also feed the tank, so the tail grows out of them rather
     * than starting alongside them.
     */
    let early = 0;
    if (this.opts.earlyLevel > 0) {
      this.earlyLine.push(this.inputLp);
      for (let i = 0; i < this.early.length; i++) {
        const tap = this.early[i]!;
        early += this.earlyLine.read(tap[0]) * tap[1];
      }
      early *= this.opts.earlyLevel / this.early.length;
    }

    let v = this.inputLp + early;
    for (let i = 0; i < this.preDiffusers.length; i++) {
      v = this.preDiffusers[i]!.process(v * (0.5 + diffusion * 0.5));
    }

    this.phase += (2 * Math.PI * modulationHz) / this.sampleRate;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    const modA = Math.sin(this.phase) * modulationDepth;
    const modB = Math.sin(this.phase + Math.PI / 2) * modulationDepth;

    // Figure of eight: each half is fed by the other's output.
    const tailB = this.delayB2.read(this.bLen2);
    let a = v + tailB * decay;
    a = this.innerA.process(a, modA);
    this.delayA1.push(a);
    const a1 = this.delayA1.read(this.aLen1);
    this.dampA += (a1 - this.dampA) * (1 - damping);
    a = this.outerA.process(this.dampA * decay);
    this.delayA2.push(a);

    const tailA = this.delayA2.read(this.aLen2);
    let b = v + tailA * decay;
    b = this.innerB.process(b, modB);
    this.delayB1.push(b);
    const b1 = this.delayB1.read(this.bLen1);
    this.dampB += (b1 - this.dampB) * (1 - damping);
    b = this.outerB.process(this.dampB * decay);
    this.delayB2.push(b);

    /*
     * Taps from both halves, which is what gives a plate its density.
     *
     * All the same sign. Dattorro alternates them to decorrelate a stereo
     * pair, but this output is mono, and summing opposed taps cancels — it left
     * the wet signal about a twelfth of the input and the send control did
     * almost nothing.
     */
    const taps =
      this.delayA1.read(this.aLen1 * 0.41) +
      this.delayA1.read(this.aLen1 * 0.83) +
      this.delayA2.read(this.aLen2 * 0.55) +
      this.delayB1.read(this.bLen1 * 0.36) +
      this.delayB1.read(this.bLen1 * 0.72) +
      this.delayB2.read(this.bLen2 * 0.48);
    return (taps / 6) * OUTPUT_GAIN + early * OUTPUT_GAIN;
  }
}
