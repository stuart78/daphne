/**
 * Draws a sheet with pdf-lib. All layout arithmetic is in page-millimetres with
 * a top-left origin; `ctx.Y` converts to PDF's bottom-up points at the last
 * moment.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import qrcode from 'qrcode';

import {
  FIDUCIAL,
  FIDUCIAL_CENTRES,
  FIELD_RIGHT_MM,
  FIELD_X_MM,
  GUTTER_WIDTH_MM,
  MACHINE,
  MACHINE_RULER_Y_MM,
  MACHINE_SLIDES_Y_MM,
  orientationRect,
  NOMINAL_SPEED_MM_PER_S,
  PAGE,
  QR,
  SHEET_DURATION_S,
  SOLO,
  SOLO_FIELD_Y_MM,
  SOLO_HEADER_Y_MM,
  SOLO_INSTRUCTION_Y_MM,
  SOLO_RULER_Y_MM,
  TEXT_LEFT_MM,
  TIME_FIELD_WIDTH_MM,
  machineBands,
  machineFieldRect,
  mmToPt,
  slidePanels,
  soloFieldRect,
  type Band,
  type Rect,
} from './geometry.js';
import { NEUME, PITCH_MARKS, PITCH_MAX_HZ, getRole, type RoleDef } from './roles.js';
import { encodePayload, layoutOf, type SheetPayload } from './payload.js';

// ---------------------------------------------------------------------------
// Ink
// ---------------------------------------------------------------------------

export type GridStyle = 'grey' | 'nonphoto';

interface Palette {
  ink: RGB;
  muted: RGB;
  rail: RGB;
  gridStrong: RGB;
  grid: RGB;
  gridFaint: RGB;
}

const grey = (v: number): RGB => rgb(v, v, v);

/**
 * 'grey' survives photocopying, which is what a workshop actually does to
 * paper. 'nonphoto' prints the grid in the traditional drafting blue so it can
 * be dropped by channel rather than by threshold — better extraction, but only
 * if the sheets go straight from the printer to the scanner.
 */
/*
 * Everything printed inside a drawing area is light on purpose.
 *
 * The importer calibrates its threshold from the corner squares, which are the
 * one thing on the sheet guaranteed to be solid, and counts a mark at about 40%
 * of that. Every rule and frame here prints under a third, so none of them can
 * reach it however the sheet is lit. The frames used to be 85% of solid, and a
 * band's own border read as a line drawn along the top of it for the whole
 * thirty seconds.
 *
 * The fiducials, the QR and the running text stay dark: the first two are what
 * registration and calibration are measured from, and the third is for people.
 */
const palettes: Record<GridStyle, Palette> = {
  grey: {
    ink: grey(0),
    muted: grey(0.42),
    rail: grey(0.66),
    gridStrong: grey(0.74),
    grid: grey(0.84),
    gridFaint: grey(0.92),
  },
  nonphoto: {
    ink: grey(0),
    muted: grey(0.42),
    rail: rgb(0.55, 0.75, 0.86),
    gridStrong: rgb(0.66, 0.83, 0.91),
    grid: rgb(0.76, 0.89, 0.95),
    gridFaint: rgb(0.85, 0.94, 0.97),
  },
};

// ---------------------------------------------------------------------------
// Drawing context
// ---------------------------------------------------------------------------

interface Ctx {
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  pal: Palette;
  /** Flip a top-down millimetre y into a bottom-up PDF point y. */
  Y: (yMm: number) => number;
}

interface LineOpts {
  width?: number;
  color?: RGB;
  dash?: number[];
}

const hLine = (ctx: Ctx, x1: number, x2: number, y: number, o: LineOpts = {}): void => {
  ctx.page.drawLine({
    start: { x: mmToPt(x1), y: ctx.Y(y) },
    end: { x: mmToPt(x2), y: ctx.Y(y) },
    thickness: o.width ?? 0.3,
    color: o.color ?? ctx.pal.grid,
    ...(o.dash ? { dashArray: o.dash.map(mmToPt) } : {}),
  });
};

const vLine = (ctx: Ctx, x: number, y1: number, y2: number, o: LineOpts = {}): void => {
  ctx.page.drawLine({
    start: { x: mmToPt(x), y: ctx.Y(y1) },
    end: { x: mmToPt(x), y: ctx.Y(y2) },
    thickness: o.width ?? 0.3,
    color: o.color ?? ctx.pal.grid,
    ...(o.dash ? { dashArray: o.dash.map(mmToPt) } : {}),
  });
};

type Align = 'left' | 'right' | 'centre';

interface TextOpts {
  size?: number;
  color?: RGB;
  font?: PDFFont;
  align?: Align;
}

/** Draw text with `y` as the text baseline, measured top-down. */
const text = (ctx: Ctx, s: string, x: number, y: number, o: TextOpts = {}): void => {
  const size = o.size ?? 7;
  const font = o.font ?? ctx.regular;
  const wPt = font.widthOfTextAtSize(s, size);
  const xPt =
    o.align === 'right'
      ? mmToPt(x) - wPt
      : o.align === 'centre'
        ? mmToPt(x) - wPt / 2
        : mmToPt(x);
  ctx.page.drawText(s, {
    x: xPt,
    y: ctx.Y(y),
    size,
    font,
    color: o.color ?? ctx.pal.ink,
  });
};

