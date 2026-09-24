import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ControlLane } from './lane.js';
import { Machine } from './machine.js';
import { DEFAULT_PLATE, DEFAULT_ROOM, PlateReverb } from './reverb.js';
import { Slide } from './slide.js';

const SR = 48_000;
const constant = (v: number, n = 64): Float32Array => new Float32Array(n).fill(v);

const rms = (b: Float32Array): number => {
  let a = 0;
  for (const v of b) a += v * v;
  return Math.sqrt(a / b.length);
};

/** Feed an impulse, then measure the tail in successive windows. */
const tail = (plate: PlateReverb, windows: number, windowSamples = 4800): number[] => {
  plate.process(1);
  const out: number[] = [];
  const buf = new Float32Array(windowSamples);
  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < windowSamples; i++) buf[i] = plate.process(0);
    out.push(rms(buf));
  }
  return out;
};

test('the plate rings and then decays', () => {
  const plate = new PlateReverb(SR);
  const windows = tail(plate, 8);
  assert.ok(windows[0]! > 1e-4, 'no tail at all');
  assert.ok(
    windows[7]! < windows[0]!,
    `tail did not decay: ${windows.map((w) => w.toExponential(1)).join(', ')}`,
  );
});

test('longer decay means a longer tail', () => {
  const short = tail(new PlateReverb(SR, { ...DEFAULT_PLATE, decay: 0.3 }), 6);
  const long = tail(new PlateReverb(SR, { ...DEFAULT_PLATE, decay: 0.85 }), 6);
  assert.ok(
    long[5]! > short[5]!,
    `decay 0.85 tail ${long[5]!.toExponential(1)} should outlast 0.3's ${short[5]!.toExponential(1)}`,
  );
});

test('the tank stays bounded even at maximum decay', () => {
  // A feedback network that creeps up rather than down turns into a scream at
  // the worst possible moment.
  const plate = new PlateReverb(SR, { ...DEFAULT_PLATE, decay: 1 });
  for (let i = 0; i < SR; i++) plate.process(Math.sin(i * 0.01));
  let peak = 0;
  for (let i = 0; i < SR * 2; i++) peak = Math.max(peak, Math.abs(plate.process(0)));
  assert.ok(Number.isFinite(peak), 'plate produced a non-finite sample');
  assert.ok(peak < 8, `plate ran away to ${peak.toFixed(2)}`);
});

test('damping darkens the tail rather than shortening it', () => {
  // Zero-crossing rate, not path length over rms: the latter moves with level
  // as well as brightness and reported the relationship backwards.
  const crossings = (damping: number): number => {
    const plate = new PlateReverb(SR, { ...DEFAULT_PLATE, damping });
    plate.process(1);
    const buf = new Float32Array(16384);
    for (let i = 0; i < buf.length; i++) buf[i] = plate.process(0);
    let zc = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i - 1]! < 0 !== buf[i]! < 0) zc++;
    return zc;
  };
  assert.ok(
    crossings(0.1) > crossings(0.85) * 1.1,
    `damping should dull the tail: ${crossings(0.1)} vs ${crossings(0.85)} crossings`,
  );
});

// ---------------------------------------------------------------------------
// Wired into the voice
// ---------------------------------------------------------------------------

const voiced = (fidelity: Record<string, boolean> = {}): Machine => {
  const m = new Machine({ sampleRate: SR, fidelity });
  m.setSlide(0, Slide.sine());
  m.lanes.pitch.load(constant(0.22), 30);
  m.lanes.amp1.load(constant(1), 30);
  return m;
};

test('the reverb strip sends more of the mix to the plate', () => {
  const level = (send: number): number => {
    const m = voiced();
    m.lanes.reverb.load(constant(send), 30);
    m.bounce(1);
    return rms(m.bounce(0.5));
  };
  assert.ok(level(1) > level(0) * 1.05, 'a full send should be audibly wetter than none');
});

test('the tail outlasts the line that made it', () => {
  // Reverb runs even when the send is down, so bringing it back to zero cannot
  // chop the tail off.
  const m = voiced();
  const send = new Float32Array(64);
  send.fill(1, 0, 16);
  m.lanes.reverb.load(send, 4);
  m.lanes.amp1.load(constant(0), 4); // silent voice: only the tail can sound
  m.lanes.reverb.position = 0;

  const wet = voiced();
  wet.lanes.reverb.load(constant(1), 4);
  wet.bounce(0.5);
  wet.lanes.amp1.load(constant(0), 4);
  const after = rms(wet.bounce(0.15));
  assert.ok(after > 1e-5, 'the plate went silent the instant the voice did');
});

