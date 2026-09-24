/**
 * Sheet geometry. Every dimension in this file is millimetres in *page space*,
 * measured from the top-left corner of the physical sheet with y increasing
 * downwards. (pdf-lib works bottom-up; `toPdfY` in render.ts does the flip.)
 *
 * The numbers here are not arbitrary. The time field is exactly 300 mm so that
 * at the nominal 10 mm/s read speed a sheet is exactly 30.000 seconds, 1 cm is
 * 1 second and 1 mm is 100 ms. That is also precisely 1/10 of the 100 mm/s film
 * speed of Oram's original machine, so the sheet is "the Oramics machine at
 * one-tenth speed" — which is the only way to fit a useful duration on paper.
 */

export const MM_PER_INCH = 25.4;
export const PT_PER_MM = 72 / MM_PER_INCH;

/** US Legal, landscape. 14" x 8.5". */
export const PAGE = {
  widthMm: 14 * MM_PER_INCH, // 355.6
  heightMm: 8.5 * MM_PER_INCH, // 215.9
} as const;

/**
 * Nominal read-head speed in page-millimetres per second.
 *
 * This is a property of the *template*, not of the machine — the app reads the
 * declared duration out of the QR and sets its transport speed so the sheet
 * lasts exactly that long, whatever the print scale or scan DPI turned out to
 * be. Changing this constant changes the printed time ruler and nothing else.
 */
export const NOMINAL_SPEED_MM_PER_S = 10;

/** Time field width, chosen so duration comes out exact. */
export const TIME_FIELD_WIDTH_MM = 300;

/** 300 mm / 10 mm/s = 30.000 s, by construction. */
export const SHEET_DURATION_S = TIME_FIELD_WIDTH_MM / NOMINAL_SPEED_MM_PER_S;

/**
 * Registration fiducials: four solid squares whose *centres* sit at a known
 * rectangle. The app detects them, solves a homography onto these coordinates,
 * and thereby recovers page space from any photograph or skewed scan.
 *
 * Centres are inset 11 mm from each edge. With an 8 mm square that puts the
 * outermost ink at 7 mm from the paper edge, clear of the ~5-6.35 mm
 * unprintable margin on typical inkjet and laser hardware.
 */
export const FIDUCIAL = {
  sizeMm: 8,
  insetMm: 11,
} as const;

export const FIDUCIAL_CENTRES = [
  { x: FIDUCIAL.insetMm, y: FIDUCIAL.insetMm }, // top-left
  { x: PAGE.widthMm - FIDUCIAL.insetMm, y: FIDUCIAL.insetMm }, // top-right
  { x: PAGE.widthMm - FIDUCIAL.insetMm, y: PAGE.heightMm - FIDUCIAL.insetMm },
  { x: FIDUCIAL.insetMm, y: PAGE.heightMm - FIDUCIAL.insetMm },
] as const;

/** Origin of the reference rectangle — field offsets in the QR are relative to this. */
export const FIDUCIAL_ORIGIN = FIDUCIAL_CENTRES[0];

/**
 * Machine-readable "this way up": a solid bar under the top-left corner mark.
 *
 * Four identical squares at the corners of a rectangle say where the page is
 * but not which way up it is, and a sheet photographed in portrait registers
 * perfectly onto its own transpose: every band lands across the page instead of
 * along it, and the result looks like a reading rather than like a failure. One
 * asymmetric mark settles it.
 *
 * A bar rather than a square, so the fiducial search cannot mistake it for a
 * fifth corner: anything that far from square is rejected before the corner
 * quadrilateral is chosen.
 */
export const ORIENTATION_MARK = {
  /*
   * Big enough to survive a phone.
   *
   * At 6 x 2.5 mm it was solid on a flatbed and marginal in a photograph: a
   * hand-held frame puts about three pixels per millimetre on the page, so the
   * bar was eight pixels tall before the lens softened it, and the importer fell
   * back to inferring orientation from the QR. Nine by three and a half survives
   * the same photograph with room to spare.
   */
  widthMm: 9,
  heightMm: 3.5,
  /** Centre, in page millimetres. Below the top-left fiducial, in the margin. */
  xMm: 13,
  yMm: FIDUCIAL.insetMm + 13,
} as const;

