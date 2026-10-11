/// <reference path="./worklet-types.d.ts" />
/**
 * The audio thread. This file is deliberately thin: it owns no DSP, it only
 * pumps the engine and relays messages. Everything that makes a sound lives in
 * @oramics/engine, which knows nothing about Web Audio and can therefore also
 * run in a test or an offline bounce.
 */

import { Machine, Slide } from '@oramics/engine';

import { LANE_ORDER, type EngineMessage, type MeterMessage } from './protocol.js';

/** Below this, for a quarter of a second, a tail has finished. */
const SILENCE_LEVEL = 1e-4;

/** Meter updates for the UI, throttled to roughly display rate. */
const METER_INTERVAL_FRAMES = 1500;

class OramicsProcessor extends AudioWorkletProcessor {
  private machine = new Machine({ sampleRate });
  private playing = false;
  /**
   * Whether anything is still sounding while paused. The machine keeps being
   * pumped until its tails have died, and then there is nothing to pump for.
   */
  private ringing = false;
  private quietFrames = 0;
  private framesSinceMeter = 0;
  private readonly positions = new Float32Array(LANE_ORDER.length);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<EngineMessage>) => this.handle(event.data);
  }

  private handle(msg: EngineMessage): void {
    switch (msg.type) {
      case 'lane':
        this.machine.lanes[msg.name].load(new Float32Array(msg.data), msg.durationS);
        break;
      case 'clearLane':
        this.machine.lanes[msg.name].clear();
        break;
      case 'timbre':
        // A drawn line becomes a painted stroke for the servo to track; the
        // machine derives the wavetable bypass from the same slide.
        this.machine.setSlide(msg.index, Slide.fromContour(new Float32Array(msg.contour)));
        break;
      case 'slide':
        this.machine.setSlide(
          msg.index,
          Slide.preblurred(new Float32Array(msg.field), msg.width, msg.height),
        );
        break;
      case 'vibratoMode':
        this.machine.setVibratoMode(msg.mode);
        break;
      case 'echoFeedback':
        this.machine.setEchoOptions({ feedback: msg.value });
        break;
      case 'reverbSpace':
        this.machine.setReverbSpace(msg.space);
        break;
      case 'slip':
        this.machine.setSlip(msg.index, msg.amount);
        break;
      case 'timbreOctave':
        this.machine.setTimbreOctave(msg.index, msg.octaves);
        break;
      case 'pan':
        this.machine.setPan(msg.index, msg.value);
        break;
      case 'unison':
        this.machine.setUnison(msg.index, msg.unison);
        break;
      case 'scanWindow':
        this.machine.setScanWindow(msg.index, { low: msg.low, high: msg.high });
        break;
      case 'fidelity':
        this.machine.setFidelity(msg.patch);
        break;
      case 'globalSpeed':
        this.machine.setGlobalSpeed(msg.value);
        break;
      case 'laneSpeed':
        this.machine.lanes[msg.name].speed = msg.value;
        break;
      case 'pitchMode':
        this.machine.setPitchMode(msg.mode);
        break;
      case 'vibratoDepth':
        this.machine.setVibratoDepthCents(msg.cents);
        break;
      case 'transport':
        if (msg.stop) {
          // The plug, not the pause: everything quiet at once.
          this.machine.silence();
          this.ringing = false;
          this.quietFrames = 0;
        } else if (!msg.playing && this.playing) {
          // Let what is sounding die away in its own time.
          this.ringing = true;
          this.quietFrames = 0;
        }
        this.playing = msg.playing;
        this.machine.setPaused(!msg.playing);
        if (msg.rewind) this.machine.reset();
        /*
         * Say where the heads are now.
         *
         * Meters otherwise only go out while playing, so a rewind with the
         * transport stopped moved the heads and told nobody: the playhead sat
         * where it was and the button looked dead.
         */
        this.framesSinceMeter = 0;
        this.postMeters();
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0]!;

    if (!this.playing && !this.ringing) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    // The machine fills both sides: the same mono mix with Mono on, the
    // timbres where their pan puts them with it off.
    const right = output[1];
    this.machine.render(left, left.length, right);
    for (let c = 2; c < output.length; c++) output[c]!.set(left);

    /*
     * Stop pumping once the tail has gone. A paused machine still runs four
     * servo loops a sample, and leaving that going while nothing can be heard
     * burns an audio thread for no sound.
     */
    if (this.ringing) {
      let peak = 0;
      for (const v of left) peak = Math.max(peak, Math.abs(v));
      this.quietFrames = peak < SILENCE_LEVEL ? this.quietFrames + left.length : 0;
      if (this.quietFrames > sampleRate * 0.25) {
        this.ringing = false;
        this.machine.silence();
      }
    }

    this.framesSinceMeter += left.length;
    if (this.framesSinceMeter >= METER_INTERVAL_FRAMES) {
      this.framesSinceMeter = 0;
      this.postMeters();
    }
    return true;
  }

  private postMeters(): void {
    // LANE_ORDER, not a copy of it. A second list here had to be kept in step
    // by hand, and adding the octave lane to one and not the other would have
    // shifted every playhead after pitch onto the wrong lane.
    for (let i = 0; i < LANE_ORDER.length; i++) {
      this.positions[i] = this.machine.lanes[LANE_ORDER[i]!].position;
    }
    const msg: MeterMessage = {
      type: 'meters',
      hz: this.machine.meters.hz,
      gains: Array.from(this.machine.meters.gains),
      positions: Array.from(this.positions),
    };
    this.port.postMessage(msg);
  }
}

registerProcessor('oramics', OramicsProcessor);