const box = (ctx: Ctx, r: Rect, o: LineOpts = {}): void => {
  ctx.page.drawRectangle({
    x: mmToPt(r.x),
    y: ctx.Y(r.y + r.h),
    width: mmToPt(r.w),
    height: mmToPt(r.h),
    borderWidth: o.width ?? 0.3,
    borderColor: o.color ?? ctx.pal.grid,
  });
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Four solid squares at a known rectangle. Their centroids give the four point
 * correspondences needed for a homography, which is what makes print scale and
 * scan DPI irrelevant to the timing.
 *
 * Orientation is resolved by the QR, whose position in the recovered frame is
 * unambiguous; the printed triangle is a redundant hint for humans stacking
 * paper.
 */
const drawFiducials = (ctx: Ctx): void => {
  const s = FIDUCIAL.sizeMm;
  for (const c of FIDUCIAL_CENTRES) {
    ctx.page.drawRectangle({
      x: mmToPt(c.x - s / 2),
      y: ctx.Y(c.y + s / 2),
      width: mmToPt(s),
      height: mmToPt(s),
      color: ctx.pal.ink,
    });
  }
  // Human-readable "this way up", tucked beside the top-left mark.
  const tl = FIDUCIAL_CENTRES[0];
  ctx.page.drawSvgPath('M 0 7 L 8 7 L 4 0 Z', {
    x: mmToPt(tl.x + 6),
    y: ctx.Y(tl.y - 3),
    color: ctx.pal.ink,
    scale: 0.5,
  });

  // And the same thing for the importer, which cannot read an arrow.
  const mark = orientationRect();
  ctx.page.drawRectangle({
    x: mmToPt(mark.x),
    y: ctx.Y(mark.y + mark.h),
    width: mmToPt(mark.w),
    height: mmToPt(mark.h),
    color: ctx.pal.ink,
  });
};

// ---------------------------------------------------------------------------
// Field renderers
// ---------------------------------------------------------------------------

/** y for a normalised value where 0 is the bottom rail and 1 the top. */
const valueToY = (f: Rect, v: number): number => f.y + f.h * (1 - v);

/** Vertical second lines, shared by every time-based field. */
const drawTimeGrid = (ctx: Ctx, f: Rect): void => {
  const totalSeconds = Math.round(TIME_FIELD_WIDTH_MM / NOMINAL_SPEED_MM_PER_S);
  for (let s = 1; s < totalSeconds; s++) {
    const x = f.x + s * NOMINAL_SPEED_MM_PER_S;
    const fifth = s % 5 === 0;
    vLine(ctx, x, f.y, f.y + f.h, {
      color: fifth ? ctx.pal.grid : ctx.pal.gridFaint,
      width: fifth ? 0.3 : 0.2,
    });
  }
};

const drawRails = (ctx: Ctx, f: Rect): void => {
  hLine(ctx, f.x, f.x + f.w, f.y, { color: ctx.pal.rail, width: 0.7 });
  hLine(ctx, f.x, f.x + f.w, f.y + f.h, { color: ctx.pal.rail, width: 0.7 });
  vLine(ctx, f.x, f.y, f.y + f.h, { color: ctx.pal.rail, width: 0.7 });
  vLine(ctx, f.x + f.w, f.y, f.y + f.h, { color: ctx.pal.rail, width: 0.7 });
};

/** Right-aligned label in the gutter, vertically centred on a gridline. */
const gutterLabel = (ctx: Ctx, s: string, y: number, o: TextOpts = {}): void => {
  text(ctx, s, FIELD_X_MM - 2, y + 0.8, { size: 6, color: ctx.pal.muted, align: 'right', ...o });
};

const drawUnipolarField = (ctx: Ctx, f: Rect, role: RoleDef): void => {
  drawTimeGrid(ctx, f);
  for (let i = 1; i < 10; i++) {
    const y = valueToY(f, i / 10);
    const half = i === 5;
    hLine(ctx, f.x, f.x + f.w, y, {
      color: half ? ctx.pal.grid : ctx.pal.gridFaint,
      width: half ? 0.3 : 0.2,
    });
    gutterLabel(ctx, `${i * 10}`, y);
  }
  drawRails(ctx, f);

  for (const ref of role.referenceLines ?? []) {
    const y = valueToY(f, ref.at);
    hLine(ctx, f.x, f.x + f.w, y, { color: ctx.pal.gridStrong, width: 0.35, dash: [1.5, 1.5] });
    text(ctx, ref.label, f.x + f.w - 1.5, y - 1.2, {
      size: 5.5,
      color: ctx.pal.muted,
      align: 'right',
    });
  }

  const [bottom, top] = role.railLabels ?? ['0', '1'];
  gutterLabel(ctx, bottom, f.y + f.h, { size: 7, color: ctx.pal.ink, font: ctx.bold });
  gutterLabel(ctx, top, f.y, { size: 7, color: ctx.pal.ink, font: ctx.bold });
};

const drawBipolarField = (ctx: Ctx, f: Rect, role: RoleDef): void => {
  drawTimeGrid(ctx, f);
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;
    const y = valueToY(f, i / 8);
    hLine(ctx, f.x, f.x + f.w, y, { color: ctx.pal.gridFaint, width: 0.2 });
    gutterLabel(ctx, `${(i / 4 - 1).toFixed(2)}`, y);
  }
  drawRails(ctx, f);

  const centre = valueToY(f, 0.5);
  hLine(ctx, f.x, f.x + f.w, centre, { color: ctx.pal.rail, width: 0.6 });
  gutterLabel(ctx, 'no bend', centre, { size: 7, color: ctx.pal.ink, font: ctx.bold });

  const [bottom, top] = role.railLabels ?? ['-1', '+1'];
  gutterLabel(ctx, bottom, f.y + f.h, { size: 7, color: ctx.pal.ink, font: ctx.bold });
  gutterLabel(ctx, top, f.y, { size: 7, color: ctx.pal.ink, font: ctx.bold });
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Pitch, on a linear Hertz axis.
 *
 * The machine's relays switched banks of resistors to set the time-base
 * frequency, so the painted number and the frequency are proportional. Drawing
 * on this feels wrong to anyone used to a piano roll — the octaves crowd
 * together at the bottom and sprawl at the top — and that is exactly the point.
 */
const drawLogPitchField = (ctx: Ctx, f: Rect): void => {
  const hzToY = (hz: number): number => f.y + f.h * (1 - hz / PITCH_MAX_HZ);

  drawTimeGrid(ctx, f);

  // Every 50 Hz, heavier every 100 — the units the code is written in.
  for (let hz = 50; hz < PITCH_MAX_HZ; hz += 50) {
    const hundred = hz % 100 === 0;
    hLine(ctx, f.x, f.x + f.w, hzToY(hz), {
      color: hundred ? ctx.pal.grid : ctx.pal.gridFaint,
      width: hundred ? 0.3 : 0.18,
    });
    if (hundred) gutterLabel(ctx, `${hz}`, hzToY(hz));
  }

  // Octaves of A, to show how unevenly they fall on this scale.
  for (const hz of PITCH_MARKS) {
    if (hz > PITCH_MAX_HZ) continue;
    const y = hzToY(hz);
    hLine(ctx, f.x, f.x + f.w, y, { color: ctx.pal.gridStrong, width: 0.4, dash: [2.5, 1.5] });
    text(ctx, `A — ${hz} Hz`, f.x + f.w - 1.5, y - 1.1, {
      size: 5.5,
      color: ctx.pal.muted,
      align: 'right',
    });
  }

  drawRails(ctx, f);
  gutterLabel(ctx, `${PITCH_MAX_HZ} Hz`, f.y, { size: 7, color: ctx.pal.ink, font: ctx.bold });
  gutterLabel(ctx, '0 Hz', f.y + f.h, { size: 7, color: ctx.pal.ink, font: ctx.bold });
};

const drawBcdField = (ctx: Ctx, f: Rect): void => {
  const cols = Math.floor(f.w / NEUME.columnWidthMm);
  const writeInH = 16;
  const gap = 2;
  const rows = NEUME.digits * NEUME.weights.length;
  const rowH = (f.h - writeInH - gap) / rows;
  const gridTop = f.y + writeInH + gap;

  // Write-in row: the frequency in plain decimal, one column per second.
  box(ctx, { x: f.x, y: f.y, w: f.w, h: writeInH }, { color: ctx.pal.rail, width: 0.7 });
  for (let c = 1; c < cols; c++) {
    vLine(ctx, f.x + c * NEUME.columnWidthMm, f.y, f.y + writeInH, {
      color: ctx.pal.grid,
      width: 0.25,
    });
  }
  gutterLabel(ctx, 'Hz', f.y + writeInH / 2 - 0.8, { size: 7.5, font: ctx.bold, color: ctx.pal.ink });

  // Four digit groups of four tracks. The film's lower edge carries the 1, so
  // the weights read 1-2-4-2 upwards — printed top-down here, hence reversed.
  const tracksPerDigit = NEUME.weights.length;
  const digitNames = ['1000s', '100s', '10s', '1s'];
  for (let r = 0; r < rows; r++) {
    const yTop = gridTop + r * rowH;
    const digit = Math.floor(r / tracksPerDigit);
    const bit = r % tracksPerDigit;
    const groupStart = bit === 0;
    const weight = NEUME.weights[tracksPerDigit - 1 - bit]!;

    hLine(ctx, f.x, f.x + f.w, yTop, {
      color: groupStart ? ctx.pal.rail : ctx.pal.grid,
      width: groupStart ? 0.6 : 0.25,
    });
    gutterLabel(ctx, `${digitNames[digit]}  x${weight}`, yTop + rowH / 2 - 0.8, {
      size: 6.5,
      color: groupStart ? ctx.pal.ink : ctx.pal.muted,
      ...(groupStart ? { font: ctx.bold } : {}),
    });
  }
  for (let c = 1; c < cols; c++) {
    vLine(ctx, f.x + c * NEUME.columnWidthMm, gridTop, f.y + f.h, {
      color: ctx.pal.grid,
      width: 0.25,
    });
  }
  box(
    ctx,
    { x: f.x, y: gridTop, w: f.w, h: f.h - writeInH - gap },
    { color: ctx.pal.rail, width: 0.7 },
  );
};

const drawCycleField = (ctx: Ctx, f: Rect): void => {
  // x is phase, not time: twelve 30-degree divisions across the field.
  const divisions = 12;
  for (let i = 1; i < divisions; i++) {
    const x = f.x + (f.w * i) / divisions;
    vLine(ctx, x, f.y, f.y + f.h, {
      color: i === divisions / 2 ? ctx.pal.grid : ctx.pal.gridFaint,
      width: i === divisions / 2 ? 0.3 : 0.2,
    });
  }
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;
    const y = valueToY(f, i / 8);
    hLine(ctx, f.x, f.x + f.w, y, { color: ctx.pal.gridFaint, width: 0.2 });
    gutterLabel(ctx, `${(i / 4 - 1).toFixed(2)}`, y);
  }
  drawRails(ctx, f);

  const centre = valueToY(f, 0.5);
  hLine(ctx, f.x, f.x + f.w, centre, { color: ctx.pal.rail, width: 0.6 });
  gutterLabel(ctx, 'zero', centre, { size: 7, color: ctx.pal.ink, font: ctx.bold });
  gutterLabel(ctx, '+1', f.y, { size: 7, color: ctx.pal.ink, font: ctx.bold });
  gutterLabel(ctx, '-1', f.y + f.h, { size: 7, color: ctx.pal.ink, font: ctx.bold });
};

