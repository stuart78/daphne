/**
 * The voice.
 *
 * Monophonic, four timbres. One master pitch drives four drawn-wavetable
 * oscillators in unison; each has its own amplitude lane through its own
 * optical attenuator, and the four are summed. That is the machine: polyphony
 * came later, on tape.
 *
 * Nothing in this file touches Web Audio, the DOM, or Node. It is a plain
 * sample-in/sample-out object so the same code runs in an AudioWorklet, in an
 * offline bounce at whatever speed the CPU allows, and in a unit test.
 */

import { ControlLane } from './lane.js';
import { DEFAULT_RELAYS, RelayBank, type RelayOptions } from './neume.js';
import { DEFAULT_ECHO, Echo, type EchoOptions } from './echo.js';
import {
  DEFAULT_PLATE,
  PlateReverb,
  reverbOptions,
  type PlateOptions,
  type ReverbSpace,
} from './reverb.js';
import { DEFAULT_SCANNER_OPTS, FlyingSpotScanner, type ScannerOptions } from './scanner.js';
import { Slide } from './slide.js';
import { DEFAULT_VACTROL, DirectGain, Vactrol, type AmplitudeStage, type VactrolOptions } from './vactrol.js';
import { Wavetable } from './wavetable.js';

export const TIMBRE_COUNT = 4;

/**
 * The legible fallback scale: four octaves, A1 to A5, logarithmic. Only used
 * when `linearPitchScale` is off — the machine itself had no such thing.
 */
export const PITCH_RANGE = { minHz: 55, maxHz: 880 } as const;

/**
 * Top of the linear pitch lane, in Hz.
 *
 * The strips reach 9999 Hz, but a lane scaled to that puts everything musical
 * in the bottom tenth and is unusable to draw on. A thousand is the natural
 * stopping point: it is three of the four decades, and A5 at 880 Hz sits near
 * the top of the sheet.
 */
export const PITCH_LANE_MAX_HZ = 1000;

/**
 * How a drawing becomes a pitch.
 *
 *   hertz  one lane, height is the frequency in Hz. What the painted code meant
 *          on the original machine, and hard to draw a tune on.
 *   notes  two lanes, a note in twelve rows and an octave in eight below it,
 *          added in semitones and turned into Hertz once. The shape of Oram's
 *          1976 design, and what Richards built.
 *
 * Only the reading changes. The relays, the servo and everything else that
 * makes it sound like the machine are the same in both.
 */
/**
 * Slowest the transport strip will run the heads, as a fraction of normal.
 *
 * The clutch on the machine could stop the film dead, and a line drawn at the
 * bottom rail did exactly that: the piece froze, with no way back until the
 * line came up again. A sheet is thirty seconds long and a workshop is an
 * afternoon, so the bottom rail crawls instead. Slow enough to hear as a halt,
 * fast enough that the piece always comes out the other side.
 */
export const TRANSPORT_MIN_RATE = 0.1;

export type PitchMode = 'hertz' | 'notes';

/**
 * What the vibrato strip drives.
 *
 * `vibrato` is strip 8 as built: height bends the pitch either side of the
 * centre line. `delay` hands the same line to an echo instead, where height is
 * the delay time. One line, two jobs, one at a time.
 */
export type VibratoMode = 'vibrato' | 'delay';

/** Rows in the note lane, C at the bottom. */
export const NOTE_ROWS = 12;
/** Rows in the octave lane, bottom first. */
export const OCTAVE_ROWS = 8;
/** The octave the bottom row of the octave lane spells: C1 is 32.7 Hz. */
export const LOWEST_OCTAVE = 1;
/**
 * Where an unmarked octave lane sits: octave 4, so a note drawn with no
 * octave at all plays around middle C rather than at the bottom of the range.
 */
export const DEFAULT_OCTAVE = 4;

/** The centre of a row, as a lane value. What the app sends for a chosen row. */
export const rowValue = (row: number, rows: number): number => (row + 0.5) / rows;

/** Which row a lane value falls in. */
export const valueRow = (value: number, rows: number): number =>
  Math.max(0, Math.min(rows - 1, Math.floor(Math.max(0, Math.min(1, value)) * rows)));

