import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ControlLane } from './lane.js';
import {
  LOWEST_OCTAVE,
  Machine,
  NOTE_ROWS,
  OCTAVE_ROWS,
  PITCH_RANGE,
  TIMBRE_COUNT,
  TRANSPORT_MIN_RATE,
  rowValue,
  unisonRatios,
} from './machine.js';
import { echoSeconds } from './echo.js';
import { Slide } from './slide.js';
import { DEFAULT_VACTROL, DirectGain, Vactrol } from './vactrol.js';
import { TABLE_SIZE, Wavetable } from './wavetable.js';

const SR = 48_000;

/** A lane holding one value for its whole length. */
const constant = (v: number, n = 128): Float32Array => new Float32Array(n).fill(v);

const loadConstant = (lane: ControlLane, v: number, durationS = 30): void => {
  lane.load(constant(v), durationS);
};

/** Frequency by counting rising zero crossings. */
const measureHz = (buf: Float32Array, sampleRate: number): number => {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1]! < 0 && buf[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  if (crossings < 2) return 0;
  return ((crossings - 1) * sampleRate) / (last - first);
};

const peak = (buf: Float32Array): number => {
  let m = 0;
  for (const v of buf) m = Math.max(m, Math.abs(v));
  return m;
};

const openVoice = (m: Machine, timbres = 1): void => {
  loadConstant(m.lanes.pitch, 0.5);
  for (let i = 1; i <= timbres; i++) {
    loadConstant(m.lanes[`amp${i as 1 | 2 | 3 | 4}`], 1);
  }
};

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

test('a lane interpolates between its samples', () => {
  const lane = new ControlLane();
  lane.load(Float32Array.from([0, 1]), 1);
  lane.position = 0.5;
  assert.ok(Math.abs(lane.read() - 0.5) < 1e-6);
});

test('an undrawn stretch rests or holds, depending on the lane', () => {
  // Blank means "nothing drawn here", not "drawn at zero" — a scanned sheet is
  // mostly blank paper.
  const values = Float32Array.from([1, 1, Number.NaN, Number.NaN, 0.25, 0.25]);

  const resting = new ControlLane();
  resting.defaultValue = 0;
  resting.load(values, 6);
  resting.position = 2.5;
  assert.equal(resting.read(), 0, 'an amplitude lane should fall silent in a gap');

  const holding = new ControlLane();
  holding.gapBehaviour = 'hold';
  holding.load(values, 6);
  holding.position = 0.5;
  holding.read(); // pick up the drawn value
  holding.position = 2.5;
  assert.equal(holding.read(), 1, 'the pitch relays latch, so the gap should sustain');
});

test('a gap is not bridged by interpolation', () => {
  // Ramping into and out of a blank would invent a line nobody drew.
  const lane = new ControlLane();
  lane.load(Float32Array.from([1, Number.NaN, 0]), 3);
  lane.defaultValue = 0.5;
  lane.position = 1.5; // squarely inside the gap
  assert.equal(lane.read(), 0.5);
});

test('a fully blank lane is silent rather than NaN', () => {
  const m = new Machine({ sampleRate: SR });
  m.lanes.amp1.load(new Float32Array(64).fill(Number.NaN), 30);
  loadConstant(m.lanes.pitch, 0.5);
  const buf = m.bounce(0.2);
  for (const v of buf) assert.ok(Number.isFinite(v), 'blank lane produced a non-finite sample');
  assert.equal(peak(buf), 0, 'nothing drawn should mean nothing heard');
});

test('an unloaded lane returns its default and never NaN', () => {
  const lane = new ControlLane();
  lane.defaultValue = 0.5;
  assert.equal(lane.read(), 0.5);
  lane.advance(1 / SR);
  assert.equal(lane.read(), 0.5);
});

test('a looping lane wraps in both directions', () => {
  const lane = new ControlLane();
  lane.load(constant(1), 2);
  lane.position = 1.5;
  lane.speed = 1;
  lane.advance(1);
  assert.ok(lane.position >= 0 && lane.position < 2, `wrapped to ${lane.position}`);

  lane.position = 0.1;
  lane.speed = -1;
  lane.advance(1);
  assert.ok(lane.position >= 0 && lane.position < 2, `reverse wrapped to ${lane.position}`);
});