test('the transport strip drives the read heads', () => {
  const travelled = (drive: number): number => {
    const m = voiced();
    m.lanes.transport.load(constant(drive), 30);
    m.bounce(0.5);
    return m.lanes.amp1.position;
  };
  const normal = travelled(0.5); // centre line
  const double = travelled(1); // top rail
  const stopped = travelled(0); // bottom rail

  assert.ok(Math.abs(double / normal - 2) < 0.05, `top rail gave ${(double / normal).toFixed(2)}x`);
  assert.ok(stopped < normal * 0.05, `bottom rail should halt, travelled ${stopped.toFixed(3)}s`);
});

test('a blank transport strip runs at normal speed', () => {
  // Nothing drawn is the state every session starts in. Reading it as a dead
  // stop froze the read heads and Play appeared to do nothing at all.
  const m = voiced();
  m.lanes.transport.load(new Float32Array(64).fill(Number.NaN), 30);
  m.bounce(0.5);
  assert.ok(
    Math.abs(m.lanes.amp1.position - 0.5) < 0.02,
    `head travelled ${m.lanes.amp1.position.toFixed(3)}s in 0.5s of audio`,
  );
});

test('a held lane rests at its default until something has been drawn', () => {
  const lane = new ControlLane();
  lane.gapBehaviour = 'hold';
  lane.defaultValue = 0.5;
  lane.load(new Float32Array(8).fill(Number.NaN), 1);
  assert.equal(lane.read(), 0.5, 'nothing drawn yet, so there is nothing to hold');

  // Once a value has been seen, gaps sustain it rather than falling back.
  lane.load(Float32Array.from([0.9, 0.9, Number.NaN, Number.NaN]), 1);
  lane.position = 0.1;
  lane.read();
  lane.position = 0.8;
  assert.ok(Math.abs(lane.read() - 0.9) < 1e-6, 'the gap should sustain 0.9');

  // And rewinding forgets it again.
  lane.reset();
  lane.position = 0.8;
  assert.equal(lane.read(), 0.5);
});

test('turning the transport strip off restores plain speed', () => {
  const m = voiced({ transportLane: false });
  m.lanes.transport.load(constant(1), 30); // would be double speed if wired
  m.bounce(0.5);
  assert.ok(
    Math.abs(m.lanes.amp1.position - 0.5) < 0.02,
    `head travelled ${m.lanes.amp1.position.toFixed(3)}s, expected 0.5`,
  );
});

test('the transport strip warps its own time axis', () => {
  // It is read by a head like everything else, so slowing down also slows the
  // rate at which the slowing-down instruction arrives.
  const m = voiced();
  const ramp = new Float32Array(64);
  for (let i = 0; i < 64; i++) ramp[i] = 0.5 - (0.5 * i) / 63; // normal down to a stop
  m.lanes.transport.load(ramp, 4);
  m.bounce(2);
  assert.ok(
    m.lanes.transport.position < 4,
    'the transport head should never reach the end of a strip that stops it',
  );
});

test('a room arrives sooner and dies away faster than the plate', () => {
  const plate = new PlateReverb(SR, DEFAULT_PLATE);
  const room = new PlateReverb(SR, DEFAULT_ROOM);
  const early = (r: PlateReverb): number => {
    // The first 30 ms: a plate has nothing here yet, a room has its first bounces.
    let sum = 0;
    for (let i = 0; i < SR * 0.03; i++) sum += Math.abs(r.process(i === 0 ? 1 : 0));
    return sum;
  };
  const rest = (r: PlateReverb, seconds: number): number => {
    let sum = 0;
    for (let i = 0; i < SR * seconds; i++) sum += Math.abs(r.process(0));
    return sum;
  };
  const roomEarly = early(room);
  const plateEarly = early(plate);
  assert.ok(roomEarly > plateEarly * 2, `room ${roomEarly}, plate ${plateEarly}`);
  assert.ok(rest(room, 1.5) < rest(plate, 1.5), 'the room tail should be the shorter one');
});