/** Equal temperament, A440. */
export const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** A note row and an octave row, as a MIDI note number. C4 is 60. */
export const notesToMidi = (noteRow: number, octaveRow: number): number =>
  12 * (octaveRow + LOWEST_OCTAVE + 1) + noteRow;

export interface Fidelity {
  /**
   * Round pitch to a whole number of Hertz. The machine took frequency as
   * three BCD digits, so 100 -> 101 Hz is a 17-cent step down low and a 2-cent
   * step up high. Uneven resolution across the range is the point.
   */
  integerHzPitch: boolean;
  /** Route amplitude through the bulb-and-photoresistor model. */
  opticalAmplitude: boolean;
  /**
   * Sum to mono, as the machine did. Off, each timbre sits where its pan
   * setting puts it and the output is stereo.
   */
  monoSum: boolean;
  /**
   * Read the pitch lane as a linear number of Hertz, which is what the painted
   * code meant. Off gives a logarithmic musical scale — easier to draw a tune
   * on, and an anachronism.
   */
  linearPitchScale: boolean;
  /**
   * Put the pitch through the bank of latching relays, so decimal carries take
   * a few milliseconds and sweep through frequencies nobody painted.
   */
  relayLag: boolean;
  /**
   * Generate timbres by running the flying-spot servo over the painted slide,
   * rather than replaying the curve it would settle on. Off, you get a clean
   * wavetable of the slide's top edge: the same shape with none of the ring,
   * lag, loss of lock or pitch-dependent smearing.
   */
  servoScanner: boolean;
}

export const FAITHFUL: Fidelity = {
  integerHzPitch: true,
  linearPitchScale: true,
  relayLag: true,
  opticalAmplitude: true,
  monoSum: true,
  servoScanner: true,
};

export interface MachineOptions {
  sampleRate: number;
  fidelity?: Partial<Fidelity>;
  vactrol?: VactrolOptions;
  scanner?: ScannerOptions;
  relays?: RelayOptions;
  plate?: PlateOptions;
  echo?: EchoOptions;
  /** Full-scale vibrato deflection, in cents. */
  vibratoDepthCents?: number;
}

/** The vertical slice of a slide one timbre is reading, in -1..1. */
/**
 * Detuned copies of a timbre, reading the same slide.
 *
 * Not something the machine could do: it had one spot per slide. This is here
 * for the supersaw and detune presets, and is off (one voice) unless asked for.
 */
export interface Unison {
  /** Voices in total, the original included. 1 is off. */
  voices: number;
  /** How far the outermost voices sit from the original, either way. */
  cents: number;
}

export const MAX_UNISON_VOICES = 7;

/** How far a timbre can be moved from the note being played, in octaves. */
export const MAX_TIMBRE_OCTAVES = 2;

/**
 * Slip: how far a timbre's own clock wanders, as a fraction of its rate.
 *
 * Four slides driven from one pitch sit exactly on top of each other, which is
 * tidier than any tape machine ever managed. Slip gives each one a clock of its
 * own that drifts: a slow random walk, no faster than a hand moving, so the
 * voices wander apart and back the way four tape loops do. At full it is a few
 * per cent, which is wow rather than detuning.
 */
export const MAX_SLIP = 0.035;

/** How quickly the wander changes direction, in Hertz. */
const SLIP_RATE_HZ = 0.6;

/** The extra voices' tunings: spread evenly across the range, leaving out the one nearest the original. */
export const unisonRatios = ({ voices, cents }: Unison): number[] => {
  const n = Math.max(1, Math.min(MAX_UNISON_VOICES, Math.round(voices)));
  if (n === 1 || cents === 0) return [];
  const offsets = Array.from({ length: n }, (_, k) => -cents + (2 * cents * k) / (n - 1));
  let nearest = 0;
  offsets.forEach((o, k) => {
    if (Math.abs(o) < Math.abs(offsets[nearest]!)) nearest = k;
  });
  offsets.splice(nearest, 1);
  return offsets.map((c) => 2 ** (c / 1200));
};

interface UnisonVoices {
  ratios: Float32Array;
  scanners: FlyingSpotScanner[];
  /** Phases for the wavetable path, which has no scanner to keep one. */
  phases: Float64Array;
  /** Scales the sum so more voices do not simply mean louder. */
  norm: number;
}