// ---------------------------------------------------------------------------
// Rulers
// ---------------------------------------------------------------------------

const drawTimeRuler = (
  ctx: Ctx,
  f: Rect,
  yMm: number = SOLO_RULER_Y_MM,
  // The sheet has the timbre strip immediately below the ruler, and the caption
  // wants the same 10 mm of page. It repeats what the header already says.
  caption = true,
): void => {
  const y = yMm;
  hLine(ctx, f.x, f.x + f.w, y, { color: ctx.pal.rail, width: 0.5 });

  // Minor ticks every 2 mm = 200 ms.
  for (let mm = 0; mm <= f.w; mm += 2) {
    if (mm % 10 === 0) continue;
    vLine(ctx, f.x + mm, y, y + 1.6, { color: ctx.pal.muted, width: 0.2 });
  }
  // Major ticks every 10 mm = 1 s.
  const totalSeconds = Math.round(f.w / NOMINAL_SPEED_MM_PER_S);
  for (let s = 0; s <= totalSeconds; s++) {
    const x = f.x + s * NOMINAL_SPEED_MM_PER_S;
    const fifth = s % 5 === 0;
    vLine(ctx, x, y, y + (fifth ? 4 : 2.6), {
      color: ctx.pal.ink,
      width: fifth ? 0.5 : 0.3,
    });
    if (fifth) text(ctx, `${s}`, x, y + 8, { size: 7, align: 'centre', font: ctx.bold });
  }

  text(ctx, 'SECONDS', FIELD_X_MM - 2, y + 4, {
    size: 6,
    align: 'right',
    color: ctx.pal.muted,
    font: ctx.bold,
  });
  if (caption) {
    text(
      ctx,
      `1 cm = 1 s   ·   ${NOMINAL_SPEED_MM_PER_S} mm/s   ·   read head travels this way >`,
      f.x + f.w,
      y + 10.5,
      { size: 5.5, align: 'right', color: ctx.pal.muted },
    );
  }
};

