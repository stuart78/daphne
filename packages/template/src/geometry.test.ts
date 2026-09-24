import assert from 'node:assert/strict';
import { test } from 'node:test';

import qrcode from 'qrcode';

import {
  FIDUCIAL,
  FIDUCIAL_CENTRES,
  FIELD_RIGHT_MM,
  FIELD_X_MM,
  FOOTER_Y_MM,
  GUTTER_WIDTH_MM,
  LEFT_MARGIN_MM,
  MACHINE,
  MACHINE_LANES,
  MACHINE_CONTENT_BOTTOM_MM,
  MACHINE_RULER_Y_MM,
  MACHINE_SLIDES_Y_MM,
  NOMINAL_SPEED_MM_PER_S,
  PAGE,
  SLIDE_GRID,
  SHEET_DURATION_S,
  SOLO,
  SOLO_INSTRUCTION_Y_MM,
  TEXT_LEFT_MM,
  TIME_FIELD_WIDTH_MM,
  TONAL_LANES,
  machineBands,
  machineFieldRect,
  qrOuterRect,
  slidePanels,
  slidesFieldRect,
  soloFieldRect,
  timeToX,
} from './geometry.js';
import {
  LAYOUT_TONAL,
  decodePayload,
  encodePayload,
  layoutOf,
  sheetPayload,
  soloPayload,
} from './payload.js';
import { ROLES, getRole } from './roles.js';

const close = (a: number, b: number, eps = 1e-9): void =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

test('a sheet is exactly 30 seconds', () => {
  assert.equal(SHEET_DURATION_S, 30);
  assert.equal(TIME_FIELD_WIDTH_MM / NOMINAL_SPEED_MM_PER_S, 30);
});

test('one centimetre is one second and one millimetre is 100 ms', () => {
  close(timeToX(1) - timeToX(0), 10);
  close(timeToX(0.1) - timeToX(0), 1);
});

test('the sheet is one tenth of the original 100 mm/s film speed', () => {
  assert.equal(NOMINAL_SPEED_MM_PER_S * 10, 100);
});

test('horizontal bands fill the page exactly', () => {
  const rightMargin = PAGE.widthMm - FIELD_RIGHT_MM;
  close(LEFT_MARGIN_MM + GUTTER_WIDTH_MM + TIME_FIELD_WIDTH_MM + rightMargin, PAGE.widthMm);
  assert.ok(rightMargin > 8, 'right margin must clear the printer dead zone');
});

test('vertical bands fit inside the page', () => {
  const used =
    SOLO.topMarginMm +
    SOLO.headerHeightMm +
    SOLO.fieldHeightMm +
    SOLO.rulerHeightMm +
    SOLO.instructionHeightMm;
  assert.ok(used <= PAGE.heightMm, `${used} mm of bands exceeds the ${PAGE.heightMm} mm page`);
  assert.ok(PAGE.heightMm - used > 8, 'bottom margin must clear the printer dead zone');
  close(SOLO_INSTRUCTION_Y_MM + SOLO.instructionHeightMm, used);
});

test('fiducial ink stays clear of the unprintable margin', () => {
  const half = FIDUCIAL.sizeMm / 2;
  for (const c of FIDUCIAL_CENTRES) {
    const nearestEdge = Math.min(c.x, c.y, PAGE.widthMm - c.x, PAGE.heightMm - c.y);
    assert.ok(
      nearestEdge - half >= 6.35,
      `fiducial at (${c.x}, ${c.y}) sits ${nearestEdge - half} mm from the edge`,
    );
  }
});

const fiducialRects = () => {
  const half = FIDUCIAL.sizeMm / 2;
  return FIDUCIAL_CENTRES.map((c) => ({
    x: c.x - half,
    y: c.y - half,
    w: FIDUCIAL.sizeMm,
    h: FIDUCIAL.sizeMm,
  }));
};

const intersects = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('no fiducial ink lands inside the drawing field', () => {
  const field = soloFieldRect();
  for (const r of fiducialRects()) {
    assert.ok(
      !intersects(r, field),
      `fiducial at (${r.x}, ${r.y}) overlaps the field ${JSON.stringify(field)}`,
    );
  }
});

test('running text clears the corner fiducials', () => {
  // Header, instruction strip and footer all start at TEXT_LEFT_MM; the two
  // left-hand fiducials are the ones that can reach into those bands.
  const rightmostLeftInk = Math.max(
    ...fiducialRects()
      .filter((r) => r.x < PAGE.widthMm / 2)
      .map((r) => r.x + r.w),
  );
  assert.ok(
    TEXT_LEFT_MM >= rightmostLeftInk + 2,
    `text starts at ${TEXT_LEFT_MM} mm but left fiducial ink reaches ${rightmostLeftInk} mm`,
  );
});