export interface ScanWindow {
  low: number;
  high: number;
}

export type LaneName =
  | 'pitch'
  | 'octave'
  | 'vibrato'
  | 'reverb'
  | 'transport'
  | `amp${1 | 2 | 3 | 4}`;

const LANE_NAMES: LaneName[] = [
  'pitch',
  'octave',
  'vibrato',
  'reverb',
  'transport',
  'amp1',
  'amp2',
  'amp3',
  'amp4',
];

export class Machine {
  readonly sampleRate: number;
  readonly lanes: Record<LaneName, ControlLane>;
  readonly fidelity: Fidelity;

  /** Bypass tables, null until the wavetable path actually asks for one. */
  private timbres: (Wavetable | null)[];
  private slides: Slide[];
  /**
   * The slide each timbre was reading before the current one, kept alive with
   * its own scanner so a swap can be crossfaded rather than cut.
   *
   * Blending the two opacity fields instead does not work: where the old and
   * new edges are far apart the blend sits near half opacity, which reads as
   * zero error, and the loop has nothing to track. Crossfading the two outputs
   * is unconditionally smooth because each one is continuous on its own.
   */
  private previousSlides: Slide[];
  private previousScanners: FlyingSpotScanner[];
  /** Samples of crossfade remaining, per timbre. */
  private fadeLeft: Int32Array;
  private readonly fadeSamples: number;
  private scanners: FlyingSpotScanner[];
  private windows: ScanWindow[];
  private unison: UnisonVoices[];
  /**
   * A timbre's own tuning, as a frequency ratio.
   *
   * The machine had one pitch for the whole voice: four slides, one note. This
   * lets a timbre sit an octave or two off it, which is four oscillators on one
   * strip rather than one. Not the machine, and useful.
   */
  private octaveRatio = new Float32Array(TIMBRE_COUNT).fill(1);
  /**
   * A phase per timbre, for the wavetable path.
   *
   * That path takes its pitch from how fast the phase turns rather than from
   * the frequency handed to it, so one shared phase meant every timbre sounded
   * at the note however it was tuned.
   */
  private timbrePhase = new Float64Array(TIMBRE_COUNT);
  /** Slip per timbre: how much, where the wander is now, and where it is heading. */
  private slip = new Float32Array(TIMBRE_COUNT);
  private slipAt = new Float32Array(TIMBRE_COUNT);
  private slipTo = new Float32Array(TIMBRE_COUNT);
  private slipLeft = new Float32Array(TIMBRE_COUNT);
  private slipSpan = new Float32Array(TIMBRE_COUNT).fill(1);
  private scannerOpts: ScannerOptions;
  private amps: AmplitudeStage[];
  /**
   * DC blocker state. The scanner's output is a deflection voltage, and it
   * rests hard against a rail whenever the loop has nothing to track — an empty
   * carrier, or a long gap in the paint. The real machine was AC-coupled into
   * the mixer, so that read as silence rather than a full-scale offset.
   */
  private dcX = 0;
  private dcY = 0;
  /** The right channel's blocker, used only in stereo. */
  private dcXR = 0;
  private dcYR = 0;
  /** Per-timbre channel gains from the pan settings. 1 and 1 at the centre. */
  private panL = new Float32Array(TIMBRE_COUNT).fill(1);
  private panR = new Float32Array(TIMBRE_COUNT).fill(1);
  private readonly dcR: number;
  private readonly relays: RelayBank;
  private mode: PitchMode = 'hertz';
  private plate: PlateReverb;
  private reverbSpace: ReverbSpace = 'plate';
  private readonly echo: Echo;
  private vibratoMode: VibratoMode = 'vibrato';
  /**
   * Paused: the heads stop and nothing new is sounded, but the plate, the echo
   * and the light bulbs carry on as they would. Stopping a tape leaves the room
   * ringing; only pulling the plug does not.
   */
  private paused = false;
  /** Scratch for the echo's two channels, so the render loop allocates nothing. */
  private readonly echoOut: [number, number] = [0, 0];
  /**
   * Flat arrays of the same lanes the record holds. `for...of` over a record's
   * keys allocates an iterator every sample, which is exactly the kind of
   * garbage that turns into a click on the audio thread.
   */
  private allLanes: ControlLane[];
  private ampLanes: ControlLane[];
  private phase = 0;
  private vibratoDepthCents: number;
  private vactrolOpts: VactrolOptions;

