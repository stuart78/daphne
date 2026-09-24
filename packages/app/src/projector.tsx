/**
 * The projector view. Pure display — it holds no state, owns no audio, and
 * simply renders whatever the editor window broadcasts. That keeps a single
 * AudioContext in the app no matter how many windows are open.
 */

import { StrictMode, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

import { NOTE_ROWS, OCTAVE_ROWS, type PitchMode } from '@oramics/engine';

import { LANE_DEFS, type LaneTrack } from './lanes.js';
import { NOTE_NAMES } from './music.js';
import { openProjectorLink } from './projectorLink.js';
import { eachRun } from './ui/runs.js';
import './ui/styles.css';

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0a090c';
    ctx.fillRect(0, 0, w, h);

    const notes = frame.pitchMode === 'notes';
    // The same lanes the editor shows: the octave band only exists in Notes mode.
    const defs = LANE_DEFS.filter((d) => !d.notesOnly || notes);
    const weightOf = (d: (typeof defs)[number]): number => (notes && d.name === 'pitch' ? 3.2 : d.weight);
    const totalWeight = defs.reduce((s, d) => s + weightOf(d), 0);
    const gap = 10;
    const usable = h - gap * (defs.length - 1) - 40;
    let y = 20;

    for (const def of defs) {
      const bandH = (weightOf(def) / totalWeight) * usable;
      const track = frame.lanes[def.name];
      const rows = !notes ? 0 : def.name === 'pitch' ? NOTE_ROWS : def.name === 'octave' ? OCTAVE_ROWS : 0;

      ctx.fillStyle = '#141317';
      ctx.fillRect(0, y, w, bandH);

      if (rows) {
        const rowH = bandH / rows;
        for (let r = 0; r < rows; r++) {
          const top = y + bandH - (r + 1) * rowH;
          if (def.name === 'pitch' && frame.shaded.includes(r)) {
            ctx.fillStyle = '#1d1b22';
            ctx.fillRect(0, top, w, rowH);
          }
          ctx.fillStyle = '#4a4653';
          ctx.font = `${Math.max(9, Math.min(14, rowH * 0.7))}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textBaseline = 'middle';
          const label = def.name === 'pitch' ? NOTE_NAMES[r]! : String(r + 1);
          ctx.textAlign = 'right';
          ctx.fillText(label, w - 8, top + rowH / 2);
          ctx.textAlign = 'left';
        }
        ctx.textBaseline = 'alphabetic';
      }

      ctx.strokeStyle = '#26242c';
      ctx.lineWidth = 1;
      for (let s = 1; s < 30; s++) {
        const x = Math.round((w * s) / 30) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + bandH);
        ctx.stroke();
      }

      if (track) {
        // Same run splitting as the editor pad, so the two windows show the
        // same drawing. Feeding the whole array to one path put a line through
        // every blank stretch and joined marks that have nothing to do with
        // each other.
        const { values } = track;
        const n = values.length;
        ctx.strokeStyle = '#f2eee6';
        ctx.lineWidth = 3.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        eachRun({ values, strokes: track.strokes }, (from, to) => {
          ctx.beginPath();
          for (let i = from; i <= to; i++) {
            const px = (i / (n - 1)) * w;
            const py = y + bandH * (1 - Math.max(0, Math.min(1, values[i]!)));
            if (i === from) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          if (from === to) ctx.lineTo((from / (n - 1)) * w + 0.01, y + bandH * (1 - values[from]!));
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
        ctx.strokeStyle = '#ff7a4d';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        let held = Number.NaN;
        for (let i = 0; i < n; i++) {
          const v = reading[i]!;
          if (!Number.isFinite(v)) continue;
          const px = (i / (n - 1)) * w;
          const py = y + bandH * (1 - v);
          if (!Number.isFinite(held)) ctx.moveTo(px, py);
          else if (v !== held) {
            ctx.lineTo(px, y + bandH * (1 - held));
            ctx.lineTo(px, py);
          }
          held = v;
        }
        if (Number.isFinite(held)) ctx.lineTo(w, y + bandH * (1 - held));
        ctx.stroke();
      }

      ctx.fillStyle = '#6d6878';
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText((notes && def.name === 'pitch' ? 'Note' : def.label).toUpperCase(), 10, y + 16);

      const head = frame.heads[def.name];
      if (head !== undefined) {
        ctx.strokeStyle = '#ff7a4d';
        ctx.lineWidth = 2;
        const x = Math.round(head * w) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + bandH);
        ctx.stroke();
      }

      y += bandH + gap;
    }

    ctx.fillStyle = '#9a94a8';
    ctx.font = '600 15px ui-monospace, monospace';
    ctx.fillText(frame.hz > 0 ? `${frame.hz.toFixed(0)} Hz` : '—', 10, h - 12);
  }, [frame]);

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