const drawPhaseRuler = (ctx: Ctx, f: Rect): void => {
  const y = SOLO_RULER_Y_MM;
  hLine(ctx, f.x, f.x + f.w, y, { color: ctx.pal.rail, width: 0.5 });
  for (let i = 0; i <= 12; i++) {
    const x = f.x + (f.w * i) / 12;
    vLine(ctx, x, y, y + (i % 3 === 0 ? 4 : 2.6), {
      color: ctx.pal.ink,
      width: i % 3 === 0 ? 0.5 : 0.3,
    });
    if (i % 3 === 0) text(ctx, `${i * 30}`, x, y + 8, { size: 7, align: 'centre', font: ctx.bold });
  }
  text(ctx, 'DEGREES', FIELD_X_MM - 2, y + 4, {
    size: 6,
    align: 'right',
    color: ctx.pal.muted,
    font: ctx.bold,
  });
  text(ctx, 'one complete cycle — not a stretch of time', f.x + f.w, y + 10.5, {
    size: 5.5,
    align: 'right',
    color: ctx.pal.muted,
  });
};

// ---------------------------------------------------------------------------
// Header, footer, QR
// ---------------------------------------------------------------------------

const drawQr = async (ctx: Ctx, payloadText: string, x: number, y: number, sizeMm: number) => {
  // Level Q keeps a creased or coffee-stained sheet readable; the payload is
  // pure uppercase alphanumeric so it stays in QR's dense alnum mode.
  const qr = qrcode.create(payloadText, { errorCorrectionLevel: 'Q' });
  const n = qr.modules.size;
  const cell = sizeMm / n;
  const quiet = cell * QR.quietModules;

  // Quiet zone. Without it phone cameras fail on a busy page. It is opaque, so
  // geometry.ts sizes the block to keep this rectangle off the field border.
  ctx.page.drawRectangle({
    x: mmToPt(x - quiet),
    y: ctx.Y(y + sizeMm + quiet),
    width: mmToPt(sizeMm + quiet * 2),
    height: mmToPt(sizeMm + quiet * 2),
    color: rgb(1, 1, 1),
  });

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!qr.modules.get(row, col)) continue;
      ctx.page.drawRectangle({
        x: mmToPt(x + col * cell),
        y: ctx.Y(y + (row + 1) * cell),
        // Hairline overdraw stops white seams between modules at print scale.
        width: mmToPt(cell) + 0.15,
        height: mmToPt(cell) + 0.15,
        color: ctx.pal.ink,
      });
    }
  }
};