  /** Most recent values, for the UI. Not used by the DSP. */
  readonly meters = {
    hz: 0,
    /** The pitch the sheet asks for, before relay lag and vibrato. */
    targetHz: 0,
    gains: new Float32Array(TIMBRE_COUNT),
  };

  constructor(opts: MachineOptions) {
    this.sampleRate = opts.sampleRate;
    this.fidelity = { ...FAITHFUL, ...opts.fidelity };
    this.vactrolOpts = opts.vactrol ?? DEFAULT_VACTROL;
    this.vibratoDepthCents = opts.vibratoDepthCents ?? 50;
    // One-pole DC blocker at roughly 10 Hz.
    this.dcR = 1 - (2 * Math.PI * 10) / this.sampleRate;
    this.relays = new RelayBank(this.sampleRate, opts.relays ?? DEFAULT_RELAYS);
    this.plate = new PlateReverb(this.sampleRate, opts.plate ?? DEFAULT_PLATE);
    this.echo = new Echo(this.sampleRate, opts.echo ?? DEFAULT_ECHO);

    this.lanes = Object.fromEntries(LANE_NAMES.map((n) => [n, new ControlLane()])) as Record<
      LaneName,
      ControlLane
    >;
    // An unloaded pitch lane should sit mid-range, not at 55 Hz; an unloaded
    // amplitude lane should be silent.
    this.lanes.pitch.defaultValue = 0.5;
    this.lanes.vibrato.defaultValue = 0.5;
    this.lanes.transport.defaultValue = 0.5;
    // The pitch relays latch, so a gap in the strip sustains the last frequency
    // rather than dropping to nothing. Everything else rests.
    this.lanes.pitch.gapBehaviour = 'hold';
    this.lanes.transport.gapBehaviour = 'hold';
    // The octave lane is a choice between rows, and it latches like the note.
    this.lanes.octave.gapBehaviour = 'hold';
    this.lanes.octave.interpolate = false;
    this.lanes.octave.defaultValue = rowValue(DEFAULT_OCTAVE - LOWEST_OCTAVE, OCTAVE_ROWS);

    this.allLanes = LANE_NAMES.map((n) => this.lanes[n]);
    this.ampLanes = [this.lanes.amp1, this.lanes.amp2, this.lanes.amp3, this.lanes.amp4];
    this.timbres = Array.from({ length: TIMBRE_COUNT }, () => null);
    // Slides are immutable, so one sine serves all four until they are replaced.
    const defaultSlide = Slide.sine();
    this.slides = Array.from({ length: TIMBRE_COUNT }, () => defaultSlide);
    this.previousSlides = Array.from({ length: TIMBRE_COUNT }, () => defaultSlide);
    this.fadeLeft = new Int32Array(TIMBRE_COUNT);
    // Long enough to hide the handover, short enough that a brush stroke still
    // feels immediate.
    this.fadeSamples = Math.round(this.sampleRate * 0.025);
    this.scanners = Array.from(
      { length: TIMBRE_COUNT },
      () => new FlyingSpotScanner(this.sampleRate, opts.scanner ?? DEFAULT_SCANNER_OPTS),
    );
    this.previousScanners = Array.from(
      { length: TIMBRE_COUNT },
      () => new FlyingSpotScanner(this.sampleRate, opts.scanner ?? DEFAULT_SCANNER_OPTS),
    );
    this.windows = Array.from({ length: TIMBRE_COUNT }, () => ({ low: -1, high: 1 }));
    this.scannerOpts = opts.scanner ?? DEFAULT_SCANNER_OPTS;
    this.unison = Array.from({ length: TIMBRE_COUNT }, () => this.makeUnison([]));
    this.amps = this.makeAmps();
  }

  private makeUnison(ratios: number[]): UnisonVoices {
    return {
      ratios: Float32Array.from(ratios),
      scanners: ratios.map(() => new FlyingSpotScanner(this.sampleRate, this.scannerOpts)),
      phases: new Float64Array(ratios.length),
      norm: 1 / Math.sqrt(ratios.length + 1),
    };
  }

