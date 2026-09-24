import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  FAITHFUL,
  NOTE_ROWS,
  OCTAVE_ROWS,
  LOWEST_OCTAVE,
  randomSlideField,
  type Fidelity,
  type PitchMode,
  type ReverbSpace,
  type Unison,
  type VibratoMode,
  ECHO_MAX_S,
  ECHO_MIN_S,
  echoSeconds,
  unisonRatios,
} from '@oramics/engine';
import type { Layout } from '@oramics/template';

import { AudioClient } from './audio/client.js';
import { LANE_ORDER } from './audio/protocol.js';
import type { BounceInput } from './bounce.js';
import { exportBlankPdf, exportSessionPdf } from './export.js';
import { openEditorLink, type ProjectorMessage } from './projectorLink.js';
import { exportMidi, exportWav } from './render.js';
import { decodeSession, encodeSession, type Session, type SessionSettings } from './session.js';
import { readMidiFile } from './midi.js';
import {
  CHROMATIC,
  NOTE_NAMES,
  SCALES,
  SHARP_ROWS,
  inScale,
  readRows,
  snapNote,
  type MarkMode,
  type Tuning,
} from './music.js';
import { isBlank, scanImageFile, toBitmaps } from './scan.js';
import {
  openSession,
  pickImage,
  pickMidi,
  readAutosave,
  saveSession,
  writeAutosave,
  writeAutosaveNow,
} from './sessionFile.js';
import type { ShellCommand } from './shell.js';
import {
  LANE_DEFS,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  makeAllLanes,
  paintSlide,
  type LaneMap,
  type LaneTrack,
  type SlideShape,
} from './lanes.js';
import { DrawPad } from './ui/DrawPad.js';
import { MenuButton } from './ui/MenuButton.js';
import { PaintPad } from './ui/PaintPad.js';
import { Ruler } from './ui/Ruler.js';
import { applyTheme, initialTheme, type Theme } from './ui/theme.js';
import { FULL, follow, zoomAt, type View } from './ui/view.js';

/** Matches the printed sheet: 300 mm of field at 10 mm/s. */
const DURATION_S = 30;

/**
 * How often a slide being painted is pushed to the audio thread.
 *
 * Each push blurs a 512x256 field for the scanning spot — about 8 ms — and
 * transfers half a megabyte. Doing that per pointer move saturates the main
 * thread and floods the worklet's port. Coalescing to roughly ten a second is
 * imperceptible while painting and leaves both threads idle in between; the
 * pending map always holds the latest field, so the final state of a stroke
 * still lands.
 */
const SLIDE_PUSH_MS = 90;

/** Quiet time after a change before the session is written for next launch. */
const AUTOSAVE_MS = 1000;

/**
 * Guide lines on the delay lane, at times worth aiming for. The lane is
 * exponential in time, so these are not evenly spaced.
 */
const ECHO_GUIDE_S = [0.125, 0.25, 0.5, 1];
const ECHO_GUIDES = ECHO_GUIDE_S.map(
  (t) => Math.log(t / ECHO_MIN_S) / Math.log(ECHO_MAX_S / ECHO_MIN_S),
);

/** A pan setting in words, for the tooltip. */
const panLabel = (p: number): string =>
  Math.abs(p) < 0.025 ? 'centre' : `${Math.round(Math.abs(p) * 100)}% ${p < 0 ? 'left' : 'right'}`;

/** How far apart the detuned echoes are drawn on a slide, per cent of detune. */
const GHOST_COLUMNS_PER_CENT = 1.4;

/** One voice per timbre: the machine as built. */
const NO_UNISON: Unison = { voices: 1, cents: 0 };

/**
 * The waveform presets on each timbre. Sine, saw and square paint the slide.
 * Supersaw paints a saw and stacks seven detuned copies of it; detune leaves
 * the painting alone and adds three. Neither of those two is anything the
 * machine could do: it had one spot per slide.
 */
const PRESETS: { id: string; label: string; shape: SlideShape | null; unison: Unison }[] = [
  { id: 'sine', label: 'Sine', shape: 'sine', unison: NO_UNISON },
  { id: 'saw', label: 'Saw', shape: 'saw', unison: NO_UNISON },
  { id: 'square', label: 'Square', shape: 'square', unison: NO_UNISON },
  { id: 'supersaw', label: 'Supersaw', shape: 'saw', unison: { voices: 7, cents: 25 } },
  { id: 'detune', label: 'Detune', shape: null, unison: { voices: 3, cents: 12 } },
  // Clear glass. The spot has nothing to ride, so the timbre goes quiet: a way
  // to take a voice out without drawing its amplitude down to nothing.
  { id: 'blank', label: 'Blank', shape: 'blank', unison: NO_UNISON },
];

/**
 * A fresh set of slides. Randomised rather than four identical sines, so a new
 * session already sounds like something.
 */
const freshSlides = (): Float32Array[] =>
  Array.from(
    { length: 4 },
    () =>
      randomSlideField(Math.floor(Math.random() * 2 ** 31), { roundness: 0.5, wildness: 0.4 })
        .field,
  );