export const orientationRect = (): Rect => ({
  x: ORIENTATION_MARK.xMm - ORIENTATION_MARK.widthMm / 2,
  y: ORIENTATION_MARK.yMm - ORIENTATION_MARK.heightMm / 2,
  w: ORIENTATION_MARK.widthMm,
  h: ORIENTATION_MARK.heightMm,
});

// ---------------------------------------------------------------------------
// Horizontal bands
// ---------------------------------------------------------------------------
//    9    left margin
//   28    label gutter (axis values)
//  300    time field
//   18.6  right margin
//  -----
//  355.6
//
// The right margin looks generous but is load-bearing: the two right-hand
// fiducials need their ink to clear both the paper edge and the field border,
// and the field width is fixed at 300 mm by the 30-second guarantee, so the
// slack has to come out of the margins.

export const LEFT_MARGIN_MM = 9;
export const GUTTER_WIDTH_MM = 28;

/** x of the left edge of the time field. */
export const FIELD_X_MM = LEFT_MARGIN_MM + GUTTER_WIDTH_MM; // 37
export const FIELD_RIGHT_MM = FIELD_X_MM + TIME_FIELD_WIDTH_MM; // 337

/**
 * Left edge for running text (header, instructions, footer). Indented past the
 * left margin so it clears the corner fiducials, whose ink reaches x = 15.
 */
export const TEXT_LEFT_MM = 20;

// ---------------------------------------------------------------------------
// Vertical bands (single-lane "solo" sheet)
// ---------------------------------------------------------------------------
//   11    top margin
//   19    header (title, contributor box, QR)
//  150    value field
//   12    time ruler
//   14    instruction strip
//    9.9  bottom margin
//  -----
//  215.9

export const SOLO = {
  topMarginMm: 11,
  headerHeightMm: 19,
  fieldHeightMm: 150,
  rulerHeightMm: 12,
  instructionHeightMm: 14,
} as const;

export const SOLO_HEADER_Y_MM = SOLO.topMarginMm; // 11
export const SOLO_FIELD_Y_MM = SOLO_HEADER_Y_MM + SOLO.headerHeightMm; // 30
export const SOLO_RULER_Y_MM = SOLO_FIELD_Y_MM + SOLO.fieldHeightMm; // 180
export const SOLO_INSTRUCTION_Y_MM = SOLO_RULER_Y_MM + SOLO.rulerHeightMm; // 192

/**
 * The self-description block, right-aligned to the field edge and sitting in
 * the top margin. It has to clear three things: the top-right fiducial to its
 * right, the header text to its left, and — including its quiet zone — the top
 * rail of the field below, since the quiet zone is opaque white and would
 * otherwise erase the border.
 */
export const QR = {
  sizeMm: 18,
  yMm: 8,
  /** Quiet zone, in modules, on each side. Below ~2 phone cameras start failing. */
  quietModules: 2,
} as const;

export const qrRect = (): Rect => ({
  x: FIELD_RIGHT_MM - QR.sizeMm,
  y: QR.yMm,
  w: QR.sizeMm,
  h: QR.sizeMm,
});

/** The QR footprint including its opaque quiet zone, worst case (version 3). */
export const qrOuterRect = (): Rect => {
  const quiet = (QR.sizeMm / 29) * QR.quietModules;
  const r = qrRect();
  return { x: r.x - quiet, y: r.y - quiet, w: r.w + quiet * 2, h: r.h + quiet * 2 };
};