  /**
   * Detuned copies of one timbre. Allocates, so it is for a message handler,
   * not the render loop. New voices start from the original's scanner state so
   * they come in without a jolt.
   */
  setUnison(index: number, unison: Unison): void {
    this.assertTimbre(index);
    const voices = this.makeUnison(unisonRatios(unison));
    for (const s of voices.scanners) s.copyStateFrom(this.scanners[index]!);
    voices.phases.fill(this.phase);
    this.unison[index] = voices;
  }

  private makeAmps(): AmplitudeStage[] {
    return Array.from({ length: TIMBRE_COUNT }, () =>
      this.fidelity.opticalAmplitude
        ? new Vactrol(this.sampleRate, this.vactrolOpts)
        : new DirectGain(),
    );
  }

  setTimbre(index: number, table: Wavetable): void {
    this.assertTimbre(index);
    this.timbres[index] = table;
  }

  /**
   * Install a painted slide.
   *
   * Must stay cheap: this is called on the audio thread every time someone
   * moves the brush. Deriving the wavetable bypass here cost 57 ms a go —
   * twenty times a whole render quantum — and stalled playback while painting.
   * It is built on demand instead, in `wavetableFor`.
   */
  setSlide(index: number, slide: Slide): void {
    this.assertTimbre(index);
    // Hand over to a second loop started from exactly where this one is, so
    // the outgoing sound keeps running while the incoming one settles.
    this.previousSlides[index] = this.slides[index]!;
    this.previousScanners[index]!.copyStateFrom(this.scanners[index]!);
    this.fadeLeft[index] = this.fadeSamples;
    this.slides[index] = slide;
    this.timbres[index] = null;
  }

  /**
   * The bypass table for a slide, built on first use and cached.
   *
   * Derived from the slide's top edge so both paths describe the same painting
   * and the fidelity toggle is a fair comparison, not a swap between unrelated
   * sounds. Only reached when `servoScanner` is off.
   */
  private wavetableFor(index: number): Wavetable {
    let table = this.timbres[index];
    if (!table) {
      table = Wavetable.fromContour(this.slides[index]!.topEdgeContour());
      this.timbres[index] = table;
    }
    return table;
  }

  /** How far this timbre's clock is allowed to wander, 0 to 1. */
  setSlip(index: number, amount: number): void {
    this.assertTimbre(index);
    this.slip[index] = Math.max(0, Math.min(1, amount));
    if (this.slip[index] === 0) {
      this.slipAt[index] = 0;
      this.slipTo[index] = 0;
      this.slipLeft[index] = 0;
    }
  }

  /** Move a timbre up or down, in octaves. Fractions are allowed; the range is not. */
  setTimbreOctave(index: number, octaves: number): void {
    this.assertTimbre(index);
    const clamped = Math.max(-MAX_TIMBRE_OCTAVES, Math.min(MAX_TIMBRE_OCTAVES, octaves));
    this.octaveRatio[index] = 2 ** clamped;
  }

  /** Narrow a timbre to one ribbon of a slide that carries several. */
  setScanWindow(index: number, window: ScanWindow): void {
    this.assertTimbre(index);
    this.windows[index] = window;
  }

  setScannerOptions(opts: ScannerOptions): void {
    this.scannerOpts = opts;
    for (const s of this.scanners) s.setOptions(opts);
    for (const u of this.unison) for (const s of u.scanners) s.setOptions(opts);
  }

  private assertTimbre(index: number): void {
    if (index < 0 || index >= TIMBRE_COUNT) throw new Error(`No timbre ${index}`);
  }

  /** Toggling optical amplitude rebuilds the attenuators, so do it off the audio thread. */
  setFidelity(patch: Partial<Fidelity>): void {
    const wasOptical = this.fidelity.opticalAmplitude;
    Object.assign(this.fidelity, patch);
    if (this.fidelity.opticalAmplitude !== wasOptical) this.amps = this.makeAmps();
  }

  setVibratoDepthCents(cents: number): void {
    this.vibratoDepthCents = cents;
  }

  /**
   * Set every lane's speed at once — the faithful, single-clutch behaviour.
   *
   * Individual lanes can still be set afterwards to run at their own rate; the
   * transport strip scales whatever they end up at.
   */
  setGlobalSpeed(speed: number): void {
    for (const name of LANE_NAMES) this.lanes[name].speed = speed;
  }

