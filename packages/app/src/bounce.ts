/**
 * Rendering the sheet to a file.
 *
 * Offline rather than recorded: the same engine the worklet runs, fed the same
 * lanes and slides, pumped as fast as the CPU allows. The result is the piece
 * exactly as it plays, with no dropped buffers and no need to sit through it,
 * and it does not depend on anyone pressing Stop at the right moment.
 *
 * One pass of the sheet, however long the transport strip and the speed make
 * that, then a short tail so the plate and the light bulbs can die away.
 *
 * The same pass also keeps a trace of what the machine did, every ten
 * milliseconds, which is what the MIDI export is written from.
 */

import {
  Machine,
  Slide,
  TIMBRE_COUNT,
  blurSpot,
  type Fidelity,
  type LaneName,
  reverbOptions,
  type PitchMode,
  type ReverbSpace,
  type Unison,
  type VibratoMode,
} from '@oramics/engine';
import type { Trace } from '@oramics/midi';

import { SLIDE_HEIGHT, SLIDE_WIDTH } from './lanes.js';

export interface BounceInput {
  /** What the engine should read, per lane: pitch and octave already read as notes. */
  lanes: Partial<Record<LaneName, Float32Array>>;
  slides: Float32Array[];
  globalSpeed: number;
  vibratoCents: number;
  fidelity: Fidelity;
  pitchMode: PitchMode;
  /** Detuned voices per timbre, if any. */
  unison?: Unison[];
  /** Pan per timbre. Heard only with `fidelity.monoSum` off, which also makes the file stereo. */
  pan?: number[];
  /** What the vibrato strip drives. */
  vibratoMode?: VibratoMode;
  echoFeedback?: number;
  reverbSpace?: ReverbSpace;
  /** Seconds the sheet represents. */
  durationS: number;
  sampleRate?: number;
  /** Give up after this long, for a transport strip that stops the sheet dead. */
  maxSeconds?: number;
  /** Seconds rendered after the sheet ends. */
  tailSeconds?: number;
}

export interface BounceResult {
  /** Left, or the only channel in mono. */
  audio: Float32Array;
  /** Right, present only for a stereo render. */
  right: Float32Array | null;
  sampleRate: number;
  trace: Trace;
  /** True if the sheet never reached its end and the render was cut off. */
  truncated: boolean;
}

const TRACE_STEP_S = 0.01;