test('lanes can run at independent speeds', () => {
  const m = new Machine({ sampleRate: SR });
  openVoice(m);
  m.setGlobalSpeed(1);
  m.lanes.amp1.speed = 2;
  m.render(new Float32Array(SR), SR);
  assert.ok(
    Math.abs(m.lanes.amp1.position - m.lanes.pitch.position * 2) < 1e-3,
    'the faster lane should be exactly twice as far along',
  );
});

test('rejects an empty or zero-length sheet rather than producing silence', () => {
  const lane = new ControlLane();
  assert.throws(() => lane.load(new Float32Array(0), 30), /empty/);
  assert.throws(() => lane.load(constant(1), 0), /bad duration/);
});

// ---------------------------------------------------------------------------
// Optical amplitude
// ---------------------------------------------------------------------------

test('the vactrol lags on attack instead of opening instantly', () => {
  const v = new Vactrol(SR);
  // One sample of full drive must not produce full gain.
  assert.ok(v.process(1) < 0.01, 'optical control cannot open in one sample');

  let samples = 1;
  while (v.process(1) < 0.5 && samples < SR) samples++;
  const ms = (samples / SR) * 1000;
  assert.ok(ms > 3 && ms < 80, `-6 dB reached in ${ms.toFixed(1)} ms, expected tens of ms`);
});

test('the vactrol releases far slower than it attacks', () => {
  // Compare the *same* gain span in each direction. Timing "reaches -6 dB"
  // against "falls below -6 dB" measures the log taper, not the time
  // constants, and the taper is steep near the top of the range.
  const LOW = 0.01; // -40 dB
  const HIGH = 0.5; // -6 dB
  const v = new Vactrol(SR);

  let up = 0;
  while (v.process(1) < LOW && up < SR) up++;
  let attack = 0;
  while (v.process(1) < HIGH && attack < SR) attack++;

  for (let i = 0; i < SR; i++) v.process(1); // settle at full
  while (v.process(0) > HIGH) {
    /* fall into the measured window */
  }
  let release = 0;
  while (v.process(0) > LOW && release < SR * 10) release++;

  assert.ok(
    release > attack * 3,
    `-40 to -6 dB took ${attack} samples up but only ${release} down; ` +
      `the cell should recover much more slowly than it responds`,
  );
});

test('the direct gain bypass is instantaneous', () => {
  const d = new DirectGain();
  assert.equal(d.process(1), 1);
  assert.equal(d.process(0), 0);
});

test('the vactrol spans its full range and reaches true silence', () => {
  const v = new Vactrol(SR, DEFAULT_VACTROL);
  for (let i = 0; i < SR; i++) v.process(1);
  assert.ok(v.peek() > 0.99, `full drive should reach unity, got ${v.peek()}`);
  for (let i = 0; i < SR * 4; i++) v.process(0);
  assert.equal(v.peek(), 0, 'zero drive must reach digital silence, not a floor');
});

// ---------------------------------------------------------------------------
// Drawn wavetables
// ---------------------------------------------------------------------------

test('a drawn sine survives the scanner recognisably', () => {
  const contour = new Float32Array(512);
  for (let i = 0; i < 512; i++) contour[i] = Math.sin((2 * Math.PI * i) / 512);
  const wt = Wavetable.fromContour(contour);

  let worst = 0;
  for (let i = 0; i < 256; i++) {
    const phase = i / 256;
    worst = Math.max(worst, Math.abs(wt.sample(phase, 220, SR) - Math.sin(2 * Math.PI * phase)));
  }
  assert.ok(worst < 0.2, `scanner distorted a sine by ${worst.toFixed(3)}`);
});

test('the scanner cannot follow a vertical edge', () => {
  // A drawn square wave: the real machine rounds and overshoots the corners.
  const contour = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) contour[i] = i < TABLE_SIZE / 2 ? 1 : -1;
  const wt = Wavetable.fromContour(contour);
  const raw = wt.levels[0]!;

  let maxStep = 0;
  for (let i = 1; i < raw.length; i++) maxStep = Math.max(maxStep, Math.abs(raw[i]! - raw[i - 1]!));
  assert.ok(maxStep < 2, `edge passed through at full slope (${maxStep}); slew did nothing`);
  assert.ok(maxStep > 0, 'the edge vanished entirely');
});