  setPlateOptions(opts: PlateOptions): void {
    this.plate.setOptions(opts);
  }

  /**
   * Plate or room. The delay lengths differ, so this builds a new one: the tail
   * of the old space stops rather than turning into the new one, which is what
   * moving the send to another machine would do anyway.
   */
  setReverbSpace(space: ReverbSpace): void {
    if (space === this.reverbSpace) return;
    this.reverbSpace = space;
    this.plate = new PlateReverb(this.sampleRate, reverbOptions(space));
  }

  get space(): ReverbSpace {
    return this.reverbSpace;
  }

  /** Whether the vibrato strip bends the pitch or sets an echo time. */
  setVibratoMode(mode: VibratoMode): void {
    if (mode === this.vibratoMode) return;
    this.vibratoMode = mode;
    this.echo.clear();
  }

  get vibrato(): VibratoMode {
    return this.vibratoMode;
  }

  setEchoOptions(opts: Partial<EchoOptions>): void {
    this.echo.setOptions(opts);
  }

  /** Hold the heads where they are, without cutting what is still sounding. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Everything quiet, now: the tank emptied, the echo wiped, the attenuators
   * closed. The heads stay where they are, since where you were is not what
   * you asked to silence.
   */
  silence(): void {
    this.plate.clear();
    this.echo.clear();
    for (const a of this.amps) a.reset();
    this.dcX = 0;
    this.dcY = 0;
    this.dcXR = 0;
    this.dcYR = 0;
  }

  reset(): void {
    this.phase = 0;
    for (const lane of this.allLanes) lane.reset();
    for (const a of this.amps) a.reset();
    for (const s of this.scanners) s.reset();
    for (const s of this.previousScanners) s.reset();
    for (const u of this.unison) {
      for (const s of u.scanners) s.reset();
      u.phases.fill(0);
    }
    this.timbrePhase.fill(0);
    this.slipAt.fill(0);
    this.slipTo.fill(0);
    this.slipLeft.fill(0);
    this.fadeLeft.fill(0);
    this.relays.reset();
    this.plate.clear();
    this.echo.clear();
    this.dcX = 0;
    this.dcY = 0;
    this.dcXR = 0;
    this.dcYR = 0;
  }

  /**
   * Lane height to frequency.
   *
   * Linear is the authentic reading: the painted code is a decimal number of
   * Hertz, and the resistor bank makes the time-base run at that frequency, so
   * height maps straight onto Hz. Octaves are unevenly spaced as a result —
   * 110 Hz sits at a ninth of the way up and 880 at seven eighths.
   */
  private laneToHz(v: number): number {
    let hz: number;
    if (this.pitchMode === 'notes') {
      // Semitones first and Hertz once. Adding in Hertz, or rounding the note
      // and the octave separately, drifts out of tune in ways nobody can hear
      // the cause of.
      const midi = notesToMidi(
        valueRow(v, NOTE_ROWS),
        valueRow(this.lanes.octave.read(), OCTAVE_ROWS),
      );
      hz = midiToHz(midi);
    } else {
      const clamped = Math.max(0, Math.min(1, v));
      hz = this.fidelity.linearPitchScale
        ? clamped * PITCH_LANE_MAX_HZ
        : PITCH_RANGE.minHz * Math.pow(PITCH_RANGE.maxHz / PITCH_RANGE.minHz, clamped);
    }
    // Whole Hertz in either mode: the relays can only spell whole numbers, so
    // middle C comes out at 262, not 261.63.
    return this.fidelity.integerHzPitch ? Math.round(hz) : hz;
  }

  /** How the pitch lanes are read. See `PitchMode`. */
  get pitchMode(): PitchMode {
    return this.mode;
  }

  setPitchMode(mode: PitchMode): void {
    this.mode = mode;
    const pitch = this.lanes.pitch;
    // A note is a choice between rows and must step between them; a Hertz line
    // is a contour and should glide.
    pitch.interpolate = mode === 'hertz';
    pitch.defaultValue = mode === 'notes' ? rowValue(0, NOTE_ROWS) : 0.5;
  }