test('the QR quiet zone does not paint over the field or the fiducials', () => {
  // The quiet zone is opaque white and is drawn last, so anything it overlaps
  // gets erased — this caught it erasing the top rail of every field.
  const outer = qrOuterRect();
  assert.ok(
    !intersects(outer, soloFieldRect()),
    `QR quiet zone ${JSON.stringify(outer)} overlaps the field`,
  );
  for (const r of fiducialRects()) {
    assert.ok(!intersects(r, outer), `fiducial at (${r.x}, ${r.y}) crowds the QR quiet zone`);
  }
  assert.ok(outer.x > FIELD_X_MM, 'QR should sit above the field, not off in the gutter');
  assert.ok(outer.y >= 0, 'QR quiet zone runs off the top of the page');
});

test('the machine bands tile their region exactly, with no overlap', () => {
  const bands = machineBands();
  assert.equal(bands.length, MACHINE_LANES.length);

  const region = machineFieldRect();
  assert.ok(Math.abs(bands[0]!.rect.y - region.y) < 1e-9, 'first band must start at the region top');
  const last = bands[bands.length - 1]!.rect;
  close(last.y + last.h, region.y + region.h);

  for (let i = 1; i < bands.length; i++) {
    const gap = bands[i]!.rect.y - (bands[i - 1]!.rect.y + bands[i - 1]!.rect.h);
    close(gap, MACHINE.bandGapMm);
  }
});

test('every machine band is tall enough to draw in', () => {
  // 10 mm, down from 13, because the timbres moved onto this page and the room
  // had to come from somewhere. Below about this the band stops being a thing
  // you can put a considered line in and becomes a thing you aim at.
  for (const band of machineBands()) {
    assert.ok(band.rect.h >= 10, `${band.role} band is only ${band.rect.h.toFixed(1)} mm tall`);
  }
});

test('pitch gets the most room, since it is the one read precisely', () => {
  const bands = machineBands();
  const pitch = bands.find((b) => b.role === 'PCH')!;
  for (const other of bands) {
    if (other.role === 'PCH') continue;
    assert.ok(pitch.rect.h > other.rect.h, `${other.role} is taller than pitch`);
  }
});

test('the machine sheet bands clear the header, ruler and fiducials', () => {
  const region = machineFieldRect();
  assert.ok(region.y >= MACHINE.topMarginMm + MACHINE.headerHeightMm, 'bands run into the header');
  close(region.y + region.h, MACHINE_RULER_Y_MM);
  assert.ok(
    MACHINE_RULER_Y_MM + MACHINE.rulerHeightMm < PAGE.heightMm - 6,
    'the ruler runs into the bottom margin',
  );
  for (const r of fiducialRects()) {
    assert.ok(!intersects(r, region), `fiducial at (${r.x}, ${r.y}) overlaps a band`);
  }
  assert.ok(!intersects(qrOuterRect(), region), 'the QR quiet zone would erase the top band');
});

test('the four timbre panels sit in one row without overlapping', () => {
  const panels = slidePanels();
  assert.equal(panels.length, 4);
  assert.equal(SLIDE_GRID.rows, 1, 'the strip is one row, so it fits under the bands');

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i]!;
    for (let j = i + 1; j < panels.length; j++) {
      assert.ok(!intersects(p, panels[j]!), `panels ${i} and ${j} overlap`);
    }
    close(p.y, panels[0]!.y);
    assert.ok(p.w >= 60 && p.h >= 22, `timbre panel ${i} is ${p.w}x${p.h} mm, too small to draw in`);
    // Not so letterboxed that a cycle stops looking like a cycle.
    assert.ok(p.w / p.h < 3.2, `timbre panel ${i} has aspect ${(p.w / p.h).toFixed(1)}:1`);
  }
  close(panels[0]!.x, FIELD_X_MM);
  close(panels[3]!.x + panels[3]!.w, FIELD_RIGHT_MM);
});

test('the whole sheet fits on one page', () => {
  // The point of the revision: bands, ruler, timbres and footer on one sheet of
  // US Legal, in that order, none of them touching.
  const bands = machineFieldRect();
  const slides = slidesFieldRect();

  close(bands.y, MACHINE.topMarginMm + MACHINE.headerHeightMm);
  close(bands.y + bands.h, MACHINE_RULER_Y_MM);
  assert.ok(
    MACHINE_RULER_Y_MM + MACHINE.rulerHeightMm <= MACHINE_SLIDES_Y_MM,
    'the time ruler runs into the timbre strip',
  );
  assert.ok(!intersects(bands, slides), 'the bands and the timbres overlap');

  assert.ok(
    MACHINE_CONTENT_BOTTOM_MM < FOOTER_Y_MM - 2,
    `content reaches ${MACHINE_CONTENT_BOTTOM_MM} mm and the footer sits at ${FOOTER_Y_MM}`,
  );
  // Every mainstream inkjet and laser refuses to print the last ~6.35 mm.
  assert.ok(
    PAGE.heightMm - MACHINE_CONTENT_BOTTOM_MM > 6.35,
    'the timbre strip runs into the printer dead zone',
  );
});

test('nothing on the sheet lands under a fiducial or the QR quiet zone', () => {
  for (const region of [machineFieldRect(), slidesFieldRect()]) {
    for (const r of fiducialRects()) {
      assert.ok(!intersects(r, region), `fiducial at (${r.x}, ${r.y}) overlaps a drawing region`);
    }
    assert.ok(!intersects(qrOuterRect(), region), 'the QR quiet zone would erase a drawing region');
  }
});