test('high notes select a band-limited mip level', () => {
  const contour = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) contour[i] = i < TABLE_SIZE / 2 ? 1 : -1;
  const wt = Wavetable.fromContour(contour);
  assert.ok(wt.levels.length > 1, 'no mip pyramid was built');

  const harmonicsAt = (hz: number): number => {
    // Reconstruct which level sample() would pick.
    const maxHarmonic = SR / 2 / hz;
    return Math.max(
      0,
      Math.min(wt.levels.length - 1, Math.floor(Math.log2(TABLE_SIZE / 2 / maxHarmonic))),
    );
  };
  assert.ok(
    harmonicsAt(1760) > harmonicsAt(110),
    'a high note must fall back to a more heavily filtered table',
  );
});

// ---------------------------------------------------------------------------
// The voice
// ---------------------------------------------------------------------------

test('an open voice makes sound and a closed one makes none', () => {
  const m = new Machine({ sampleRate: SR });
  const silence = m.bounce(0.2);
  assert.equal(peak(silence), 0, 'no amplitude sheet loaded should mean silence');

  openVoice(m);
  m.reset();
  assert.ok(peak(m.bounce(0.5)) > 0.05, 'an open amplitude lane should produce audio');
});

test('the render never emits NaN or leaves the rails', () => {
  const m = new Machine({ sampleRate: SR });
  openVoice(m, TIMBRE_COUNT);
  loadConstant(m.lanes.vibrato, 1);
  const buf = m.bounce(0.5);
  for (const v of buf) {
    assert.ok(Number.isFinite(v), 'non-finite sample');
    assert.ok(Math.abs(v) <= 1.5, `sample ${v} well outside the rails`);
  }
});

test('pitch lands on whole Hertz when the machine is being faithful', () => {
  for (const v of [0.13, 0.5, 0.77, 0.91]) {
    const m = new Machine({ sampleRate: SR });
    openVoice(m);
    loadConstant(m.lanes.pitch, v);
    m.bounce(0.05);
    assert.equal(m.meters.hz, Math.round(m.meters.hz), `${m.meters.hz} Hz is not an integer`);
  }
});

test('turning off integer-Hz gives back the fractional frequencies', () => {
  // Relay lag has to be off to see this: the relay bank spells a whole number
  // of Hertz by construction, so while it is engaged it quantises the pitch no
  // matter what this flag says. The relays *are* the quantiser.
  const m = new Machine({
    sampleRate: SR,
    fidelity: { integerHzPitch: false, relayLag: false },
  });
  openVoice(m);
  loadConstant(m.lanes.pitch, 0.37);
  m.bounce(0.05);
  assert.notEqual(m.meters.hz, Math.round(m.meters.hz));
});

test('the relay bank quantises pitch even with integer-Hz off', () => {
  const m = new Machine({
    sampleRate: SR,
    fidelity: { integerHzPitch: false, relayLag: true },
  });
  openVoice(m);
  loadConstant(m.lanes.pitch, 0.37);
  m.bounce(0.2);
  assert.equal(m.meters.hz, Math.round(m.meters.hz));
});

test('the rendered audio really is at the frequency the meter claims', () => {
  const m = new Machine({ sampleRate: SR });
  openVoice(m);
  loadConstant(m.lanes.pitch, 0.5);
  m.bounce(0.5); // let the optical attenuator open first
  const buf = m.bounce(1);
  const measured = measureHz(buf, SR);
  assert.ok(
    Math.abs(measured - m.meters.hz) / m.meters.hz < 0.02,
    `meter says ${m.meters.hz} Hz, audio measures ${measured.toFixed(1)} Hz`,
  );
});

test('the log fallback still spans A1 to A5', () => {
  // Not the default any more — the machine's own scale is linear in Hz — but
  // the musically legible option has to keep working.
  const m = new Machine({
    sampleRate: SR,
    fidelity: { integerHzPitch: false, linearPitchScale: false, relayLag: false },
  });
  openVoice(m);

  loadConstant(m.lanes.pitch, 0);
  m.bounce(0.02);
  assert.ok(Math.abs(m.meters.hz - PITCH_RANGE.minHz) < 0.01, `bottom rail gave ${m.meters.hz}`);

  loadConstant(m.lanes.pitch, 1);
  m.bounce(0.02);
  assert.ok(Math.abs(m.meters.hz - PITCH_RANGE.maxHz) < 0.01, `top rail gave ${m.meters.hz}`);
});