export const bounce = (input: BounceInput, onProgress?: (fraction: number) => void): BounceResult => {
  const sampleRate = input.sampleRate ?? 48000;
  const maxSeconds = input.maxSeconds ?? 600;
  const tailSeconds = input.tailSeconds ?? 2.5;

  const machine = new Machine({
    sampleRate,
    fidelity: input.fidelity,
    vibratoDepthCents: input.vibratoCents,
    plate: reverbOptions(input.reverbSpace ?? 'plate'),
  });
  if (input.vibratoMode) machine.setVibratoMode(input.vibratoMode);
  if (input.echoFeedback !== undefined) machine.setEchoOptions({ feedback: input.echoFeedback });
  machine.setPitchMode(input.pitchMode);
  for (const [name, values] of Object.entries(input.lanes) as [LaneName, Float32Array][]) {
    machine.lanes[name].load(values, input.durationS);
  }
  input.slides.forEach((field, i) => {
    if (i < TIMBRE_COUNT) {
      machine.setSlide(i, Slide.preblurred(blurSpot(field, SLIDE_WIDTH, SLIDE_HEIGHT), SLIDE_WIDTH, SLIDE_HEIGHT));
    }
  });
  input.unison?.forEach((u, i) => {
    if (i < TIMBRE_COUNT) machine.setUnison(i, u);
  });
  input.pan?.forEach((p, i) => {
    if (i < TIMBRE_COUNT) machine.setPan(i, p);
  });
  const stereo = !input.fidelity.monoSum;
  machine.setGlobalSpeed(input.globalSpeed);
  // From the top, with no crossfade left over from swapping the slides in.
  machine.reset();
  // One pass: every head stops at the end instead of going round again.
  for (const lane of Object.values(machine.lanes)) lane.loop = false;

  const block = Math.round(TRACE_STEP_S * sampleRate);
  const chunks: Float32Array[] = [];
  const rightChunks: Float32Array[] = [];
  const targetHz: number[] = [];
  const hz: number[] = [];
  const level: number[] = [];
  const pitch = machine.lanes.pitch;

  const pump = (): void => {
    const out = new Float32Array(block);
    const right = stereo ? new Float32Array(block) : undefined;
    machine.render(out, block, right);
    chunks.push(out);
    if (right) rightChunks.push(right);
    targetHz.push(machine.meters.targetHz);
    hz.push(machine.meters.hz);
    level.push(Math.max(...machine.meters.gains));
  };

  let rendered = 0;
  let lastReport = 0;
  let truncated = false;
  while (pitch.position < input.durationS - 1e-6) {
    if (rendered >= maxSeconds) {
      truncated = true;
      break;
    }
    pump();
    rendered += TRACE_STEP_S;
    const fraction = pitch.position / input.durationS;
    if (onProgress && fraction - lastReport >= 0.02) {
      lastReport = fraction;
      onProgress(fraction);
    }
  }

  // The tail: the sheet is over, so nothing new sounds, but what was sounding
  // is allowed to fade the way it would have.
  for (const name of ['amp1', 'amp2', 'amp3', 'amp4'] as const) machine.lanes[name].clear();
  const tailBlocks = Math.round(tailSeconds / TRACE_STEP_S);
  for (let i = 0; i < tailBlocks; i++) pump();

  const join = (parts: Float32Array[]): Float32Array => {
    const joined = new Float32Array(parts.length * block);
    parts.forEach((c, i) => joined.set(c, i * block));
    return joined;
  };
  return {
    audio: join(chunks),
    right: stereo ? join(rightChunks) : null,
    sampleRate,
    trace: {
      step: TRACE_STEP_S,
      targetHz: Float32Array.from(targetHz),
      hz: Float32Array.from(hz),
      level: Float32Array.from(level),
    },
    truncated,
  };
};

/** Loudest sample in an exported file: 1 dB under full scale. */
const EXPORT_PEAK = 10 ** (-1 / 20);

/**
 * Sixteen-bit WAV, normalised. Mono, as the machine was, unless a right
 * channel is given.
 *
 * The machine mixes four timbres into one output with room for all four at
 * full level, so a piece using one or two sits well down, and played back at
 * its own level a file came out barely audible. The whole file is scaled by
 * one amount so its loudest moment peaks at -1 dB. Quiet passages stay quieter
 * than loud ones; only the overall level moves.
 */
export const encodeWav = (
  audio: Float32Array,
  sampleRate: number,
  right: Float32Array | null = null,
): Uint8Array => {
  const channels = right ? 2 : 1;
  // Finite values only. One stray NaN would make the peak NaN, and with it the
  // gain, and the whole file would come out silent.
  let peak = 0;
  const loudest = (buf: Float32Array): void => {
    for (const v of buf) if (Number.isFinite(v) && Math.abs(v) > peak) peak = Math.abs(v);
  };
  loudest(audio);
  if (right) loudest(right);
  // Both channels by the same amount, so the balance between them survives.
  const gain = peak > 1e-6 ? EXPORT_PEAK / peak : 1;

  const dataBytes = audio.length * 2 * channels;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * channels, true);
  view.setUint16(32, 2 * channels, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  const put = (at: number, v: number): void =>
    view.setInt16(
      at,
      Number.isFinite(v) ? Math.round(Math.max(-1, Math.min(1, v * gain)) * 32767) : 0,
      true,
    );
  for (let i = 0; i < audio.length; i++) {
    // Interleaved: left then right for each frame.
    put(44 + i * 2 * channels, audio[i]!);
    if (right) put(44 + i * 4 + 2, right[i]!);
  }
  return bytes;
};