const drawHeader = (ctx: Ctx, role: RoleDef, payload: SheetPayload): void => {
  const y = SOLO_HEADER_Y_MM;

  text(ctx, String(payload.lane).padStart(2, '0'), TEXT_LEFT_MM, y + 12, {
    size: 20,
    font: ctx.bold,
    color: ctx.pal.ink,
  });
  text(ctx, 'LANE', TEXT_LEFT_MM, y + 16.5, { size: 5.5, color: ctx.pal.muted, font: ctx.bold });

  const titleX = TEXT_LEFT_MM + 17;
  text(ctx, role.title.toUpperCase(), titleX, y + 8, { size: 15, font: ctx.bold });
  text(ctx, role.blurb, titleX, y + 13, { size: 7.5, color: ctx.pal.muted });
  if (role.historicalStrip) {
    text(ctx, role.historicalStrip, titleX, y + 17.5, { size: 6, color: ctx.pal.muted });
  }

  // Contributor write-in.
  const nameX = 200;
  const nameW = 105;
  text(ctx, 'DRAWN BY', nameX, y + 5, { size: 5.5, color: ctx.pal.muted, font: ctx.bold });
  hLine(ctx, nameX, nameX + nameW, y + 13, { color: ctx.pal.rail, width: 0.4 });
  text(ctx, 'PIECE', nameX, y + 17.5, { size: 5.5, color: ctx.pal.muted, font: ctx.bold });
  hLine(ctx, nameX + 16, nameX + nameW, y + 18.5, { color: ctx.pal.grid, width: 0.3 });
};

const drawInstructions = (ctx: Ctx, role: RoleDef): void => {
  let y = SOLO_INSTRUCTION_Y_MM + 3.4;
  for (const line of role.instructions) {
    text(ctx, line, TEXT_LEFT_MM, y, { size: 6.4, color: ctx.pal.ink });
    y += 3.2;
  }
};

const drawFooter = (
  ctx: Ctx,
  role: RoleDef | null,
  payload: SheetPayload,
  payloadText: string,
): void => {
  // High enough to clear the printer dead zone; horizontally between the two
  // bottom fiducials, which is why it can sit level with them.
  const y = PAGE.heightMm - 6.4;
  // A waveform slide has no duration — its x axis is phase.
  const extent =
    role?.kind === 'cycle' ? 'one cycle' : `${(payload.durationMs / 1000).toFixed(3)} s`;
  text(
    ctx,
    `ORAMICS  ·  sheet ${payload.sheetId}  ·  lane ${String(payload.lane).padStart(2, '0')}  ·  ` +
      `${payload.role}  ·  ${extent}`,
    TEXT_LEFT_MM,
    y,
    { size: 5.5, color: ctx.pal.muted },
  );
  text(ctx, payloadText, FIELD_RIGHT_MM, y, {
    size: 4.6,
    color: grey(0.66),
    align: 'right',
    font: ctx.mono,
  });
};

// ---------------------------------------------------------------------------
// Combined sheets
// ---------------------------------------------------------------------------

/** Second lines across a band, at whatever height the band happens to be. */
const drawBandTimeGrid = (ctx: Ctx, f: Rect): void => {
  const totalSeconds = Math.round(f.w / NOMINAL_SPEED_MM_PER_S);
  for (let s = 1; s < totalSeconds; s++) {
    const fifth = s % 5 === 0;
    vLine(ctx, f.x + s * NOMINAL_SPEED_MM_PER_S, f.y, f.y + f.h, {
      color: fifth ? ctx.pal.grid : ctx.pal.gridFaint,
      width: fifth ? 0.28 : 0.18,
    });
  }
};

/** Tiny rail annotations placed inside the band, since the gutter holds the name. */
/** Row names for the note band, C at the bottom. */
const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const insideLabel = (ctx: Ctx, s: string, x: number, y: number): void =>
  // Printed at rule weight, not text weight: these sit inside the drawing area,
  // so the importer has to be able to ignore them like any other furniture.
  text(ctx, s, x, y, { size: 4.8, color: ctx.pal.rail });

/**
 * Keep a label's baseline within its band. Without this the topmost octave
 * marker sits above the band and lands in the header text.
 */
const clampToBand = (f: Rect, baseline: number): number =>
  Math.max(f.y + 3.4, Math.min(f.y + f.h - 1.2, baseline));