test('vibrato bends pitch either side of the centre line', () => {
  const read = (vib: number): number => {
    const m = new Machine({
      sampleRate: SR,
      fidelity: { integerHzPitch: false },
      vibratoDepthCents: 100,
    });
    openVoice(m);
    loadConstant(m.lanes.pitch, 0.5);
    loadConstant(m.lanes.vibrato, vib);
    m.bounce(0.02);
    return m.meters.hz;
  };
  const centre = read(0.5);
  assert.ok(read(1) > centre * 1.05, 'the top rail should bend up a semitone');
  assert.ok(read(0) < centre * 0.95, 'the bottom rail should bend down a semitone');
});

test('a bounce is deterministic', () => {
  const make = (): Machine => {
    const m = new Machine({ sampleRate: SR });
    openVoice(m, 2);
    return m;
  };
  assert.deepEqual(make().bounce(0.1), make().bounce(0.1));
});

test('block size does not change the output', () => {
  // The worklet renders in 128s and the offline bounce is free to use anything;
  // they must agree sample for sample or bounces will not match what was heard.
  const make = (): Machine => {
    const m = new Machine({ sampleRate: SR });
    openVoice(m, 2);
    return m;
  };
  const a = make().bounce(0.1, 128);
  const b = make().bounce(0.1, 977);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  assert.ok(worst < 1e-9, `block size changed the render by ${worst}`);
});

test('an empty slide carrier is silent, not a full-scale DC offset', () => {
  // The scanner parks hard against a rail when there is nothing to track. That
  // is a deflection voltage, not a signal, and the machine was AC-coupled.
  const m = new Machine({ sampleRate: SR });
  for (let i = 0; i < TIMBRE_COUNT; i++) m.setSlide(i, Slide.blank());
  openVoice(m, TIMBRE_COUNT);
  m.bounce(0.4); // let the DC blocker settle after the initial step
  assert.ok(peak(m.bounce(0.3)) < 0.01, 'a blank slide should read as silence');
});

test('the servo scanner and the wavetable bypass describe the same slide', () => {
  // Both paths must track the same pitch — the toggle changes character, not
  // the note. Compare at a low frequency, where the loop keeps up.
  const slide = Slide.sine();
  const render = (servo: boolean): Float32Array => {
    const m = new Machine({ sampleRate: SR, fidelity: { servoScanner: servo } });
    m.setSlide(0, slide);
    openVoice(m);
    loadConstant(m.lanes.pitch, 0.25);
    m.bounce(0.6);
    return m.bounce(1);
  };
  const a = measureHz(render(true), SR);
  const b = measureHz(render(false), SR);
  assert.ok(a > 0 && b > 0, `one path produced no tone: servo ${a}, table ${b}`);
  assert.ok(
    Math.abs(a - b) / b < 0.05,
    `servo ${a.toFixed(1)} Hz and wavetable ${b.toFixed(1)} Hz should agree on pitch`,
  );
});

test('only the servo path makes timbre depend on pitch', () => {
  // The wavetable replays the same cycle at any frequency. The servo has a
  // fixed bandwidth, so the shape it manages to trace changes with the note —
  // the thing a table fundamentally cannot do.
  //
  // The slide needs detail finer than the fundamental for this to show: a plain
  // sine at 800 Hz is still well inside a 2600 Hz loop, and tracking it
  // faithfully is the correct answer. A stroke with a seventh-harmonic wiggle
  // demands ~6 kHz up high, which the loop cannot follow.
  const detailed = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const t = i / 512;
    detailed[i] = 0.62 * Math.sin(2 * Math.PI * t) + 0.34 * Math.sin(2 * Math.PI * 7 * t);
  }
  const slide = Slide.fromContour(detailed);
  /**
   * Path length per cycle, normalised by amplitude. A pure sine traces 4A per
   * cycle whatever its frequency, so this lands near 1 for a sine and climbs
   * with harmonic content — and, unlike peak amplitude or a raw derivative, it
   * does not move just because the note changed.
   */
  const shapeAt = (servo: boolean, laneValue: number): number => {
    const m = new Machine({ sampleRate: SR, fidelity: { servoScanner: servo } });
    m.setSlide(0, slide);
    openVoice(m);
    loadConstant(m.lanes.pitch, laneValue);
    m.bounce(0.6);
    const buf = m.bounce(0.3);

    let pathLength = 0;
    for (let i = 1; i < buf.length; i++) pathLength += Math.abs(buf[i]! - buf[i - 1]!);
    const cycles = (buf.length * m.meters.hz) / SR;
    return pathLength / cycles / (4 * peak(buf));
  };

  const tableLow = shapeAt(false, 0.1);
  const tableHigh = shapeAt(false, 0.95);
  const servoLow = shapeAt(true, 0.1);
  const servoHigh = shapeAt(true, 0.95);

  assert.ok(
    Math.abs(tableHigh - tableLow) / tableLow < 0.2,
    `the wavetable should be pitch-invariant: ${tableLow.toFixed(3)} vs ${tableHigh.toFixed(3)}`,
  );
  assert.ok(
    servoHigh < servoLow * 0.85,
    `the servo should smooth the detail up high: ${servoLow.toFixed(3)} vs ${servoHigh.toFixed(3)}`,
  );
});

