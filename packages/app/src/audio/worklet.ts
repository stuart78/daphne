/// <reference path="./worklet-types.d.ts" />
/**
 * The audio thread. This file is deliberately thin: it owns no DSP, it only
 * pumps the engine and relays messages. Everything that makes a sound lives in
 * @oramics/engine, which knows nothing about Web Audio and can therefore also
 * run in a test or an offline bounce.
 */

import { Machine, Slide } from '@oramics/engine';

import { LANE_ORDER, type EngineMessage, type MeterMessage } from './protocol.js';

/** Meter updates for the UI, throttled to roughly display rate. */
const METER_INTERVAL_FRAMES = 1500;

class OramicsProcessor extends AudioWorkletProcessor {
  private machine = new Machine({ sampleRate });
  private playing = false;
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
        this.playing = msg.playing;
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

    if (!this.playing) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    // The machine fills both sides: the same mono mix with Mono on, the
    // timbres where their pan puts them with it off.
    const right = output[1];
    this.machine.render(left, left.length, right);
    for (let c = 2; c < output.length; c++) output[c]!.set(left);

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