const drawBand = (ctx: Ctx, band: Band, role: RoleDef): void => {
  const f = band.rect;
  drawBandTimeGrid(ctx, f);

  switch (role.kind) {
    case 'notes':
    case 'octaves': {
      /*
       * One row per choice, printed light enough that the importer never sees
       * it. A mark does not have to sit inside a row: the app snaps to the
       * nearest one, so the grid is a guide for the hand, not a target.
       */
      const notes = role.kind === 'notes';
      const rows = notes ? 12 : 8;
      const rowH = f.h / rows;
      const rowY = (r: number): number => f.y + f.h - (r + 1) * rowH;

      if (notes) {
        // The sharps shaded, as on a keyboard, so C and F can be found without
        // counting up from the bottom.
        for (const r of [1, 3, 6, 8, 10]) {
          ctx.page.drawRectangle({
            x: mmToPt(f.x),
            y: ctx.Y(rowY(r) + rowH),
            width: mmToPt(f.w),
            height: mmToPt(rowH),
            color: grey(0.955),
          });
        }
      }
      for (let r = 1; r < rows; r++) {
        hLine(ctx, f.x, f.x + f.w, f.y + f.h - r * rowH, { color: ctx.pal.gridFaint, width: 0.2 });
      }

      // Labelled on both edges, so nobody has to carry a ruler across the sheet.
      const label = (r: number): string =>
        notes ? NOTE_LABELS[r]! : String(r + 1);
      for (let r = 0; r < rows; r++) {
        const y = rowY(r) + rowH / 2 + 1;
        text(ctx, label(r), f.x + 1.2, y, { size: 4.6, color: ctx.pal.rail });
        text(ctx, label(r), f.x + f.w - 1.2, y, {
          size: 4.6,
          color: ctx.pal.rail,
          align: 'right',
        });
      }
      break;
    }
    case 'logpitch': {
      // Linear in Hertz, like the sheet: the code and the frequency are the
      // same number.
      const hzToY = (hz: number): number => f.y + f.h * (1 - hz / PITCH_MAX_HZ);
      for (let hz = 100; hz < PITCH_MAX_HZ; hz += 100) {
        hLine(ctx, f.x, f.x + f.w, hzToY(hz), { color: ctx.pal.gridFaint, width: 0.2 });
      }
      for (let hz = 200; hz < PITCH_MAX_HZ; hz += 200) {
        insideLabel(ctx, `${hz}`, f.x + 1.2, clampToBand(f, hzToY(hz) - 0.9));
      }
      for (const hz of PITCH_MARKS) {
        if (hz > PITCH_MAX_HZ) continue;
        hLine(ctx, f.x, f.x + f.w, hzToY(hz), {
          color: ctx.pal.gridStrong,
          width: 0.35,
          dash: [2, 1.5],
        });
      }
      break;
    }
    case 'bipolar': {
      const centre = valueToY(f, 0.5);
      hLine(ctx, f.x, f.x + f.w, centre, { color: ctx.pal.rail, width: 0.5 });
      const [bottom, top] = role.railLabels ?? ['-1', '+1'];
      insideLabel(ctx, top, f.x + 1.2, f.y + 3.4);
      insideLabel(ctx, bottom, f.x + 1.2, f.y + f.h - 1.4);
      break;
    }
    default: {
      hLine(ctx, f.x, f.x + f.w, valueToY(f, 0.5), {
        color: ctx.pal.gridFaint,
        width: 0.2,
        dash: [1.5, 1.5],
      });
      for (const ref of role.referenceLines ?? []) {
        if (ref.at !== 0.5) continue; // only the structural one survives at band scale
        hLine(ctx, f.x, f.x + f.w, valueToY(f, ref.at), {
          color: ctx.pal.gridStrong,
          width: 0.4,
          dash: [2, 1.5],
        });
      }
      const [bottom, top] = role.railLabels ?? ['0', '1'];
      insideLabel(ctx, top, f.x + 1.2, f.y + 3.4);
      insideLabel(ctx, bottom, f.x + 1.2, f.y + f.h - 1.4);
      break;
    }
  }

  box(ctx, f, { color: ctx.pal.rail, width: 0.6 });

  // Gutter: what this band is, and the one thing you need to know to draw it.
  const midY = f.y + f.h / 2;
  text(ctx, role.title.replace(' — continuous', '').toUpperCase(), FIELD_X_MM - 2, midY - 0.4, {
    size: 7,
    font: ctx.bold,
    align: 'right',
  });
  text(ctx, role.shortHint, FIELD_X_MM - 2, midY + 3.4, {
    size: 5,
    color: ctx.pal.muted,
    align: 'right',
  });
};

/**
 * Print a drawn contour into a field. Solid black under the line, the way Oram
 * painted her film, so a printed sheet reads the same as a hand-drawn one when
 * it comes back through the scanner.
 */