test('switching optical amplitude off changes the envelope, not the pitch', () => {
  const attackPeak = (optical: boolean): number => {
    const m = new Machine({ sampleRate: SR, fidelity: { opticalAmplitude: optical } });
    openVoice(m);
    return peak(m.bounce(0.005));
  };
  assert.ok(
    attackPeak(false) > attackPeak(true) * 2,
    'the bypass should reach full level far sooner than the bulb and cell can',
  );
});

// --- note and octave ---------------------------------------------------------

test('a note and an octave spell the pitch they name', () => {
  // A4 is row 9 in octave 4, and the relays round it to whole Hertz like any
  // other pitch.
  const m = new Machine({ sampleRate: SR, fidelity: { relayLag: false } });
  m.setPitchMode('notes');
  openVoice(m);
  loadConstant(m.lanes.pitch, rowValue(9, NOTE_ROWS));
  loadConstant(m.lanes.octave, rowValue(4 - LOWEST_OCTAVE, OCTAVE_ROWS));
  m.bounce(0.05);
  assert.equal(m.meters.hz, 440);

  // Middle C, which the machine can only spell as 262.
  loadConstant(m.lanes.pitch, rowValue(0, NOTE_ROWS));
  m.bounce(0.05);
  assert.equal(m.meters.hz, 262);
});

test('a note with no octave drawn plays around middle C', () => {
  const m = new Machine({ sampleRate: SR, fidelity: { relayLag: false } });
  m.setPitchMode('notes');
  openVoice(m);
  loadConstant(m.lanes.pitch, rowValue(9, NOTE_ROWS));
  m.bounce(0.05);
  assert.equal(m.meters.hz, 440, 'an untouched octave lane should read as octave 4');
});

test('octaves are exactly an octave apart', () => {
  const at = (octaveRow: number): number => {
    const m = new Machine({ sampleRate: SR, fidelity: { relayLag: false, integerHzPitch: false } });
    m.setPitchMode('notes');
    openVoice(m);
    loadConstant(m.lanes.pitch, rowValue(9, NOTE_ROWS));
    loadConstant(m.lanes.octave, rowValue(octaveRow, OCTAVE_ROWS));
    m.bounce(0.05);
    return m.meters.hz;
  };
  for (let row = 0; row < OCTAVE_ROWS - 1; row++) {
    assert.ok(Math.abs(at(row + 1) / at(row) - 2) < 1e-6, `row ${row} to ${row + 1}`);
  }
});

test('a note steps to the next without sounding the ones between', () => {
  /*
   * Lanes interpolate between samples, which is right for a contour and wrong
   * for a choice: stepping from E to A would pass through F, F# and G for a few
   * milliseconds each. Nobody wrote those notes, so a note lane steps.
   */
  const m = new Machine({ sampleRate: SR, fidelity: { relayLag: false, integerHzPitch: false } });
  m.setPitchMode('notes');
  openVoice(m);
  const lane = new Float32Array(2);
  lane[0] = rowValue(4, NOTE_ROWS); // E
  lane[1] = rowValue(9, NOTE_ROWS); // A
  m.lanes.pitch.load(lane, 1);

  const heard = new Set<number>();
  for (let i = 0; i < 100; i++) {
    m.bounce(0.01);
    heard.add(Math.round(12 * Math.log2(m.meters.hz / 440) + 69));
  }
  for (const midi of heard) {
    assert.ok(midi === 64 || midi === 69, `sounded MIDI ${midi}, which is between the two notes`);
  }
});

