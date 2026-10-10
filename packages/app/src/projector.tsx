/**
 * The projector view. Pure display — it holds no state, owns no audio, and
 * simply renders whatever the editor window broadcasts. That keeps a single
 * AudioContext in the app no matter how many windows are open.
 */

import { StrictMode, useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

import { NOTE_ROWS, OCTAVE_ROWS, type PitchMode } from '@oramics/engine';

import { LANE_DEFS, type LaneTrack } from './lanes.js';
import { NOTE_NAMES } from './music.js';
import { openProjectorLink } from './projectorLink.js';
import { eachRun } from './ui/runs.js';
import './ui/styles.css';

/** Seconds the sheet represents, as in the editor. */
const DURATION_S = 30;

/** The projector is always dark: it is pointed at a wall in a dim room. */
const INK = {
  page: '#08070a',
  band: '#15141a',
  shaded: '#1d1b23',
  grid: '#232029',
  gridStrong: '#343040',
  mark: '#f4f1ea',
  accent: '#ff7a4d',
  name: '#8a8498',
  faint: '#575265',
} as const;

interface Frame {
  lanes: Record<string, LaneTrack>;
  pitchMode: PitchMode;
  reading: { pitch: Float32Array; octave: Float32Array } | null;
  shaded: number[];
  heads: Record<string, number>;
  hz: number;
  playing: boolean;
}

const Projector = (): JSX.Element => {
  const [frame, setFrame] = useState<Frame | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Lanes and transport arrive separately; merge them into one view state.
    return openProjectorLink((msg) => {
      if (msg.kind === 'hello') return;
      setFrame((prev) => {
        const base: Frame = prev ?? {
          lanes: {},
          pitchMode: 'hertz',
          reading: null,
          shaded: [],
          heads: {},
          hz: 0,
          playing: false,
        };
        return msg.kind === 'lanes'
          ? { ...base, lanes: msg.lanes, pitchMode: msg.pitchMode, reading: msg.reading, shaded: msg.shaded }
          : { ...base, heads: msg.heads, hz: msg.hz, playing: msg.playing };
      });
    });
  }, []);

  /*
   * One painting pass, called on every new frame and whenever the window
   * changes size. Resizing used to leave the canvas at its old pixel size and
   * let CSS stretch it, which smeared the type across the glass.
   */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = INK.page;
    ctx.fillRect(0, 0, w, h);

    const notes = frame.pitchMode === 'notes';
    // The same lanes the editor shows: the octave band only exists in Notes mode.
    const defs = LANE_DEFS.filter((d) => !d.notesOnly || notes);
    const weightOf = (d: (typeof defs)[number]): number => (notes && d.name === 'pitch' ? 3.2 : d.weight);
    const totalWeight = defs.reduce((s, d) => s + weightOf(d), 0);

    /*
     * A gutter for the names, so nothing is printed over the drawing. Across a
     * room the label matters as much as the line does, and at the old size it
     * sat on top of the amplitude it was naming.
     */
    const pad = Math.max(10, Math.round(h * 0.015));
    const ruler = Math.max(22, Math.round(h * 0.035));
    const gap = Math.max(6, Math.round(h * 0.012));
    const usable = h - pad * 2 - ruler - gap * (defs.length - 1);

    /*
     * The gutter is as wide as the longest name needs, within reason, and the
     * type shrinks if even that is not enough. REVERBERATION is the long one,
     * and on a narrow window it used to run out of its gutter and under the
     * bands.
     */
    const names = defs.map((d) =>
      (notes && d.name === 'pitch' ? 'Note' : d.label).toUpperCase(),
    );
    let nameSize = Math.max(11, Math.min(19, h * 0.022));
    const widest = (): number => {
      ctx.font = `600 ${nameSize}px ui-sans-serif, system-ui, sans-serif`;
      return Math.max(...names.map((n) => ctx.measureText(n).width));
    };
    const maxGutter = Math.max(70, w * 0.2);
    while (nameSize > 9 && widest() + pad + 12 > maxGutter) nameSize -= 1;
    const gutter = Math.min(maxGutter, widest() + pad + 12);
    const fieldX = gutter;
    const fieldW = w - gutter - pad;

    const atX = (t: number): number => fieldX + fieldW * t;
    let y = pad;

    for (const def of defs) {
      const bandH = (weightOf(def) / totalWeight) * usable;
      const track = frame.lanes[def.name];
      const rows = !notes ? 0 : def.name === 'pitch' ? NOTE_ROWS : def.name === 'octave' ? OCTAVE_ROWS : 0;

      // The band itself, as a panel with a hairline rather than a bare block.
      ctx.fillStyle = INK.band;
      ctx.beginPath();
      ctx.roundRect(fieldX, y, fieldW, bandH, 4);
      ctx.fill();

      if (rows) {
        const rowH = bandH / rows;
        for (let r = 0; r < rows; r++) {
          const top = y + bandH - (r + 1) * rowH;
          if (def.name === 'pitch' && frame.shaded.includes(r)) {
            ctx.fillStyle = INK.shaded;
            ctx.fillRect(fieldX, top, fieldW, rowH);
          }
          if (rowH > 11) {
            ctx.fillStyle = INK.faint;
            ctx.font = `${Math.max(9, Math.min(13, rowH * 0.62))}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'right';
            ctx.fillText(
              def.name === 'pitch' ? NOTE_NAMES[r]! : String(r + 1),
              fieldX + fieldW - 6,
              top + rowH / 2,
            );
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
          }
        }
      }

      // A line a second, heavier every fifth, as the printed sheet rules it.
      for (let sec = 1; sec < DURATION_S; sec++) {
        ctx.strokeStyle = sec % 5 === 0 ? INK.gridStrong : INK.grid;
        ctx.lineWidth = 1;
        const x = Math.round(atX(sec / DURATION_S)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y + 1);
        ctx.lineTo(x, y + bandH - 1);
        ctx.stroke();
      }

      if (track) {
        // Same run splitting as the editor pad, so the two windows show the
        // same drawing. Feeding the whole array to one path put a line through
        // every blank stretch and joined marks that have nothing to do with
        // each other.
        const { values } = track;
        const n = values.length;
        ctx.strokeStyle = INK.mark;
        ctx.lineWidth = Math.max(2, Math.min(5, bandH * 0.055));
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        eachRun({ values, strokes: track.strokes }, (from, to) => {
          ctx.beginPath();
          for (let i = from; i <= to; i++) {
            const px = atX(i / (n - 1));
            const py = y + bandH * (1 - Math.max(0, Math.min(1, values[i]!)));
            if (i === from) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          if (from === to) ctx.lineTo(atX(from / (n - 1)) + 0.01, y + bandH * (1 - values[from]!));
          ctx.stroke();
        });
      }

      // What plays, as a staircase over the marks, the same as the editor.
      const reading = !frame.reading
        ? null
        : def.name === 'pitch'
          ? frame.reading.pitch
          : def.name === 'octave'
            ? frame.reading.octave
            : null;
      if (reading) {
        const n = reading.length;
        ctx.strokeStyle = INK.accent;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        let held = Number.NaN;
        for (let i = 0; i < n; i++) {
          const v = reading[i]!;
          if (!Number.isFinite(v)) continue;
          const px = atX(i / (n - 1));
          const py = y + bandH * (1 - v);
          if (!Number.isFinite(held)) ctx.moveTo(px, py);
          else if (v !== held) {
            ctx.lineTo(px, y + bandH * (1 - held));
            ctx.lineTo(px, py);
          }
          held = v;
        }
        if (Number.isFinite(held)) ctx.lineTo(atX(1), y + bandH * (1 - held));
        ctx.stroke();
      }

      // The name, in the gutter, right-aligned against its band.
      ctx.fillStyle = INK.name;
      ctx.font = `600 ${nameSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        (notes && def.name === 'pitch' ? 'Note' : def.label).toUpperCase(),
        gutter - 12,
        y + bandH / 2,
      );
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      const head = frame.heads[def.name];
      if (head !== undefined) {
        ctx.strokeStyle = INK.accent;
        ctx.lineWidth = 2;
        const x = Math.round(atX(head)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + bandH);
        ctx.stroke();
      }

      y += bandH + gap;
    }

    /*
     * The ruler, under the bands: the same seconds the sheet is printed with,
     * so a room watching this and a person holding the paper are looking at the
     * same thirty seconds.
     */
    const rulerY = h - pad - ruler + 4;
    ctx.strokeStyle = INK.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(fieldX, rulerY + 0.5);
    ctx.lineTo(fieldX + fieldW, rulerY + 0.5);
    ctx.stroke();
    ctx.fillStyle = INK.faint;
    ctx.font = `${Math.max(10, Math.min(14, h * 0.016))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (let sec = 0; sec <= DURATION_S; sec += 5) {
      const x = atX(sec / DURATION_S);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, rulerY);
      ctx.lineTo(Math.round(x) + 0.5, rulerY + 5);
      ctx.stroke();
      // The first and last labels sit inside the field rather than hanging off
      // the end of it.
      ctx.textAlign = sec === 0 ? 'left' : sec === DURATION_S ? 'right' : 'center';
      ctx.fillText(String(sec), x, rulerY + 17);
    }
    ctx.textAlign = 'left';

    // Where the head is, and what it is sounding, large enough to read across
    // a room.
    const head = frame.heads.pitch ?? 0;
    ctx.fillStyle = INK.name;
    ctx.font = `600 ${Math.max(13, Math.min(20, h * 0.024))}px ui-monospace, monospace`;
    ctx.fillText(`${(head * DURATION_S).toFixed(1)} s`, pad, h - pad - 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = frame.playing ? INK.accent : INK.name;
    ctx.fillText(frame.hz > 0 ? `${frame.hz.toFixed(0)} Hz` : '—', w - pad, h - pad - 2);
    ctx.textAlign = 'left';
  }, [frame]);

  useEffect(() => {
    paint();
  }, [paint]);

  // Repaint when the window changes size, rather than letting the old picture
  // be stretched into the new shape.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);

  return (
    <div className="projector">
      <canvas ref={canvasRef} />
      {!frame && <p className="waiting">Waiting for the editor window…</p>}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Projector />
  </StrictMode>,
);
