export { ControlLane } from './lane.js';
export {
  PlateReverb,
  DEFAULT_PLATE,
  DEFAULT_ROOM,
  reverbOptions,
  type PlateOptions,
  type ReverbSpace,
} from './reverb.js';
export { Echo, DEFAULT_ECHO, echoSeconds, ECHO_MIN_S, ECHO_MAX_S, type EchoOptions } from './echo.js';
export {
  NEUME_WEIGHTS,
  NEUME_DIGITS,
  NEUME_TRACKS,
  NEUME_MAX_HZ,
  decodeNeume,
  encodeNeume,
  RelayBank,
  DEFAULT_RELAYS,
  type RelayOptions,
} from './neume.js';
export {
  Vactrol,
  DirectGain,
  DEFAULT_VACTROL,
  type VactrolOptions,
  type AmplitudeStage,
} from './vactrol.js';
export {
  Wavetable,
  TABLE_SIZE,
  DEFAULT_SCANNER,
  type ScannerOptions,
} from './wavetable.js';
export {
  Slide,
  type ScannableSlide,
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
  DEFAULT_SLIDE,
  blurSpot,
  type SlideOptions,
} from './slide.js';
export {
  mulberry32,
  randomRecipe,
  paintSlideField,
  randomSlideField,
  type SlideRecipe,
  type RecipeBias,
} from './paint.js';
export {
  FlyingSpotScanner,
  DEFAULT_SCANNER_OPTS,
  type ScannerOptions as ServoOptions,
} from './scanner.js';
export {
  Machine,
  FAITHFUL,
  type ScanWindow,
  type VibratoMode,
  type Unison,
  MAX_UNISON_VOICES,
  unisonRatios,
  PITCH_RANGE,
  TRANSPORT_MIN_RATE,
  PITCH_LANE_MAX_HZ,
  TIMBRE_COUNT,
  NOTE_ROWS,
  OCTAVE_ROWS,
  LOWEST_OCTAVE,
  DEFAULT_OCTAVE,
  rowValue,
  valueRow,
  midiToHz,
  notesToMidi,
  type PitchMode,
  type Fidelity,
  type LaneName,
  type MachineOptions,
} from './machine.js';