test('the Hertz mode is untouched by all this', () => {
  const m = new Machine({ sampleRate: SR, fidelity: { relayLag: false } });
  openVoice(m);
  loadConstant(m.lanes.pitch, 0.44);
  loadConstant(m.lanes.octave, rowValue(7, OCTAVE_ROWS));
  m.bounce(0.05);
  assert.equal(m.meters.hz, 440, 'the octave lane should mean nothing in Hertz mode');
});

// ---------------------------------------------------------------------------
// Unison: detuned copies of a timbre, beyond the machine
// ---------------------------------------------------------------------------

test('unison voices spread either side, leaving the original in the middle', () => {
  assert.deepEqual(unisonRatios({ voices: 1, cents: 20 }), []);
  const cents = unisonRatios({ voices: 5, cents: 20 }).map((r) => Math.round(1200 * Math.log2(r)));
  assert.deepEqual(cents, [-20, -10, 10, 20]);
  // Two voices: the original and one sharp copy, which is what makes it beat.
  assert.deepEqual(unisonRatios({ voices: 2, cents: 8 }).map((r) => Math.round(1200 * Math.log2(r))), [8]);
});

/** How much the level of a block swings over its length, in 20 ms windows. */
const envelopeSwing = (buf: Float32Array): number => {
  const win = Math.round(SR * 0.02);
  const levels: number[] = [];
  for (let i = 0; i + win <= buf.length; i += win) {
    let s = 0;
    for (let k = i; k < i + win; k++) s += buf[k]! ** 2;
    levels.push(Math.sqrt(s / win));
  }
  return Math.max(...levels) - Math.min(...levels);
};

for (const servoScanner of [true, false]) {
  test(`two detuned voices beat, one voice does not (${servoScanner ? 'scanner' : 'wavetable'})`, () => {
    const render = (voices: number): Float32Array => {
      const m = new Machine({ sampleRate: SR, fidelity: { opticalAmplitude: false, relayLag: false, servoScanner } });
      openVoice(m);
      m.setUnison(0, { voices, cents: 30 });
      m.bounce(0.5);
      return m.bounce(1);
    };
    const plain = envelopeSwing(render(1));
    const detuned = envelopeSwing(render(2));
    assert.ok(detuned > plain * 4 + 0.01, `detuned swing ${detuned.toFixed(3)}, plain ${plain.toFixed(3)}`);
  });
}

test('seven voices on every timbre still render well over real time', () => {
  const m = new Machine({ sampleRate: SR });
  openVoice(m, 4);
  for (let t = 0; t < TIMBRE_COUNT; t++) m.setUnison(t, { voices: 7, cents: 25 });
  const started = performance.now();
  m.bounce(2);
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `2 s of audio took ${ms.toFixed(0)} ms`);
});

// ---------------------------------------------------------------------------
// Pan: where each timbre sits, beyond the machine
// ---------------------------------------------------------------------------

const rms = (buf: Float32Array): number => Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

const stereo = (pan: number, monoSum: boolean): [Float32Array, Float32Array] => {
  const m = new Machine({ sampleRate: SR, fidelity: { monoSum, opticalAmplitude: false, relayLag: false } });
  openVoice(m);
  m.setPan(0, pan);
  const l = new Float32Array(SR / 2);
  const r = new Float32Array(SR / 2);
  m.render(l, l.length, r);
  m.render(l, l.length, r);
  return [l, r];
};

test('a timbre panned hard left is silent on the right', () => {
  const [l, r] = stereo(-1, false);
  assert.ok(rms(l) > 0.01);
  assert.ok(rms(r) < rms(l) * 1e-3, `right is ${rms(r)}`);
});

test('a centred timbre is the same in both channels, and the same as mono', () => {
  const [l, r] = stereo(0, false);
  const [mono] = stereo(0, true);
  for (let i = 0; i < l.length; i += 97) {
    assert.ok(Math.abs(l[i]! - r[i]!) < 1e-6);
    assert.ok(Math.abs(l[i]! - mono[i]!) < 1e-6);
  }
});

test('with Mono on, pan is ignored, as it would be on the machine', () => {
  const [l, r] = stereo(-1, true);
  for (let i = 0; i < l.length; i += 97) assert.equal(l[i], r[i]);
});

test('panning keeps the overall level', () => {
  const [cl, cr] = stereo(0, false);
  const [hl, hr] = stereo(-1, false);
  const power = (a: Float32Array, b: Float32Array): number => rms(a) ** 2 + rms(b) ** 2;
  assert.ok(Math.abs(power(hl, hr) / power(cl, cr) - 1) < 0.05);
});