test('the sheet payload fits the QR budget', () => {
  const p = sheetPayload('FFFFFFFF');
  const s = encodePayload(p);
  assert.match(s, /^[0-9A-Z $%*+\-./:]+$/, `payload leaves alphanumeric mode: ${s}`);
  assert.deepEqual(decodePayload(s), p);
  const sym = qrcode.create(s, { errorCorrectionLevel: 'Q' });
  assert.ok(sym.modules.size >= 29, `${p.role} symbol is only ${sym.modules.size} modules`);
});

test('payload round-trips', () => {
  for (const role of ROLES) {
    const p = soloPayload('A3F91C2D', 4, role.id);
    const decoded = decodePayload(encodePayload(p));
    assert.deepEqual(decoded, p);
  }
});

test('payload stays inside QR alphanumeric mode', () => {
  const alnum = /^[0-9A-Z $%*+\-./:]+$/;
  for (const role of ROLES) {
    const s = encodePayload(soloPayload('FFFFFFFF', 99, role.id));
    assert.match(s, alnum, `payload for ${role.id} leaves alphanumeric mode: ${s}`);
    // Version 3 at level Q holds 47 alphanumeric characters.
    assert.ok(s.length <= 47, `payload for ${role.id} is ${s.length} chars, over the 47 budget`);
  }
});

test('every payload fits the QR version the quiet-zone maths assumes', () => {
  // qrOuterRect() sizes the opaque quiet zone from a 29-module (version 3)
  // symbol. A larger version means smaller modules, so the zone would shrink
  // rather than grow — but a *smaller* version makes it bigger, and that is
  // what could reach the field border.
  for (const role of ROLES) {
    const sym = qrcode.create(encodePayload(soloPayload('FFFFFFFF', 99, role.id)), {
      errorCorrectionLevel: 'Q',
    });
    assert.ok(
      sym.modules.size >= 29,
      `${role.id} produces a ${sym.modules.size}-module symbol; quiet zone assumes >= 29`,
    );
  }
});

test('the payload declares the field the app must find', () => {
  const p = soloPayload('A3F91C2D', 1, 'AMP1');
  assert.equal(p.field.w, TIME_FIELD_WIDTH_MM);
  assert.equal(p.field.h, SOLO.fieldHeightMm);
  assert.equal(p.durationMs, 30_000);
});

test('every role id is a valid lookup and instructions fit the strip', () => {
  for (const role of ROLES) {
    assert.equal(getRole(role.id.toLowerCase()).id, role.id);
    assert.ok(role.instructions.length <= 4, `${role.id} has too many instruction lines`);
  }
});

test('unknown roles fail loudly', () => {
  assert.throws(() => getRole('NOPE'), /Unknown role/);
});

// --- the note-and-octave sheet ---------------------------------------------

test('the note-and-octave sheet tiles the same field', () => {
  const bands = machineBands('TONE');
  assert.equal(bands.length, TONAL_LANES.length);
  assert.deepEqual(
    bands.slice(0, 2).map((b) => b.role),
    ['NOTE', 'OCT'],
    'note first, octave directly under it',
  );

  const region = machineFieldRect();
  close(bands[0]!.rect.y, region.y);
  const last = bands[bands.length - 1]!.rect;
  close(last.y + last.h, region.y + region.h);
  for (let i = 1; i < bands.length; i++) {
    const gap = bands[i]!.rect.y - (bands[i - 1]!.rect.y + bands[i - 1]!.rect.h);
    close(gap, MACHINE.bandGapMm);
  }
});

test('note and octave rows are big enough to take a pen dot', () => {
  // Richards' sensors needed 3 mm. Nothing here has to be optically separable,
  // since the app snaps to the nearest row, so the floor is what a hand can aim
  // at rather than what a phototransistor can see.
  const bands = machineBands('TONE');
  const note = bands.find((b) => b.role === 'NOTE')!.rect;
  const octave = bands.find((b) => b.role === 'OCT')!.rect;
  assert.ok(note.h / 12 >= 2.3, `note rows are ${(note.h / 12).toFixed(2)} mm`);
  assert.ok(octave.h / 8 >= 1.7, `octave rows are ${(octave.h / 8).toFixed(2)} mm`);
  for (const band of bands) {
    assert.ok(band.rect.h >= 8, `${band.role} band is only ${band.rect.h.toFixed(1)} mm tall`);
  }
});

test('the sheet says which layout it is', () => {
  const tonal = sheetPayload('FFFFFFFF', undefined, 'TONE');
  assert.equal(tonal.role, LAYOUT_TONAL);
  const back = decodePayload(encodePayload(tonal));
  assert.equal(layoutOf(back), 'TONE');
  assert.equal(layoutOf(decodePayload(encodePayload(sheetPayload('FFFFFFFF')))), 'FULL');
  // A QR that failed to read falls back to the original sheet.
  assert.equal(layoutOf(null), 'FULL');
});
