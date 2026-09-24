/**
 * A drawable lane. Pointer input writes straight into a Float32Array of
 * normalised values, one per column, which is the same shape the extractor will
 * produce from a scanned sheet — so a drawn lane and a scanned lane are
 * indistinguishable downstream.
 *
 * Alongside the values it records which stroke wrote each column. A lane holds
 * one value per column, so drawing over an existing line replaces it; the ids
 * are how the pad knows to show the replacement as a mark of its own instead of
 * splicing it into the line that was there.
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';

import type { LaneTrack } from '../lanes.js';
import { readPadPalette } from './palette.js';
import { eachRun, nextStrokeId } from './runs.js';
import { useViewWheel } from './useViewWheel.js';
import { gridStep, type View } from './view.js';

export interface DrawPadProps {
  track: LaneTrack;
  onChange: (track: LaneTrack) => void;
  /** 0-1 position of the read head, or null to hide it. */
  head?: number | null;
  bipolar?: boolean;
  /** Fill solid below the line, the way Oram painted her film. */
  fill?: boolean;
  height: number;
  /** Horizontal guide lines, as 0-1 positions. */
  guides?: number[];
  /** Wipe columns back to blank instead of drawing on them. */
  erasing?: boolean;
  /** Only a repaint trigger — the colours come from the CSS tokens. */
  theme?: string;
  /**
   * The registered photograph of this band, drawn under everything else.
   *
   * A lane carries one value per column, which is what the machine reads and
   * not what anybody drew. Where a sheet came from paper, the paper is the
   * piece, and hiding it behind our reading of it would be putting words in the
   * creator's mouth.
   */
  backdrop?: ImageBitmap | null;
  /** Draw the extracted line over the paper. */
  showReading?: boolean;
  /**
   * A band of discrete choices rather than a continuous height: twelve notes or
   * eight octaves. Draws the rows and names them at both edges.
   */
  rows?: Rows | null;
  /**
   * What the marks are being read as, one chosen row per column. Drawn over the
   * marks so what you see is what plays: the step from a mark to a note is where
   * a wrong note comes from, and it should be visible rather than guessed at.
   */
  reading?: Float32Array | null;
  /** Dots place a short mark per click; lines draw continuously. */
  markMode?: 'dots' | 'lines';
  /** The slice of the sheet on show. Shared across every lane. */
  view: View;
  onViewChange: (next: View) => void;
  /** Seconds the whole field represents, for the grid. */
  duration: number;
  disabled?: boolean;
}

export interface Rows {
  count: number;
  /** Names, bottom row first. */
  labels: string[];
  /** Rows shaded, like a keyboard's black keys. */
  shaded?: (row: number) => boolean;
  /** Rows that are in play. The rest are dimmed, so a key reads at a glance. */
  active?: (row: number) => boolean;
}

/** Ink weight. Thick enough to read across a room on the projector. */
const INK_WIDTH = 3;

/**
 * Columns a dot covers: 100 ms of the field.
 *
 * Long enough to see at full zoom, short enough that dots placed close together
 * stay separate notes. Only where a dot starts sets its note, so its length is
 * about being visible, not about how long the note lasts.
 */
const DOT_COLUMNS = 10;

/** Radius of the head drawn at the start of a dot, in pixels. */
const DOT_RADIUS = 4.5;