// ---------------------------------------------------------------------------
// The vibrato strip as a delay, beyond the machine
// ---------------------------------------------------------------------------

test('the lane height sets the delay time', () => {
  // Two settings of the line, two gaps between the repeats.
  const repeatAt = (height: number): number => {
    const m = new Machine({
      sampleRate: SR,
      fidelity: { opticalAmplitude: false, relayLag: false, servoScanner: false },
      echo: { feedback: 0.6, mix: 1, glideS: 0.001, dampHz: 12000 },
    });
    m.setVibratoMode('delay');
    loadConstant(m.lanes.pitch, 0.5);
    loadConstant(m.lanes.vibrato, height);
    // A short burst, then silence, so the repeat stands on its own.
    m.lanes.amp1.load(Float32Array.from({ length: 200 }, (_, i) => (i < 4 ? 1 : 0)), 1);
    // One burst, not one a second: a looping lane would strike again at 1 s.
    for (const lane of Object.values(m.lanes)) lane.loop = false;
    const buf = m.bounce(1.6);
    const start = Math.round(SR * 0.05);
    let loudest = start;
    for (let i = start; i < buf.length; i++) {
      if (Math.abs(buf[i]!) > Math.abs(buf[loudest]!)) loudest = i;
    }
    return loudest / SR;
  };

  const short = repeatAt(0.2);
  const long = repeatAt(0.8);
  assert.ok(long > short * 2, `height 0.8 repeated at ${long} s, height 0.2 at ${short} s`);
  assert.ok(short > echoSeconds(0.2) * 0.5, `the first repeat should be near ${echoSeconds(0.2)} s`);
});

test('in delay mode the vibrato strip stops bending the pitch', () => {
  const hz = (mode: 'vibrato' | 'delay'): number => {
    const m = new Machine({ sampleRate: SR, vibratoDepthCents: 400 });
    m.setVibratoMode(mode);
    openVoice(m);
    loadConstant(m.lanes.vibrato, 1);
    m.bounce(0.05);
    return m.meters.hz;
  };
  assert.ok(hz('vibrato') > hz('delay') * 1.2, 'a full-height line should bend the pitch up');
  assert.equal(hz('delay'), Math.round(hz('delay')), 'and in delay mode leave it where it was');
});

test('clear glass is silent, with no thump as the amplitude comes up', () => {
  // The photocell sees a steady beam through an unpainted slide, so there is
  // nothing to hear, including at the moment the voice opens.
  const m = new Machine({ sampleRate: SR });
  m.setSlide(0, Slide.fromField(new Float32Array(64 * 32), 64, 32));
  openVoice(m);
  assert.equal(peak(m.bounce(0.5)), 0);
});

test('a drawing that stops before the end of the sheet does not poison the output', () => {
  // A scanned sheet usually ends on blank paper, because the pen comes up
  // before the right-hand edge. The head clamped on that blank last sample
  // was handing back NaN, which spread through the mix and out to the file.
  const m = new Machine({ sampleRate: SR });
  const stops = Float32Array.from({ length: 128 }, (_, i) => (i < 100 ? 0.5 : Number.NaN));
  m.lanes.pitch.load(stops, 1);
  m.lanes.vibrato.load(stops, 1);
  m.lanes.reverb.load(stops, 1);
  loadConstant(m.lanes.amp1, 1);
  for (const lane of Object.values(m.lanes)) lane.loop = false;

  const buf = m.bounce(2);
  assert.ok([...buf].every(Number.isFinite), 'the output went non-finite past the end of the drawing');
});

test('the transport strip slows the heads to a crawl but never stops them', () => {
  // A line at the bottom rail used to be a dead stop, and a piece drawn that
  // way never reached its end.
  const m = new Machine({ sampleRate: SR });
  loadConstant(m.lanes.pitch, 0.5);
  loadConstant(m.lanes.transport, 0);
  m.lanes.pitch.loop = false;
  m.lanes.pitch.load(constant(0.5, 128), 1);
  m.bounce(0.5);
  assert.ok(m.lanes.pitch.position > 0, 'the head never moved');
  assert.ok(
    Math.abs(m.lanes.pitch.position - 0.5 * TRANSPORT_MIN_RATE) < 0.01,
    `moved ${m.lanes.pitch.position.toFixed(3)} s in half a second`,
  );
});