const drawOverlay = (ctx: Ctx, f: Rect, values: ArrayLike<number>, fill: boolean): void => {
  const n = values.length;
  if (n < 2) return;

  // Split on NaN so undrawn stretches stay blank rather than being bridged.
  let run: Array<{ x: number; y: number }> = [];
  const flush = (): void => {
    if (run.length < 2) {
      run = [];
      return;
    }
    if (fill) {
      // drawSvgPath negates its own y axis relative to the anchor, so the path
      // is built in top-down millimetre-points and anchored at the page top.
      // Converting with ctx.Y first would flip it twice and land it off-page.
      const path =
        `M ${mmToPt(run[0]!.x)} ${mmToPt(f.y + f.h)} ` +
        run.map((p) => `L ${mmToPt(p.x)} ${mmToPt(p.y)}`).join(' ') +
        ` L ${mmToPt(run[run.length - 1]!.x)} ${mmToPt(f.y + f.h)} Z`;
      ctx.page.drawSvgPath(path, {
        // Translucent mid grey rather than solid black. It still reads as an
        // area to the extractor, but rails, gridlines and labels underneath
        // stay visible, and a printed sheet is light enough to draw on again.
        color: grey(0.35),
        opacity: 0.5,
        borderColor: grey(0.08),
        // The top edge is the value, so it has to survive a print and a scan.
        // At 0.9 pt a steep segment anti-aliased away to nothing and the
        // importer read the band as blank there.
        borderWidth: 1.4,
        x: 0,
        y: mmToPt(PAGE.heightMm),
        scale: 1,
      });
    } else {
      for (let i = 1; i < run.length; i++) {
        ctx.page.drawLine({
          start: { x: mmToPt(run[i - 1]!.x), y: ctx.Y(run[i - 1]!.y) },
          end: { x: mmToPt(run[i]!.x), y: ctx.Y(run[i]!.y) },
          thickness: 1.4,
          color: grey(0.08),
        });
      }
    }
    run = [];
  };

  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      flush();
      continue;
    }
    run.push({
      x: f.x + (i / (n - 1)) * f.w,
      y: valueToY(f, Math.max(0, Math.min(1, v))),
    });
  }
  flush();
};

const drawCombinedHeader = (
  ctx: Ctx,
  title: string,
  subtitle: string,
  payload: SheetPayload,
): void => {
  const y = MACHINE.topMarginMm;
  text(ctx, title, TEXT_LEFT_MM, y + 8, { size: 15, font: ctx.bold });
  text(ctx, subtitle, TEXT_LEFT_MM, y + 13, { size: 6.4, color: ctx.pal.muted });

  const nameX = 196;
  text(ctx, 'DRAWN BY', nameX, y + 5, { size: 5.5, color: ctx.pal.muted, font: ctx.bold });
  hLine(ctx, nameX, nameX + 100, y + 9.5, { color: ctx.pal.rail, width: 0.4 });
  text(ctx, 'PIECE', nameX, y + 14, { size: 5.5, color: ctx.pal.muted, font: ctx.bold });
  hLine(ctx, nameX + 16, nameX + 100, y + 14.8, { color: ctx.pal.grid, width: 0.3 });
  void payload;
};

/** The timbre strip: four painted-glass cycles below the time ruler. */
const drawSlideStrip = (ctx: Ctx, overlays: Overlays | undefined): void => {
  gutterLabel(ctx, 'TIMBRES', MACHINE_SLIDES_Y_MM + 4, { font: ctx.bold });
  gutterLabel(ctx, 'one cycle', MACHINE_SLIDES_Y_MM + 8.6, { size: 5 });

  // On its own line above the titles. The strip has no room for a caption
  // beside them, and this is the instruction people most need.
  text(
    ctx,
    'Each panel is ONE CYCLE of a wave, not a stretch of time. Start and end at the same ' +
      'height or you will hear a click once per cycle.',
    FIELD_X_MM,
    MACHINE_SLIDES_Y_MM - 6.5,
    { size: 6, color: ctx.pal.muted },
  );

  slidePanels().forEach((p, i) => {
    for (let d = 1; d < 12; d++) {
      vLine(ctx, p.x + (p.w * d) / 12, p.y, p.y + p.h, {
        color: d === 6 ? ctx.pal.grid : ctx.pal.gridFaint,
        width: d === 6 ? 0.28 : 0.18,
      });
    }
    for (const v of [0.25, 0.75]) {
      hLine(ctx, p.x, p.x + p.w, valueToY(p, v), { color: ctx.pal.gridFaint, width: 0.2 });
    }
    const centre = valueToY(p, 0.5);
    hLine(ctx, p.x, p.x + p.w, centre, { color: ctx.pal.rail, width: 0.5 });

    // Before the border and the labels, so neither ends up underneath it.
    const drawn = overlays?.[`WAV${i + 1}`];
    if (drawn) drawOverlay(ctx, p, drawn, true);

    box(ctx, p, { color: ctx.pal.rail, width: 0.6 });

    // Titles sit above the panel now that the strip is at the foot of the page
    // and there is no header block alongside it to collide with. That keeps the
    // panel itself clear, which matters more at 30 mm than it did at 76.
    text(ctx, `TIMBRE ${i + 1}`, p.x, p.y - 1.6, { size: 7, font: ctx.bold });
    insideLabel(ctx, '+1', p.x + p.w - 5.5, p.y + 3.4);
    insideLabel(ctx, 'zero', p.x + p.w - 7.5, centre - 1);
    insideLabel(ctx, '-1', p.x + p.w - 5.5, p.y + p.h - 1.5);
    text(ctx, '0°', p.x, p.y + p.h + 3.2, { size: 5, color: ctx.pal.muted, align: 'centre' });
    text(ctx, '360°', p.x + p.w, p.y + p.h + 3.2, {
      size: 5,
      color: ctx.pal.muted,
      align: 'centre',
    });
  });

};