/** Everything a session carries, as the app opens: the machine as built. */
const DEFAULT_SETTINGS: SessionSettings = {
  globalSpeed: 1,
  vibratoCents: 50,
  fidelity: FAITHFUL,
  pitchMode: 'hertz',
  markMode: 'lines',
  root: 0,
  scale: 'chromatic',
  unison: Array.from({ length: 4 }, () => NO_UNISON),
  presets: ['', '', '', ''],
  pan: [0, 0, 0, 0],
  vibratoMode: 'vibrato',
  echoFeedback: 0.35,
  reverbSpace: 'plate',
};

/** Lanes the engine hears through the note reading rather than as drawn. */
const PITCH_LANES = new Set<keyof LaneMap>(['pitch', 'octave']);

/** Octave rows, bottom first, named the way a keyboard names them. */
const OCTAVE_LABELS = Array.from({ length: OCTAVE_ROWS }, (_, i) => String(i + LOWEST_OCTAVE));

export const App = (): JSX.Element => {
  const [lanes, setLanes] = useState<LaneMap>(makeAllLanes);
  const [slides, setSlides] = useState<Float32Array[]>(freshSlides);

  const [unison, setUnison] = useState<Unison[]>(DEFAULT_SETTINGS.unison);
  /** Where each timbre sits, -1 left to 1 right. Heard only with Mono off. */
  const [pan, setPan] = useState<number[]>(DEFAULT_SETTINGS.pan);
  /** What the vibrato strip drives, and where the reverb send goes. */
  const [vibratoMode, setVibratoMode] = useState<VibratoMode>(DEFAULT_SETTINGS.vibratoMode);
  const [echoFeedback, setEchoFeedback] = useState(DEFAULT_SETTINGS.echoFeedback);
  const [reverbSpace, setReverbSpace] = useState<ReverbSpace>(DEFAULT_SETTINGS.reverbSpace);
  const delay = vibratoMode === 'delay';
  /** The preset each timbre was last set from, or '' once it has been painted over. */
  const [presets, setPresets] = useState<string[]>(DEFAULT_SETTINGS.presets);
  const setPreset = (index: number, id: string): void =>
    setPresets((prev) => (prev[index] === id ? prev : prev.map((p, i) => (i === index ? id : p))));

  /*
   * The detuned copies as echoes on the slide, in columns either side. Scaled so
   * a supersaw's spread reads at a glance without smearing the stroke into a
   * block. Memoised: a new array would repaint every slide on every render.
   */
  const ghosts = useMemo(
    () =>
      unison.map((u) =>
        unisonRatios(u).map((r) => Math.round(1200 * Math.log2(r) * GHOST_COLUMNS_PER_CENT)),
      ),
    [unison],
  );

  const [theme, setTheme] = useState<Theme>(initialTheme);

  // A layout effect, not a passive one: passive effects run children-first, so
  // the pads would repaint from the old palette before this landed.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const [erasing, setErasing] = useState(false);
  /** Bias for the generator: 0 spiky and harsh, 1 round and soft. */
  const [character, setCharacter] = useState(0.5);
  /** How eventful generated slides are — gaps, stacked ribbons, weight changes. */
  const [wildness, setWildness] = useState(0.4);
  const [playing, setPlaying] = useState(false);
  const [globalSpeed, setGlobalSpeed] = useState(DEFAULT_SETTINGS.globalSpeed);
  const [vibratoCents, setVibratoCents] = useState(DEFAULT_SETTINGS.vibratoCents);
  const [fidelity, setFidelity] = useState<Fidelity>(DEFAULT_SETTINGS.fidelity);
  const [heads, setHeads] = useState<Record<string, number>>({});
  const [hz, setHz] = useState(0);
  const [status, setStatus] = useState('');
  /** The slice of the sheet on screen. One window, every lane. */
  const [view, setView] = useState<View>(FULL);
  /**
   * The registered paper behind each lane, once a sheet has been imported.
   *
   * Held as bitmaps so the pads can blit a slice of them per frame. Cleared
   * whenever the session stops being that sheet.
   */
  const [paper, setPaper] = useState<Record<string, ImageBitmap> | null>(null);
  const [showReading, setShowReading] = useState(true);

  /*
   * How pitch is drawn.
   *
   * Hertz is the original machine: one line, height is the frequency. Notes
   * splits it into a note band and an octave band, the shape of Oram's 1976
   * design. The engine behind both is the same machine; only the reading of the
   * marks changes.
   */
  const [pitchMode, setPitchMode] = useState<PitchMode>(DEFAULT_SETTINGS.pitchMode);
  const [markMode, setMarkMode] = useState<MarkMode>(DEFAULT_SETTINGS.markMode);
  const [tuning, setTuning] = useState<Tuning>(CHROMATIC);
  const layout: Layout = pitchMode === 'notes' ? 'TONE' : 'FULL';

  /*
   * What the note and octave marks are read as.
   *
   * Computed here, once, and used twice: sent to the engine as the notes to
   * play, and drawn over the marks so what you see is what plays.
   */
  const tonal = useMemo(() => {
    if (pitchMode !== 'notes') return null;
    return {
      note: readRows(lanes.pitch.values, lanes.pitch.strokes, NOTE_ROWS, markMode, (r) =>
        snapNote(r, tuning),
      ),
      octave: readRows(lanes.octave.values, lanes.octave.strokes, OCTAVE_ROWS, markMode),
    };
  }, [pitchMode, markMode, tuning, lanes.pitch, lanes.octave]);

  const client = useRef<AudioClient>(null);
  if (client.current === null) client.current = new AudioClient();

  /** Every lane but pitch and octave, which the reading effect sends. */
  const sendControlLanes = (next: LaneMap): void => {
    for (const def of LANE_DEFS) {
      if (!PITCH_LANES.has(def.name)) client.current!.sendLane(def.name, next[def.name].values, DURATION_S);
    }
  };

  /** Resend everything to the projector. Rewritten each render, see below. */
  const postAll = useRef<() => void>(() => {});
  const link = useRef<ReturnType<typeof openEditorLink>>(null);
  // Opened in an effect, not during render, so a remount gets a fresh one
  // rather than posting into the one the unmount closed.
  useEffect(() => {
    const opened = openEditorLink(() => postAll.current());
    link.current = opened;
    return () => {
      opened.close();
      link.current = null;
    };
  }, []);

  // Push every lane once the worklet exists; the client queues until then.
  useEffect(() => {
    sendControlLanes(lanes);
    slides.forEach((f, i) => client.current!.sendSlide(i, f));
    // Deliberately once on mount — later edits push individually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const off = client.current!.onMeters((m) => {
      const next: Record<string, number> = {};
      LANE_ORDER.forEach((name, i) => {
        next[name] = (m.positions[i] ?? 0) / DURATION_S;
      });
      setHeads(next);
      setHz(m.hz);
    });
    return off;
  }, []);

  // The projector is a pure view. Drawings go only when they change...
  const lanesMessage = (): ProjectorMessage => ({
    kind: 'lanes',
    lanes,
    pitchMode,
    reading: tonal ? { pitch: tonal.note, octave: tonal.octave } : null,
    shaded: Array.from({ length: NOTE_ROWS }, (_, r) => r).filter((r) =>
      tuning.scale === 'chromatic' ? SHARP_ROWS.has(r) : !inScale(r, tuning),
    ),
  });
  const transportMessage = (): ProjectorMessage => ({ kind: 'transport', heads, hz, playing });
  postAll.current = () => {
    link.current?.post(lanesMessage());
    link.current?.post(transportMessage());
  };

  useEffect(() => {
    link.current?.post(lanesMessage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanes, tonal, pitchMode, tuning]);

  // ...and the read heads go at meter rate, carrying nothing bulky.
  useEffect(() => {
    link.current?.post(transportMessage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heads, hz, playing]);

  /*
   * Keep the pitch head in shot while playing.
   *
   * Zoomed in, a moving head leaves the window within a second or two and you
   * end up chasing it by hand. `follow` pages rather than creeps, and returns
   * the view unchanged while the head is comfortably inside, so this settles
   * instead of re-rendering on every meter tick.
   */
  useEffect(() => {
    if (!playing) return;
    const at = heads.pitch;
    if (at === undefined) return;
    setView((prev) => follow(prev, at));
  }, [heads, playing]);

  const updateLane = useCallback((name: keyof LaneMap, track: LaneTrack) => {
    setLanes((prev) => ({ ...prev, [name]: track }));
    // Pitch and octave go through the reading first, in the effect below.
    if (!PITCH_LANES.has(name)) client.current!.sendLane(name, track.values, DURATION_S);
  }, []);

  /*
   * The pitch lanes, as the engine should hear them.
   *
   * In Hertz mode that is the line as drawn. In Notes mode it is the reading:
   * one chosen row per column, snapped to the key, with dots already turned
   * into notes that hold. Sending the raw marks there would make the engine
   * play every wobble of a line as a different note.
   */
  useEffect(() => {
    const c = client.current!;
    c.send({ type: 'pitchMode', mode: pitchMode });
    c.sendLane('pitch', tonal ? tonal.note : lanes.pitch.values, DURATION_S);
    c.sendLane('octave', tonal ? tonal.octave : lanes.octave.values, DURATION_S);
  }, [pitchMode, tonal, lanes.pitch, lanes.octave]);

  const pendingSlides = useRef(new Map<number, Float32Array>());
  const slideTimer = useRef<number | null>(null);

  const flushSlides = useCallback(() => {
    slideTimer.current = null;
    for (const [index, painted] of pendingSlides.current) {
      client.current!.sendSlide(index, painted);
    }
    pendingSlides.current.clear();
  }, []);

  useEffect(() => () => {
    if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
  }, []);

  const updateSlide = useCallback(
    (index: number, painted: Float32Array) => {
      // The canvas updates immediately; only the push to audio is coalesced.
      setSlides((prev) => prev.map((f, i) => (i === index ? painted : f)));
      pendingSlides.current.set(index, painted);
      if (slideTimer.current === null) {
        slideTimer.current = window.setTimeout(flushSlides, SLIDE_PUSH_MS);
      }
    },
    [flushSlides],
  );

  const randomiseSlide = useCallback(
    (index: number) => {
      // Jitter around the slider so repeated presses at one setting still vary.
      const roundness = Math.max(0, Math.min(1, character + (Math.random() - 0.5) * 0.2));
      const seed = Math.floor(Math.random() * 2 ** 31);
      const { field } = randomSlideField(seed, { roundness, wildness });
      updateSlide(index, field);
    },
    [character, wildness, updateSlide],
  );

  // Detuned voices go to the engine whenever they change, including at start.
  useEffect(() => {
    unison.forEach((u, index) => client.current!.send({ type: 'unison', index, unison: u }));
  }, [unison]);

  useEffect(() => {
    pan.forEach((value, index) => client.current!.send({ type: 'pan', index, value }));
  }, [pan]);

  useEffect(() => {
    client.current!.send({ type: 'vibratoMode', mode: vibratoMode });
  }, [vibratoMode]);

  useEffect(() => {
    client.current!.send({ type: 'echoFeedback', value: echoFeedback });
  }, [echoFeedback]);

  useEffect(() => {
    client.current!.send({ type: 'reverbSpace', space: reverbSpace });
  }, [reverbSpace]);

  /**
   * Move a timbre left or right. Pan means nothing in mono, and the machine was
   * mono, so reaching for one turns Mono off rather than leaving the control
   * apparently broken.
   */
  const panTimbre = (index: number, value: number): void => {
    setPan((prev) => prev.map((p, i) => (i === index ? value : p)));
    if (fidelity.monoSum) {
      patchFidelity({ monoSum: false });
      setStatus('Mono is off so the pan can be heard. Turn it back on to hear the machine as built.');
    }
  };

  const setTimbreUnison = (index: number, next: Unison): void =>
    setUnison((prev) => prev.map((u, i) => (i === index ? next : u)));

  const applyPreset = (index: number, id: string): void => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    if (preset.shape) updateSlide(index, paintSlide(preset.shape));
    setTimbreUnison(index, preset.unison);
    setPreset(index, preset.id);
  };

  const randomiseAll = useCallback(() => {
    for (let i = 0; i < 4; i++) randomiseSlide(i);
    setPresets(['', '', '', '']);
  }, [randomiseSlide]);

  const togglePlay = async (): Promise<void> => {
    // Browsers only allow an AudioContext to start from a user gesture.
    await client.current!.start();
    const next = !playing;
    setPlaying(next);
    client.current!.send({ type: 'transport', playing: next });
  };

  const rewind = (): void => {
    client.current!.send({ type: 'transport', playing, rewind: true });
  };

  const patchFidelity = (patch: Partial<Fidelity>): void => {
    setFidelity((prev) => ({ ...prev, ...patch }));
    client.current!.send({ type: 'fidelity', patch });
  };

  const onExport = async (): Promise<void> => {
    setStatus('building PDF…');
    try {
      const path = await exportSessionPdf({ lanes, slides, layout });
      setStatus(path ? `saved ${path}` : 'export cancelled');
    } catch (err) {
      setStatus(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** The sheet with nothing on it: what a workshop prints and hands out. */
  const onBlank = async (): Promise<void> => {
    setStatus('building the sheet…');
    try {
      const path = await exportBlankPdf(undefined, layout);
      setStatus(path ? `saved ${path}` : 'cancelled');
    } catch (err) {
      setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const settings = (): SessionSettings => ({
    globalSpeed,
    vibratoCents,
    fidelity,
    pitchMode,
    markMode,
    root: tuning.root,
    scale: tuning.scale,
    unison,
    presets,
    pan,
    vibratoMode,
    echoFeedback,
    reverbSpace,
  });

  const onSave = async (): Promise<void> => {
    try {
      const path = await saveSession({ lanes, slides, settings: settings() });
      setStatus(path ? `saved ${path}` : 'save cancelled');
    } catch (err) {
      setStatus(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Import a photograph or scan of a printed sheet.
   *
   * Replaces the lanes and slides rather than merging: a sheet is a whole
   * piece, and the marks on it are the piece. Settings are left alone, since
   * the paper says nothing about them.
   */
  const onScan = async (): Promise<void> => {
    const file = await pickImage();
    if (!file) return setStatus('import cancelled');

    setStatus('reading the sheet…');
    try {
      const scan = await scanImageFile(file);
      setLanes(scan.lanes);
      setSlides(scan.slides);
      setView(FULL);
      setPaper(await toBitmaps(scan.paper));
      setShowReading(true);
      // The sheet names its own layout, so a note-and-octave sheet switches the
      // app to notes without anyone having to remember to.
      setPitchMode(scan.layout === 'TONE' ? 'notes' : 'hertz');

      sendControlLanes(scan.lanes);
      scan.slides.forEach((field, i) => client.current!.sendSlide(i, field));

      const drawn = Object.entries(scan.coverage)
        .filter(([, c]) => c >= 0.01)
        .map(([role]) => role);
      setStatus(
        isBlank(scan)
          ? `read ${scan.sheetId ?? 'the sheet'} but found no marks on it`
          : `imported ${scan.sheetId ?? 'sheet'}: ${drawn.join(', ')} ` +
              `(fit ${scan.fitMm.toFixed(2)} mm)`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Import a MIDI file.
   *
   * The machine has one pitch strip and four amplitudes, and the four are the
   * timbres of a single voice rather than four voices, so a chord cannot be
   * represented. What arrives is one line, and the status says what was given
   * up to make it.
   */
  const onMidi = async (): Promise<void> => {
    const file = await pickMidi();
    if (!file) return setStatus('import cancelled');

    setStatus('reading the file…');
    try {
      // In Notes mode a MIDI file lands as notes and octaves, which is what it
      // is. In Hertz mode it lands as a frequency line, as before.
      const midi = await readMidiFile(file, { pitch: pitchMode });
      setLanes(midi.lanes);
      setPaper(null);
      setView(FULL);
      setGlobalSpeed(midi.rate);

      sendControlLanes(midi.lanes);
      client.current!.send({ type: 'globalSpeed', value: midi.rate });

      setStatus(`${file.name}: ${midi.summary}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Load a whole session: from a file, or from the autosave at launch.
   *
   * Pushes the lot to the engine. Nothing else does: the individual editors
   * send their own changes, and none of them fired here. The pitch lanes follow
   * through their own effect once the mode has landed.
   */
  const applySession = (session: Session): void => {
    setLanes(session.lanes);
    setSlides(session.slides);
    // A saved performance is not that sheet any more.
    setPaper(null);
    setGlobalSpeed(session.settings.globalSpeed);
    setVibratoCents(session.settings.vibratoCents);
    setFidelity(session.settings.fidelity);
    setPitchMode(session.settings.pitchMode);
    setMarkMode(session.settings.markMode);
    setTuning({ root: session.settings.root, scale: session.settings.scale });
    setUnison(session.settings.unison);
    setPresets(session.settings.presets);
    setPan(session.settings.pan);
    setVibratoMode(session.settings.vibratoMode);
    setEchoFeedback(session.settings.echoFeedback);
    setReverbSpace(session.settings.reverbSpace);
    setView(FULL);

    const client_ = client.current!;
    sendControlLanes(session.lanes);
    session.slides.forEach((field, i) => client_.sendSlide(i, field));
    client_.send({ type: 'globalSpeed', value: session.settings.globalSpeed });
    client_.send({ type: 'vibratoDepth', cents: session.settings.vibratoCents });
    client_.send({ type: 'fidelity', patch: session.settings.fidelity });
  };

  const onOpen = async (): Promise<void> => {
    try {
      const opened = await openSession(settings());
      if (!opened) return setStatus('open cancelled');
      applySession(opened.session);
      setStatus(`opened ${opened.path}`);
    } catch (err) {
      setStatus(`open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * Start again: blank strips, fresh slides, every setting back to the machine
   * as built. There is no undo, and a session can be half an afternoon's work,
   * so it asks first.
   */
  const onClear = (): void => {
    if (!window.confirm('Clear the sheet and start again? This cannot be undone.')) return;
    applySession({ lanes: makeAllLanes(), slides: freshSlides(), settings: DEFAULT_SETTINGS });
    // Back to the top as well, or the heads carry on from wherever they were.
    client.current!.send({ type: 'transport', playing, rewind: true });
    setStatus('cleared');
  };

  /*
   * Keep the session between launches.
   *
   * Restored once at start, then written a second after the last change and
   * again as the window closes. Nothing is written until the restore has
   * finished, or a fresh blank session would overwrite the one being restored.
   */
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const text = await readAutosave();
        if (text && !cancelled) applySession(decodeSession(text, settings()));
      } catch (err) {
        // A damaged autosave should not stop the app opening.
        console.warn('could not restore the last session', err);
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = useRef<() => string>(() => '');
  current.current = () => encodeSession({ lanes, slides, settings: settings() });

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => writeAutosave(current.current()), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [restored, lanes, slides, globalSpeed, vibratoCents, fidelity, pitchMode, markMode, tuning, unison, presets, pan, vibratoMode, echoFeedback, reverbSpace]);

  useEffect(() => {
    if (!restored) return;
    const onClose = (): void => writeAutosaveNow(current.current());
    window.addEventListener('beforeunload', onClose);
    return () => window.removeEventListener('beforeunload', onClose);
  }, [restored]);

  /** What the offline render needs: the lanes as the engine hears them, and the settings. */
  const bounceInput = (): BounceInput => ({
    lanes: Object.fromEntries(
      LANE_DEFS.map((def) => [
        def.name,
        tonal && def.name === 'pitch'
          ? tonal.note
          : tonal && def.name === 'octave'
            ? tonal.octave
            : lanes[def.name].values,
      ]),
    ),
    slides,
    globalSpeed,
    vibratoCents,
    fidelity,
    pitchMode,
    unison,
    pan,
    vibratoMode,
    echoFeedback,
    reverbSpace,
    durationS: DURATION_S,
  });

  const progress = (what: string) => (fraction: number) =>
    setStatus(`${what} ${Math.round(fraction * 100)}%`);

  const onExportWav = async (): Promise<void> => {
    setStatus('rendering…');
    try {
      const { path, truncated } = await exportWav(bounceInput(), progress('rendering'));
      setStatus(
        !path
          ? 'cancelled'
          : truncated
            ? `saved ${path}. The transport strip stopped the sheet, so it was cut at ten minutes`
            : `saved ${path}`,
      );
    } catch (err) {
      setStatus(`render failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onExportMidi = async (): Promise<void> => {
    setStatus('rendering…');
    try {
      const { path, notes } = await exportMidi(bounceInput(), progress('rendering'));
      setStatus(path ? `saved ${path}: ${notes} notes` : 'cancelled');
    } catch (err) {
      setStatus(`MIDI export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /*
   * Menu commands.
   *
   * Held in a ref rather than resubscribed, because the handlers close over the
   * lanes and slides and would otherwise tear down and rebuild the listener on
   * every stroke. The ref is rewritten each render, so a command always reaches
   * the current one.
   */
  const commands = useRef<Record<ShellCommand, () => void>>(null!);
  commands.current = {
    open: () => void onOpen(),
    save: () => void onSave(),
    'export-pdf': () => void onExport(),
    'export-blank': () => void onBlank(),
    'import-scan': () => void onScan(),
    'import-midi': () => void onMidi(),
    'zoom-in': () => setView((v) => zoomAt(v, 0.5, 0.5)),
    'zoom-out': () => setView((v) => zoomAt(v, 0.5, 2)),
    'zoom-fit': () => setView(FULL),
    theme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    'pitch-mode': () => setPitchMode((m) => (m === 'hertz' ? 'notes' : 'hertz')),
    'mark-mode': () => setMarkMode((m) => (m === 'dots' ? 'lines' : 'dots')),
    'play-stop': () => void togglePlay(),
    'export-wav': () => void onExportWav(),
    'export-midi': () => void onExportMidi(),
    'projector-ready': () => postAll.current(),
    clear: () => onClear(),
  };

  useEffect(() => window.oramics?.onCommand((command) => commands.current[command]?.()), []);

  /*
   * Space plays and stops.
   *
   * Handled here rather than as a menu accelerator, which would take the space
   * bar away from the key and scale pickers while they are open. Anything that
   * takes typing keeps it; everything else hands it over, including a focused
   * button, which would otherwise be pressed again by the same key.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('select, textarea, input[type="text"], input[type="number"]')
      ) {
        return;
      }
      event.preventDefault();
      commands.current['play-stop']();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <strong>DAPHNE</strong>
          <span className="muted">30.000 s · 1 cm = 1 s</span>
        </div>

        <div className="controls">
          <button className={playing ? 'primary on' : 'primary'} onClick={togglePlay}>
            {playing ? 'Stop' : 'Play'}
          </button>
          <button onClick={rewind}>Rewind</button>

          <label>
            Speed
            <input
              type="range"
              min={0.1}
              max={3}
              step={0.01}
              value={globalSpeed}
              onChange={(e) => {
                const v = Number(e.target.value);
                setGlobalSpeed(v);
                client.current!.send({ type: 'globalSpeed', value: v });
              }}
            />
            <span className="value">{globalSpeed.toFixed(2)}x</span>
          </label>

          {delay ? (
            <label title="How much of the echo goes back round">
              Feedback
              <input
                type="range"
                min={0}
                max={0.95}
                step={0.01}
                value={echoFeedback}
                onChange={(e) => setEchoFeedback(Number(e.target.value))}
              />
              <span className="value">{Math.round(echoFeedback * 100)}%</span>
            </label>
          ) : (
            <label>
              Vibrato
              <input
                type="range"
                min={0}
                max={400}
                step={1}
                value={vibratoCents}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVibratoCents(v);
                  client.current!.send({ type: 'vibratoDepth', cents: v });
                }}
              />
              <span className="value">{vibratoCents}¢</span>
            </label>
          )}

          <span className="readout">{hz > 0 ? `${hz.toFixed(hz < 100 ? 1 : 0)} Hz` : '—'}</span>
        </div>

        <div className="controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={erasing}
              onChange={(e) => setErasing(e.target.checked)}
            />
            Erase
          </label>
          <button
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title="Switch between light and dark"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          {(paper || tonal) && (
            <label className="toggle" title="Show what the machine reads from the marks">
              <input
                type="checkbox"
                checked={showReading}
                onChange={(e) => setShowReading(e.target.checked)}
              />
              Reading
            </label>
          )}
          <button onClick={onClear} title="Blank strips and fresh slides (⌘N)">
            Clear
          </button>
          <button onClick={onOpen}>Open</button>
          <button onClick={onSave}>Save</button>
          <MenuButton
            label="Import"
            items={[
              { label: 'Scan or photo…', title: 'Read a photo or scan of a printed sheet', onSelect: () => void onScan() },
              { label: 'MIDI file…', title: 'Read a MIDI file onto the strips', onSelect: () => void onMidi() },
            ]}
          />
          <MenuButton
            label="Export"
            items={[
              { label: 'Audio (WAV)…', title: 'Render one pass of the sheet', onSelect: () => void onExportWav() },
              { label: 'MIDI…', title: 'Render the sheet and write what it played', onSelect: () => void onExportMidi() },
              { label: 'Sheet (PDF)…', title: 'This drawing, printed on the sheet', onSelect: () => void onExport() },
              { label: 'Blank sheet (PDF)…', title: 'A sheet with nothing on it, to hand out', onSelect: () => void onBlank() },
            ]}
          />
          <button onClick={() => window.oramics?.toggleProjector()}>Projector</button>
        </div>
      </header>

      <section className="fidelity">
        <span className="muted">Fidelity</span>
        {(
          [
            ['servoScanner', 'Flying-spot scanner'],
            ['linearPitchScale', 'Pitch in Hertz'],
            ['relayLag', 'Relay lag'],
            ['transportLane', 'Transport strip'],
            ['integerHzPitch', 'Whole-Hertz pitch'],
            ['opticalAmplitude', 'Optical amplitude'],
            ['monoSum', 'Mono'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="toggle">
            <input
              type="checkbox"
              checked={fidelity[key]}
              onChange={(e) => patchFidelity({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        {status && <span className="status">{status}</span>}
      </section>

      <main className="lanes">
        <div className="timeline">
          <Ruler
            view={view}
            onViewChange={setView}
            duration={DURATION_S}
            head={heads.pitch ?? null}
            theme={theme}
          />
          <span className="zoom" title="Pinch, or hold ⌘ and scroll over a lane. Shift-scroll to move along, or drag the ruler.">
            <button
              onClick={() => setView((v) => zoomAt(v, 0.5, 2))}
              disabled={view.to - view.from >= 1}
            >
              −
            </button>
            <span className="value">{((view.to - view.from) * DURATION_S).toFixed(1)} s</span>
            <button onClick={() => setView((v) => zoomAt(v, 0.5, 0.5))}>+</button>
            <button onClick={() => setView(FULL)} disabled={view.to - view.from >= 1}>
              Fit
            </button>
          </span>
        </div>
        {LANE_DEFS.filter((def) => !def.notesOnly || tonal).map((def) => {
          const notes = tonal !== null && PITCH_LANES.has(def.name);
          const isNote = notes && def.name === 'pitch';
          return (
            <div className="lane" key={def.name}>
              <div className="lane-label">
                <strong>
                  {isNote ? 'Note' : def.name === 'vibrato' && delay ? 'Delay' : def.label}
                </strong>
                <span className="muted small">
                  {notes
                    ? `one row per ${isNote ? 'note' : 'octave'}`
                    : def.name === 'vibrato' && delay
                      ? `height = echo time, ${Math.round(echoSeconds(0) * 1000)} ms to ${echoSeconds(1).toFixed(1)} s`
                      : def.hint}
                </span>
                {def.pending && <span className="pending">not yet wired</span>}
                {def.name === 'vibrato' && (
                  <div className="lane-tools">
                    <div className="segmented" role="group" aria-label="What this strip drives">
                      <button
                        className={delay ? '' : 'on'}
                        onClick={() => setVibratoMode('vibrato')}
                        title="Strip 8 as built: height bends the pitch either side of the centre"
                      >
                        Vibrato
                      </button>
                      <button
                        className={delay ? 'on' : ''}
                        onClick={() => setVibratoMode('delay')}
                        title="The same line as an echo time. Not on the machine"
                      >
                        Delay
                      </button>
                    </div>
                  </div>
                )}
                {def.name === 'reverb' && (
                  <div className="lane-tools">
                    <div className="segmented" role="group" aria-label="Reverb space">
                      <button
                        className={reverbSpace === 'plate' ? 'on' : ''}
                        onClick={() => setReverbSpace('plate')}
                        title="A steel plate, the likeliest thing the send reached"
                      >
                        Plate
                      </button>
                      <button
                        className={reverbSpace === 'room' ? 'on' : ''}
                        onClick={() => setReverbSpace('room')}
                        title="A small room: early reflections and a short tail"
                      >
                        Room
                      </button>
                    </div>
                  </div>
                )}
                {def.name === 'pitch' && (
                  <div className="pitch-tools">
                    <div className="segmented" role="group" aria-label="Pitch mode">
                      <button
                        className={pitchMode === 'hertz' ? 'on' : ''}
                        onClick={() => setPitchMode('hertz')}
                        title="One line, height is the frequency (⇧⌘H)"
                      >
                        Hertz
                      </button>
                      <button
                        className={pitchMode === 'notes' ? 'on' : ''}
                        onClick={() => setPitchMode('notes')}
                        title="A note band and an octave band (⇧⌘H)"
                      >
                        Notes
                      </button>
                    </div>
                    {tonal && (
                      <>
                        <div className="segmented" role="group" aria-label="Marks">
                          <button
                            className={markMode === 'dots' ? 'on' : ''}
                            onClick={() => setMarkMode('dots')}
                            title="Each mark sets a note that holds until the next (⇧⌘L)"
                          >
                            Dots
                          </button>
                          <button
                            className={markMode === 'lines' ? 'on' : ''}
                            onClick={() => setMarkMode('lines')}
                            title="The note follows the line as it moves (⇧⌘L)"
                          >
                            Lines
                          </button>
                        </div>
                        <label className="small">
                          Key
                          <select
                            value={tuning.root}
                            onChange={(e) => setTuning((t) => ({ ...t, root: Number(e.target.value) }))}
                          >
                            {NOTE_NAMES.map((name, i) => (
                              <option key={name} value={i}>
                                {name}
                              </option>
                            ))}
                          </select>
                          <select
                            value={tuning.scale}
                            onChange={(e) => setTuning((t) => ({ ...t, scale: e.target.value }))}
                          >
                            {SCALES.map((scale) => (
                              <option key={scale.id} value={scale.id}>
                                {scale.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                )}
              </div>
              <DrawPad
                track={lanes[def.name]}
                onChange={(t) => updateLane(def.name, t)}
                head={heads[def.name] ?? null}
                bipolar={def.bipolar && !(def.name === 'vibrato' && delay)}
                fill={
                  (def.name === 'vibrato' && delay) || (!def.bipolar && !PITCH_LANES.has(def.name))
                }
                guides={
                  notes
                    ? []
                    : def.name === 'pitch'
                      ? [0.11, 0.22, 0.44, 0.88]
                      : def.name === 'vibrato' && delay
                        ? ECHO_GUIDES
                        : [0.5]
                }
                rows={
                  !notes
                    ? null
                    : isNote
                      ? {
                          count: NOTE_ROWS,
                          labels: NOTE_NAMES,
                          // Chromatic shades the sharps, like a keyboard. With a
                          // scale chosen it shades the notes outside it instead,
                          // so the rows you can land on read at a glance.
                          shaded: (r) =>
                            tuning.scale === 'chromatic' ? SHARP_ROWS.has(r) : !inScale(r, tuning),
                        }
                      : { count: OCTAVE_ROWS, labels: OCTAVE_LABELS }
                }
                reading={notes ? (isNote ? tonal.note : tonal.octave) : null}
                markMode={notes ? markMode : 'lines'}
                erasing={erasing}
                theme={theme}
                backdrop={paper?.[def.name] ?? null}
                showReading={showReading}
                view={view}
                onViewChange={setView}
                duration={DURATION_S}
                height={Math.round((isNote ? 3.2 : def.weight) * 46)}
              />
            </div>
          );
        })}
      </main>

      <section className="timbres">
        <div className="timbres-head">
          <span className="muted">
            Each slide is one cycle of the wave. The spot rides the <em>top edge</em>; a gap
            drops the spot, and a second ribbon gives the loop something to jump to.
          </span>
          <div className="slide-tools">
            <label title="Spectral tilt of the generated stroke">
              Round
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={character}
                onChange={(e) => setCharacter(Number(e.target.value))}
              />
              Spiky
            </label>
            <label title="How often gaps and stacked ribbons appear">
              Calm
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={wildness}
                onChange={(e) => setWildness(Number(e.target.value))}
              />
              Wild
            </label>
            <button onClick={randomiseAll}>Randomise all</button>
          </div>
        </div>
        <div className="timbres-grid">
          {slides.map((field, i) => (
            <div className="timbre" key={i}>
              <div className="lane-label">
                <strong>Timbre {i + 1}</strong>
                <label
                  className={fidelity.monoSum ? 'pan muted-control' : 'pan'}
                  title={
                    fidelity.monoSum
                      ? 'Pan. Mono is on, so this is not heard yet; moving it turns Mono off. Double-click to centre.'
                      : `Pan: ${panLabel(pan[i]!)}. Double-click to centre.`
                  }
                >
                  L
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.05}
                    value={pan[i]}
                    aria-label={`Pan timbre ${i + 1}`}
                    onChange={(e) => panTimbre(i, Number(e.target.value))}
                    onDoubleClick={() => panTimbre(i, 0)}
                  />
                  R
                </label>
                <select
                  className="preset"
                  value={presets[i]}
                  title={`A starting shape for timbre ${i + 1}`}
                  onChange={(e) => applyPreset(i, e.target.value)}
                >
                  <option value="" disabled>
                    Preset
                  </option>
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button
                  className="dice"
                  title={`Randomise timbre ${i + 1}`}
                  onClick={() => {
                    randomiseSlide(i);
                    setPreset(i, '');
                  }}
                >
                  Randomise
                </button>
              </div>
              <div className="timbre-pad">
                <PaintPad
                  field={field}
                  width={SLIDE_WIDTH}
                  height={SLIDE_HEIGHT}
                  onChange={(f) => {
                    updateSlide(i, f);
                    setPreset(i, '');
                  }}
                  erasing={erasing}
                  theme={theme}
                  displayHeight={124}
                  ghosts={ghosts[i]!}
                />
                {/* On the slide rather than in the header, so it cannot push the
                    slide down when it appears. */}
                {unison[i]!.voices > 1 && (
                  <button
                    className="unison-tag"
                    title="Detuned copies of this timbre, drawn as the orange echoes. Click to go back to one voice."
                    onClick={() => setTimbreUnison(i, NO_UNISON)}
                  >
                    ×{unison[i]!.voices} ±{unison[i]!.cents}¢ ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