/** A rectangle in page-mm, top-left origin. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------
//
// One page, and one page only. Every time-domain lane as a horizontal band,
// with the four painted timbres in a strip underneath, because scanning several
// sheets per piece is not a workshop, it is admin.
//
//   11    top margin
//   18    header — deep enough that the QR's opaque quiet zone ends above the
//          first band, which is tighter than the solo sheet's constraint
//  130    bands
//    9.5  time ruler (shared by every band)
//    8    gap, holding the timbre instruction and the panel titles
//   26    timbre panels, four across
//    4    phase labels under the panels
//    9.4  bottom margin, holding the footer at 209.5
//  -----
//  215.9
//
// The bands gave up 36 mm to make room for the timbres, and that is what the
// single page costs. The shallowest band is now about 10.2 mm rather than the
// 13 it was, which is still a comfortable pen stroke but no longer generous.
// The field stays 300 mm wide, because the 30-second guarantee is not
// negotiable, and the header cannot give anything back: it is sized by the
// QR's opaque quiet zone, and a smaller QR is a symbol a phone might not read.

export const MACHINE = {
  topMarginMm: 11,
  headerHeightMm: 18,
  bandsHeightMm: 130,
  rulerHeightMm: 9.5,
  /** Blank strip between bands so a line drawn to a rail stays legible. */
  bandGapMm: 1.6,
  /** Clear space between the time ruler and the timbre strip. */
  slidesGapMm: 8,
  /** Height of a timbre panel. Four across the field gives roughly 2.6:1. */
  slidesHeightMm: 26,
  /** Room under the panels for the 0 and 360 degree labels. */
  slidesLabelHeightMm: 4,
} as const;

export const MACHINE_BANDS_Y_MM = MACHINE.topMarginMm + MACHINE.headerHeightMm; // 29
export const MACHINE_RULER_Y_MM = MACHINE_BANDS_Y_MM + MACHINE.bandsHeightMm; // 158
export const MACHINE_SLIDES_Y_MM =
  MACHINE_RULER_Y_MM + MACHINE.rulerHeightMm + MACHINE.slidesGapMm; // 176.5

/** Lowest ink on the sheet before the footer. */
export const MACHINE_CONTENT_BOTTOM_MM =
  MACHINE_SLIDES_Y_MM + MACHINE.slidesHeightMm + MACHINE.slidesLabelHeightMm; // 206.5

/** Baseline of the footer strip, which is the last thing on the page. */
export const FOOTER_Y_MM = PAGE.heightMm - 6.4; // 209.5

/**
 * Relative band heights. Pitch gets the most room because it is the only lane
 * where vertical position has to be read precisely rather than gesturally —
 * everything else is a contour between two rails.
 */
/**
 * Which set of bands a sheet carries.
 *
 *   FULL   pitch as one line, height in Hertz: what the original machine read
 *   TONE   pitch as a note in twelve rows and an octave in eight below it
 *
 * The QR names the layout, so an imported sheet says which way to read it.
 */
export type Layout = 'FULL' | 'TONE';

export const MACHINE_LANES: ReadonlyArray<{ role: string; weight: number }> = [
  { role: 'PCH', weight: 3 },
  { role: 'AMP1', weight: 1.6 },
  { role: 'AMP2', weight: 1.6 },
  { role: 'AMP3', weight: 1.6 },
  { role: 'AMP4', weight: 1.6 },
  { role: 'VIB', weight: 1.2 },
  { role: 'REV', weight: 1.1 },
  { role: 'TRN', weight: 1.1 },
];

/**
 * The note-and-octave sheet.
 *
 * Pitch is split in two: twelve note rows, then eight octave rows directly
 * under them. The note band gets the most room because it has the most rows,
 * and 2.5 mm a row is the smallest that still takes a pen dot comfortably;
 * Richards' sensors needed 3 mm, but nothing here has to be optically
 * separable, since the app snaps to the nearest row.
 *
 * Everything else gives a little ground to make space. Reverberation and
 * transport end up about 8 mm, which is enough for the gestures they take.
 */