export const DrawPad = ({
  track,
  onChange,
  head = null,
  bipolar = false,
  fill = false,
  height,
  guides = [],
  erasing = false,
  theme = 'dark',
  backdrop = null,
  showReading = true,
  rows = null,
  reading = null,
  markMode = 'lines',
  view,
  onViewChange,
  duration,
  disabled = false,
}: DrawPadProps): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastIndex = useRef<number | null>(null);
  const strokeId = useRef(0);
  // Held in a ref so the render loop always sees the newest arrays without
  // re-subscribing every stroke.
  const trackRef = useRef(track);
  trackRef.current = track;
  const viewRef = useRef(view);
  viewRef.current = view;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pal = readPadPalette();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    const span = view.to - view.from;

    /*
     * The paper first, if there is any.
     *
     * Drawn as the slice the view is showing rather than scaled whole, so it
     * stays registered to the time ruler at every zoom: second 12 on the ruler
     * is second 12 on the photograph.
     */
    if (backdrop) {
      ctx.save();
      ctx.globalAlpha = showReading ? 0.85 : 1;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        backdrop,
        view.from * backdrop.width,
        0,
        Math.max(1, span * backdrop.width),
        backdrop.height,
        0,
        0,
        w,
        h,
      );
      ctx.restore();
    }
    /** Sheet fraction to pixels. */
    const px = (f: number): number => ((f - view.from) / span) * w;

    if (rows) {
      const rowH = h / rows.count;
      for (let r = 0; r < rows.count; r++) {
        const top = h - (r + 1) * rowH;
        if (rows.shaded?.(r)) {
          ctx.fillStyle = pal.grid;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(0, top, w, rowH);
          ctx.globalAlpha = 1;
        }
        if (rows.active && !rows.active(r)) {
          // Out of the key: washed back so the rows you can land on stand out.
          ctx.fillStyle = pal.bg;
          ctx.globalAlpha = 0.6;
          ctx.fillRect(0, top, w, rowH);
          ctx.globalAlpha = 1;
        }
      }
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      for (let r = 1; r < rows.count; r++) {
        const y = Math.round(h - r * rowH) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // Time grid, heavier every fifth line.
    const step = gridStep(duration * span);
    ctx.lineWidth = 1;
    const firstLine = Math.ceil((view.from * duration) / step);
    const lastLine = Math.floor((view.to * duration) / step);
    for (let k = firstLine; k <= lastLine; k++) {
      const seconds = k * step;
      if (seconds <= 0 || seconds >= duration) continue;
      ctx.strokeStyle = k % 5 === 0 ? pal.guide : pal.grid;
      const x = Math.round(px(seconds / duration)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (const g of guides) {
      ctx.strokeStyle = pal.grid;
      const y = Math.round(h * (1 - g)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    if (bipolar) {
      ctx.strokeStyle = pal.guide;
      ctx.lineWidth = 1.5;
      const y = Math.round(h / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const { values, strokes } = trackRef.current;
    const n = values.length;
    const toX = (i: number): number => px(i / (n - 1));
    const toY = (val: number): number => h * (1 - Math.max(0, Math.min(1, val)));

    // Only walk what is on screen, plus a column either side so a run that
    // continues past the edge still leaves the canvas at the right angle.
    const bounds = {
      values,
      strokes,
      from: Math.floor(view.from * (n - 1)) - 1,
      to: Math.ceil(view.to * (n - 1)) + 1,
    };

    if (fill && showReading && !backdrop) {
      ctx.fillStyle = pal.fill;
      eachRun(bounds, (from, to) => {
        if (to <= from) return;
        ctx.beginPath();
        ctx.moveTo(toX(from), h);
        for (let i = from; i <= to; i++) ctx.lineTo(toX(i), toY(values[i]!));
        ctx.lineTo(toX(to), h);
        ctx.closePath();
        ctx.fill();
      });
    }

    if (!showReading) {
      if (head !== null && head >= view.from && head <= view.to) {
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = 1.5;
        const x = Math.round(px(head)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      return;
    }

    // Over paper the reading has to be legible as a separate thing, not as
    // another pencil line among the ones already there.
    ctx.strokeStyle = backdrop ? pal.accent : pal.ink;
    ctx.lineWidth = INK_WIDTH;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    eachRun(bounds, (from, to) => {
      ctx.beginPath();
      if (from === to) {
        // A single touched column still deserves a mark.
        ctx.moveTo(toX(from), toY(values[from]!));
        ctx.lineTo(toX(from) + 0.01, toY(values[from]!));
      } else {
        for (let i = from; i <= to; i++) {
          const y = toY(values[i]!);
          if (i === from) ctx.moveTo(toX(i), y);
          else ctx.lineTo(toX(i), y);
        }
      }
      ctx.stroke();
      // A dot is a point on the paper: the place it starts is the note, so
      // that is where the mark should look heaviest.
      if (markMode === 'dots') {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(toX(from), toY(values[from]!), DOT_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    if (reading && showReading) {
      // Stepped, because a note is a choice between rows: drawn as a staircase
      // it reads as the notes that play, where a smoothed line would suggest a
      // glide that is not there.
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
      ctx.beginPath();
      let open = false;
      const first = Math.max(0, Math.floor(view.from * (n - 1)) - 1);
      const last = Math.min(n - 1, Math.ceil(view.to * (n - 1)) + 1);
      for (let i = first; i <= last; i++) {
        const v = reading[i]!;
        if (!Number.isFinite(v)) {
          open = false;
          continue;
        }
        const x = toX(i);
        const y = toY(v);
        if (!open) {
          ctx.moveTo(x, y);
          open = true;
        } else {
          const prev = reading[i - 1]!;
          if (Number.isFinite(prev) && prev !== v) ctx.lineTo(x, toY(prev));
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      /*
       * The holds, dashed.
       *
       * Blank paper after a mark is not silence: the relays keep the last note
       * until the next mark arrives. Leaving the gap empty would show a rest
       * that is not there.
       */
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let held = Number.NaN;
      let heldFrom = -1;
      for (let i = 0; i <= n; i++) {
        const v = i < n ? reading[i]! : Number.NaN;
        if (Number.isFinite(v)) {
          if (heldFrom >= 0 && i > heldFrom) {
            ctx.moveTo(toX(heldFrom), toY(held));
            ctx.lineTo(toX(i), toY(held));
            ctx.lineTo(toX(i), toY(v));
          }
          held = v;
          heldFrom = -1;
        } else if (Number.isFinite(held) && heldFrom < 0) {
          heldFrom = i - 1;
        }
      }
      if (heldFrom >= 0) {
        ctx.moveTo(toX(heldFrom), toY(held));
        ctx.lineTo(toX(n - 1), toY(held));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (rows) {
      // Named at both edges, so nobody counts rows up from the bottom.
      const rowH = h / rows.count;
      ctx.fillStyle = pal.muted;
      ctx.font = `${Math.max(8, Math.min(11, rowH * 0.8))}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      for (let r = 0; r < rows.count; r++) {
        const y = h - (r + 0.5) * rowH;
        ctx.textAlign = 'left';
        ctx.fillText(rows.labels[r]!, 4, y);
        ctx.textAlign = 'right';
        ctx.fillText(rows.labels[r]!, w - 4, y);
      }
      ctx.textAlign = 'left';
    }

    if (head !== null && head >= view.from && head <= view.to) {
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1.5;
      const x = Math.round(px(head)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, [reading, rows, markMode, backdrop, bipolar, duration, fill, guides, head, showReading, theme, view]);

  useEffect(() => {
    paint();
  }, [paint, track]);

  useEffect(() => {
    const onResize = (): void => paint();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paint]);

  /** Where along the whole sheet a pointer event landed, 0-1. */
  const sheetAt = (clientX: number, rect: DOMRect): number => {
    const local = (clientX - rect.left) / rect.width;
    const { from, to } = viewRef.current;
    return from + local * (to - from);
  };

  const write = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas || disabled) return;
    const rect = canvas.getBoundingClientRect();
    const n = trackRef.current.values.length;
    const index = Math.max(0, Math.min(n - 1, Math.round(sheetAt(event.clientX, rect) * (n - 1))));
    const value = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));

    const values = new Float32Array(trackRef.current.values);
    const strokes = new Int32Array(trackRef.current.strokes);
    const from = lastIndex.current;

    if (erasing) {
      // A wider nib than the pen, so wiping is not fiddly. Scaled to the view,
      // so it stays the same size under the cursor however far you zoom in.
      const span = viewRef.current.to - viewRef.current.from;
      const nib = Math.max(1, Math.round(values.length * 0.008 * span));
      const lo = Math.min(from ?? index, index) - nib;
      const hi = Math.max(from ?? index, index) + nib;
      for (let i = Math.max(0, lo); i <= Math.min(values.length - 1, hi); i++) {
        values[i] = Number.NaN;
        strokes[i] = 0;
      }
    } else if (markMode === 'dots') {
      // One dot per press, placed where the press lands. Dragging does not
      // smear it: a dot means a note starting here, and only its start counts.
      if (from !== null) return;
      const end = Math.min(values.length, index + DOT_COLUMNS);
      for (let i = index; i < end; i++) {
        values[i] = value;
        strokes[i] = strokeId.current;
      }
    } else if (from === null || from === index) {
      values[index] = value;
      strokes[index] = strokeId.current;
    } else {
      // Fill in across a fast drag so one stroke is continuous. Only within
      // the stroke: lifting the pen and starting elsewhere leaves the space
      // between untouched, which is the whole point of drawing in pieces.
      const step = from < index ? 1 : -1;
      const startValue = Number.isFinite(values[from]!) ? values[from]! : value;
      const span = Math.abs(index - from);
      for (let k = 0; k <= span; k++) {
        const i = from + k * step;
        values[i] = startValue + ((value - startValue) * k) / span;
        strokes[i] = strokeId.current;
      }
    }

    lastIndex.current = index;
    const next = { values, strokes };
    trackRef.current = next;
    onChange(next);
  };

  useViewWheel(canvasRef, viewRef, onViewChange);

  return (
    <canvas
      ref={canvasRef}
      className="drawpad"
      style={{ height, opacity: disabled ? 0.45 : 1 }}
      onPointerDown={(e) => {
        if (disabled) return;
        drawing.current = true;
        lastIndex.current = null;
        // A fresh id, so this mark stays separate from whatever it lands on.
        strokeId.current = nextStrokeId(trackRef.current.strokes);
        e.currentTarget.setPointerCapture(e.pointerId);
        write(e);
      }}
      onPointerMove={(e) => {
        if (drawing.current) write(e);
      }}
      onPointerUp={(e) => {
        drawing.current = false;
        lastIndex.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drawing.current = false;
        lastIndex.current = null;
      }}
    />
  );
};