  /**
   * Where a timbre sits, -1 hard left to 1 hard right. Not something the
   * machine had: it only takes effect with `monoSum` off.
   *
   * Equal power, scaled so the centre is unity in both channels. A centred
   * timbre then sounds exactly as it does in mono, and moving it to one side
   * does not make it quieter overall.
   */
  setPan(index: number, pan: number): void {
    this.assertTimbre(index);
    const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
    this.panL[index] = Math.SQRT2 * Math.cos(angle);
    this.panR[index] = Math.SQRT2 * Math.sin(angle);
  }

  /**
   * Render `frames` samples into `out`, and into `right` as well for stereo.
   * With `monoSum` on, or no `right`, both get the same mono mix. This is the
   * only method the worklet calls, and it must not allocate.
   */
  render(out: Float32Array, frames: number, right?: Float32Array): void {
    const stereo = right !== undefined && !this.fidelity.monoSum;
    const panL = this.panL;
    const panR = this.panR;
    const dt = 1 / this.sampleRate;
    const { pitch, vibrato } = this.lanes;
    const ampLanes = this.ampLanes;
    const allLanes = this.allLanes;

    for (let i = 0; i < frames; i++) {
      let baseHz = this.laneToHz(pitch.read());
      this.meters.targetHz = baseHz;
      if (this.fidelity.relayLag) {
        // The photocells aim the bank; the bank reports what the resistors
        // currently spell, which lags and overshoots through a carry.
        this.relays.setTargetHz(baseHz);
        baseHz = this.relays.step();
      }
      // Vibrato is bipolar about the sheet's centre line. In delay mode the
      // same line means a time instead, and the pitch is left alone.
      const line = vibrato.read();
      const bend = this.vibratoMode === 'vibrato' ? (line - 0.5) * 2 * this.vibratoDepthCents : 0;
      const hz = bend === 0 ? baseHz : baseHz * Math.pow(2, bend / 1200);

      let sum = 0;
      let sumL = 0;
      let sumR = 0;
      for (let t = 0; t < TIMBRE_COUNT; t++) {
        let voice = 0;
        // Paused, the strips are not driving anything: the attenuators close at
        // their own pace, which is what makes a pause fade rather than cut.
        const level = this.paused ? 0 : ampLanes[t]!.read();
        /*
         * Where this timbre sits against the note the strips are playing, and
         * how far its own clock has wandered. The wander is a walk between
         * randomly chosen points rather than noise, so it drifts rather than
         * shivers.
         */
        if (this.slip[t]! > 0) {
          if (this.slipLeft[t]! <= 0) {
            this.slipAt[t] = this.slipTo[t]!;
            this.slipTo[t] = (Math.random() * 2 - 1) * this.slip[t]! * MAX_SLIP;
            this.slipLeft[t] = this.sampleRate / SLIP_RATE_HZ;
            this.slipSpan[t] = this.slipLeft[t]!;
          }
          this.slipLeft[t]!--;
        }
        const wander =
          this.slip[t]! > 0
            ? this.slipAt[t]! +
              (this.slipTo[t]! - this.slipAt[t]!) *
                (1 - this.slipLeft[t]! / this.slipSpan[t]!)
            : 0;
        const voiceHz = hz * this.octaveRatio[t]! * (1 + wander);
        const gain = this.amps[t]!.process(level);
        this.meters.gains[t] = gain;

        if (this.fidelity.servoScanner) {
          // The loop must keep running even while the voice is silent: its
          // state carries across cycles, so skipping it would make a note's
          // timbre depend on how long the previous silence was.
          const w = this.windows[t]!;
          const slide = this.slides[t]!;
          let spot = this.scanners[t]!.step(slide, voiceHz, w.low, w.high);
          if (this.fadeLeft[t]! > 0) {
            const outgoing = this.previousScanners[t]!.step(
              this.previousSlides[t]!,
              voiceHz,
              w.low,
              w.high,
            );
            this.fadeLeft[t]!--;
            const mix = 1 - this.fadeLeft[t]! / this.fadeSamples;
            spot = outgoing + (spot - outgoing) * mix;
          }
          const u = this.unison[t]!;
          if (u.ratios.length > 0) {
            // Stepped even when silent, like the original, for the same reason.
            let voices = spot;
            for (let k = 0; k < u.ratios.length; k++) {
              voices += u.scanners[k]!.step(this.slides[t]!, voiceHz * u.ratios[k]!, w.low, w.high);
            }
            spot = voices * u.norm;
          }
          // Clear glass is silence, not a rail held at full deflection.
          if (gain > 0 && slide.painted) voice = spot * gain;
        } else {
          const u = this.unison[t]!;
          if (gain > 0) {
            const table = this.wavetableFor(t);
            let voices = table.sample(this.timbrePhase[t]!, voiceHz, this.sampleRate);
            for (let k = 0; k < u.ratios.length; k++) {
              voices += table.sample(u.phases[k]!, voiceHz * u.ratios[k]!, this.sampleRate);
            }
            voice = (u.ratios.length > 0 ? voices * u.norm : voices) * gain;
          }
          for (let k = 0; k < u.ratios.length; k++) {
            const p = u.phases[k]! + (voiceHz * u.ratios[k]!) / this.sampleRate;
            u.phases[k] = p - Math.floor(p);
          }
          const turned = this.timbrePhase[t]! + voiceHz / this.sampleRate;
          this.timbrePhase[t] = turned - Math.floor(turned);
        }
        sum += voice;
        sumL += voice * panL[t]!;
        sumR += voice * panR[t]!;
      }

      this.phase += hz / this.sampleRate;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);

      let mixed = sum / TIMBRE_COUNT;
      let echoL = 0;
      let echoR = 0;
      if (this.vibratoMode === 'delay') {
        // In front of the reverb send, so the echoes go to the plate too.
        this.echo.process(
          stereo ? sumL / TIMBRE_COUNT : mixed,
          stereo ? sumR / TIMBRE_COUNT : mixed,
          line,
          this.echoOut,
        );
        echoL = this.echoOut[0];
        echoR = this.echoOut[1];
        mixed += (echoL + echoR) / 2;
      }
      // Strip 9 sets how much of the whole four-timbre mix reaches the plate.
      // Always run the tank: muting it would cut the tail the moment the send
      // came down, and a tail outlasting the line that made it is the point.
      // The plate is fed the mono mix and returns to both sides equally, as a
      // single plate on a stereo desk would.
      const wet = this.plate.process(mixed * this.lanes.reverb.read());
      if (stereo) {
        const l = sumL / TIMBRE_COUNT + echoL + wet;
        const r = sumR / TIMBRE_COUNT + echoR + wet;
        this.dcY = l - this.dcX + this.dcR * this.dcY;
        this.dcX = l;
        this.dcYR = r - this.dcXR + this.dcR * this.dcYR;
        this.dcXR = r;
        out[i] = this.dcY;
        right[i] = this.dcYR;
      } else {
        mixed += wet;
        this.dcY = mixed - this.dcX + this.dcR * this.dcY;
        this.dcX = mixed;
        out[i] = this.dcY;
        if (right) right[i] = this.dcY;
      }
      this.meters.hz = hz;

      // Strip 10 drives the clutch. The centre line is normal speed, the top
      // rail double, the bottom a dead stop — and since the transport strip is
      // itself read by a head, it warps its own time axis as it goes.
      //
      // Applied to the time step, not written onto each lane's speed: that
      // field is the per-lane multiplier, and overwriting it destroyed the
      // ability to run heads at different rates.
      // Strip 10 drives the clutch, always: a blank strip rests at the centre
      // line, which is normal speed, so there is nothing to switch off.
      const drive = Math.max(TRANSPORT_MIN_RATE, this.lanes.transport.read() * 2);
      const step = this.paused ? 0 : dt * drive;
      for (let l = 0; l < allLanes.length; l++) allLanes[l]!.advance(step);
    }
  }

  /**
   * Render `seconds` of audio as fast as the CPU allows. Same code path as the
   * worklet, which is the whole reason the engine has no platform dependencies.
   */
  bounce(seconds: number, blockSize = 128): Float32Array {
    const total = Math.ceil(seconds * this.sampleRate);
    const out = new Float32Array(total);
    const block = new Float32Array(blockSize);
    for (let i = 0; i < total; i += blockSize) {
      const n = Math.min(blockSize, total - i);
      this.render(block, n);
      out.set(block.subarray(0, n), i);
    }
    return out;
  }
}