export const TONAL_LANES: ReadonlyArray<{ role: string; weight: number }> = [
  { role: 'NOTE', weight: 3.6 },
  { role: 'OCT', weight: 1.8 },
  { role: 'AMP1', weight: 1.4 },
  { role: 'AMP2', weight: 1.4 },
  { role: 'AMP3', weight: 1.4 },
  { role: 'AMP4', weight: 1.4 },
  { role: 'VIB', weight: 1.1 },
  { role: 'REV', weight: 1.0 },
  { role: 'TRN', weight: 1.0 },
];

export const lanesFor = (layout: Layout): ReadonlyArray<{ role: string; weight: number }> =>
  layout === 'TONE' ? TONAL_LANES : MACHINE_LANES;

export interface Band {
  role: string;
  index: number;
  rect: Rect;
}

/** Lay the bands out down the page, proportional to their weights. */
export const machineBands = (layout: Layout = 'FULL'): Band[] => {
  const lanes = lanesFor(layout);
  const totalWeight = lanes.reduce((s, l) => s + l.weight, 0);
  const gaps = MACHINE.bandGapMm * (lanes.length - 1);
  const perWeight = (MACHINE.bandsHeightMm - gaps) / totalWeight;

  let y = MACHINE_BANDS_Y_MM;
  return lanes.map((lane, index) => {
    const h = lane.weight * perWeight;
    const rect: Rect = { x: FIELD_X_MM, y, w: TIME_FIELD_WIDTH_MM, h };
    y += h + MACHINE.bandGapMm;
    return { role: lane.role, index, rect };
  });
};

/** The bounding box of all bands — what the extractor locates after registration. */
export const machineFieldRect = (): Rect => ({
  x: FIELD_X_MM,
  y: MACHINE_BANDS_Y_MM,
  w: TIME_FIELD_WIDTH_MM,
  h: MACHINE.bandsHeightMm,
});

// ---------------------------------------------------------------------------
// Waveform slides
// ---------------------------------------------------------------------------
//
// The four timbres were painted glass slides, not film: their x axis is phase,
// not time. They sit in a strip below the time ruler, four across the same
// 300 mm field, which puts every panel on the same page as the bands and still
// leaves each cycle a roughly 2:1 panel rather than one smeared across 300 mm.

export const SLIDE_GRID = { cols: 4, rows: 1, gapXMm: 9 } as const;

export const slidePanels = (): Rect[] => {
  const { cols, gapXMm } = SLIDE_GRID;
  const w = (TIME_FIELD_WIDTH_MM - gapXMm * (cols - 1)) / cols;
  return Array.from({ length: cols }, (_, c) => ({
    x: FIELD_X_MM + c * (w + gapXMm),
    y: MACHINE_SLIDES_Y_MM,
    w,
    h: MACHINE.slidesHeightMm,
  }));
};

/** The bounding box of the timbre strip, for registration after a scan. */
export const slidesFieldRect = (): Rect => ({
  x: FIELD_X_MM,
  y: MACHINE_SLIDES_Y_MM,
  w: TIME_FIELD_WIDTH_MM,
  h: MACHINE.slidesHeightMm,
});

export const soloFieldRect = (): Rect => ({
  x: FIELD_X_MM,
  y: SOLO_FIELD_Y_MM,
  w: TIME_FIELD_WIDTH_MM,
  h: SOLO.fieldHeightMm,
});

/** Convert a time in seconds to an x coordinate inside the time field. */
export const timeToX = (seconds: number): number =>
  FIELD_X_MM + seconds * NOMINAL_SPEED_MM_PER_S;

/** Express a page-space rect relative to the fiducial origin, for the QR payload. */
export const relativeToFiducials = (r: Rect): Rect => ({
  x: r.x - FIDUCIAL_ORIGIN.x,
  y: r.y - FIDUCIAL_ORIGIN.y,
  w: r.w,
  h: r.h,
});

export const mmToPt = (mm: number): number => mm * PT_PER_MM;