/** The sheet. Every time-domain lane as a band, with the four timbres beneath. */
const drawMachineSheet = async (doc: PDFDocument, opts: CombinedOptions): Promise<void> => {
  const ctx = await makeCtx(doc, opts.gridStyle);
  const payloadText = encodePayload(opts.payload);

  const layout = layoutOf(opts.payload);

  drawFiducials(ctx);
  drawCombinedHeader(
    ctx,
    'ORAMICS — ONE PIECE',
    layout === 'TONE'
      ? `Mark a note and an octave, with dots or lines. Draw a line in every other band. ` +
          `${SHEET_DURATION_S.toFixed(0)} seconds, 1 cm = 1 s.`
      : `Draw a line in each band. Height is the value; a blank band is left alone. ` +
          `${SHEET_DURATION_S.toFixed(0)} seconds, 1 cm = 1 s.`,
    opts.payload,
  );

  for (const band of machineBands(layout)) {
    const role = getRole(band.role);
    drawBand(ctx, band, role);
    const drawn = opts.overlays?.[band.role];
    // Amplitude and reverb read as areas; pitch, vibrato and transport are
    // positions and would be unreadable filled to the floor.
    if (drawn) drawOverlay(ctx, band.rect, drawn, role.kind === 'unipolar');
  }

  drawTimeRuler(ctx, { ...machineFieldRect(), h: 0 }, MACHINE_RULER_Y_MM, false);
  drawSlideStrip(ctx, opts.overlays);
  drawFooter(ctx, null, opts.payload, payloadText);
  await drawQr(ctx, payloadText, FIELD_RIGHT_MM - QR.sizeMm, QR.yMm, QR.sizeMm);
};

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

export interface SheetOptions {
  role: RoleDef;
  payload: SheetPayload;
  gridStyle?: GridStyle;
}

/**
 * Drawn contours to print onto the sheet, keyed by role id (`AMP1`, `PCH`, …)
 * or, for the timbre page, by slide index. Values are 0-1 across the field,
 * left to right; NaN means "nothing drawn here" and leaves the paper blank.
 *
 * This is what closes the loop: draw in the app, print the result on the same
 * template, hand it to someone who marks it up by hand, scan it back in.
 */
export type Overlays = Record<string, ArrayLike<number>>;

export interface CombinedOptions {
  payload: SheetPayload;
  gridStyle?: GridStyle;
  overlays?: Overlays;
}

const makeCtx = async (doc: PDFDocument, gridStyle: GridStyle = 'grey'): Promise<Ctx> => {
  const page = doc.addPage([mmToPt(PAGE.widthMm), mmToPt(PAGE.heightMm)]);
  return {
    page,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    pal: palettes[gridStyle],
    Y: (yMm: number) => mmToPt(PAGE.heightMm - yMm),
  };
};

export const drawSheet = async (doc: PDFDocument, opts: SheetOptions): Promise<void> => {
  const ctx = await makeCtx(doc, opts.gridStyle);
  const f = soloFieldRect();
  const { role, payload } = opts;
  const payloadText = encodePayload(payload);

  drawFiducials(ctx);
  drawHeader(ctx, role, payload);

  switch (role.kind) {
    case 'unipolar':
      drawUnipolarField(ctx, f, role);
      break;
    case 'bipolar':
      drawBipolarField(ctx, f, role);
      break;
    case 'logpitch':
      drawLogPitchField(ctx, f);
      break;
    case 'bcd':
      drawBcdField(ctx, f);
      break;
    case 'cycle':
      drawCycleField(ctx, f);
      break;
  }

  if (role.kind === 'cycle') drawPhaseRuler(ctx, f);
  else drawTimeRuler(ctx, f);

  drawInstructions(ctx, role);
  drawFooter(ctx, role, payload, payloadText);
  await drawQr(ctx, payloadText, FIELD_RIGHT_MM - QR.sizeMm, QR.yMm, QR.sizeMm);
};

export type Page =
  | { kind: 'solo'; options: SheetOptions }
  | { kind: 'machine'; options: CombinedOptions };

export interface DocumentOptions {
  pages: Page[];
  title?: string;
}

export const buildDocument = async (opts: DocumentOptions): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title ?? 'Oramics drawing sheets');
  doc.setSubject(
    `Drawing templates for an Oramics-style drawn-sound instrument. ` +
      `Time field ${TIME_FIELD_WIDTH_MM} mm at ${NOMINAL_SPEED_MM_PER_S} mm/s = ` +
      `${SHEET_DURATION_S.toFixed(3)} s. Print at 100% — do not scale to fit.`,
  );
  doc.setCreator('@oramics/template');
  for (const page of opts.pages) {
    if (page.kind === 'solo') await drawSheet(doc, page.options);
    else await drawMachineSheet(doc, page.options);
  }
  return doc.save();
};

export { SOLO, SOLO_FIELD_Y_MM, GUTTER_WIDTH_MM };
