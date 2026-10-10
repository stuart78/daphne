import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { Overlays } from '@oramics/template';

import { hasRasteriser, renderSheet } from './fixture.js';
import type { Gray } from './image.js';
import { inkRibbon } from './extract.js';
import { importSheet } from './index.js';
import { photograph } from './testing.js';

const RASTERISER = hasRasteriser();
const skip = RASTERISER ? false : 'pdftoppm is not installed';

const COLUMNS = 600;

/** A known shape per band, so every extracted value has a right answer. */
const shape = (role: string): Float32Array => {
  const out = new Float32Array(COLUMNS);
  for (let i = 0; i < COLUMNS; i++) {
    const t = i / (COLUMNS - 1);
    // Blank margins at both ends, so "nothing drawn" has to survive too.
    if (t < 0.12 || t > 0.88) {
      out[i] = Number.NaN;
      continue;
    }
    const phase = 2 * Math.PI * (t - 0.12) * (role === 'PCH' ? 1 : 2);
    out[i] = 0.5 + 0.3 * Math.sin(phase);
  }
  return out;
};

const OVERLAYS: Overlays = {
  PCH: shape('PCH'),
  AMP1: shape('AMP1'),
  VIB: shape('VIB'),
  TRN: shape('TRN'),
};

let drawn: Gray;

before(async () => {
  if (RASTERISER) drawn = await renderSheet(200, OVERLAYS);
});

/**
 * Compare an extracted lane against what was printed.
 *
 * Only where both are drawn: the edges of a mark are genuinely ambiguous at
 * one column's resolution, and an off-by-one there says nothing about whether
 * the middle of the line was read correctly.
 */
const compare = (
  got: Float32Array,
  want: Float32Array,
): { worst: number; mean: number; missing: number; invented: number } => {
  let worst = 0;
  let total = 0;
  let n = 0;
  let missing = 0;
  let invented = 0;

  /*
   * Columns to ignore at each end of a stroke.
   *
   * Wider than one because an amplitude band prints filled, and a filled run is
   * closed with a vertical edge down to the floor at each end. Those columns
   * genuinely contain ink from the top of the band to the bottom, so there is no
   * single right answer for them and nothing to learn from measuring one.
   */
  const SKIP = 3;

  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    let edge = i < SKIP || i >= want.length - SKIP;
    for (let k = 1; k <= SKIP && !edge; k++) {
      edge =
        Number.isNaN(want[i - k]!) !== Number.isNaN(w) ||
        Number.isNaN(want[i + k]!) !== Number.isNaN(w);
    }

    const g = got[Math.round((i / (want.length - 1)) * (got.length - 1))]!;
    if (Number.isNaN(w)) {
      if (!edge && Number.isFinite(g)) invented++;
      continue;
    }
    if (!Number.isFinite(g)) {
      if (!edge) missing++;
      continue;
    }
    if (edge) continue;
    const error = Math.abs(g - w);
    worst = Math.max(worst, error);
    total += error;
    n++;
  }
  return { worst, mean: n > 0 ? total / n : 1, missing, invented };
};

// ---------------------------------------------------------------------------

test('a clean scan reads back what was printed', { skip }, () => {
  const result = importSheet(drawn, { laneColumns: COLUMNS });
  assert.ok(result.ok, result.ok ? '' : result.message);

  for (const role of Object.keys(OVERLAYS)) {
    const stats = compare(result.contents.lanes[role]!, OVERLAYS[role]! as Float32Array);
    // As a fraction of band height, so the shallow bipolar lanes are the strict
    // case: 0.07 of the 10 mm transport band is two thirds of a millimetre.
    assert.ok(stats.worst < 0.07, `${role} worst error ${stats.worst.toFixed(3)} of the band`);
    assert.ok(stats.mean < 0.01, `${role} mean error ${stats.mean.toFixed(4)}`);
    // A few columns go unread where a stroke runs along a printed rule, which
    // is the one case the containment test cannot separate.
    assert.ok(stats.missing < COLUMNS * 0.06, `${role} lost ${stats.missing} drawn columns`);
    // Not zero. The threshold sits below what the dashed rules print at, so a
    // workshop's pencil reads at all, and the odd column of printed rule gets
    // through. A handful out of 600 is speckle; the coverage test below is the
    // one that says a blank band stays blank.
    assert.ok(
      stats.invented <= COLUMNS * 0.01,
      `${role} invented ${stats.invented} marks on blank paper`,
    );
  }
});

test('blank bands come back blank, not at rest', { skip }, () => {
  // The distinction the whole lane model rests on. A band nobody touched has to
  // read as nothing drawn, not as a line along the bottom.
  const result = importSheet(drawn, { laneColumns: COLUMNS });
  assert.ok(result.ok);
  if (!result.ok) return;

  for (const role of ['AMP2', 'AMP3', 'AMP4', 'REV']) {
    const coverage = result.contents.coverage[role]!;
    assert.ok(coverage < 0.02, `${role} is untouched but ${(coverage * 100).toFixed(1)}% reads as ink`);
  }
});

test('the sheet says what it is', { skip }, () => {
  const result = importSheet(drawn);
  assert.ok(result.ok);
  if (!result.ok) return;

  assert.ok(result.payload, 'the QR did not decode');
  assert.equal(result.payload?.sheetId, 'A3F91C2D');
  assert.equal(result.durationS, 30);
});

test('a photographed sheet reads back what was printed', { skip }, () => {
  // The test that matters: a phone held at an angle, under a window, slightly
  // out of focus. Tolerances are looser than the flatbed case and still well
  // inside a millimetre of band height.
  const scan = photograph(drawn, {
    width: 2000,
    perspective: 0.04,
    rotate: -6,
    vignette: 0.3,
    noise: 0.012,
    blur: 1,
    seed: 3,
  });

  const result = importSheet(scan.image, { laneColumns: COLUMNS });
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.ok(result.fitMm < 0.5, `registration fit is ${result.fitMm.toFixed(2)} mm`);

  for (const role of Object.keys(OVERLAYS)) {
    const stats = compare(result.contents.lanes[role]!, OVERLAYS[role]! as Float32Array);
    assert.ok(stats.worst < 0.09, `${role} worst error ${stats.worst.toFixed(3)} of the band`);
    assert.ok(stats.mean < 0.02, `${role} mean error ${stats.mean.toFixed(4)}`);
    assert.ok(stats.missing < COLUMNS * 0.1, `${role} lost ${stats.missing} drawn columns`);
    assert.ok(stats.invented < COLUMNS * 0.02, `${role} invented ${stats.invented} marks`);
  }
});

test('the printed centre rail is not mistaken for a drawn line', { skip }, async () => {
  /*
   * The vibrato and transport lanes carry a centre rail printed at full ink
   * weight, right across the thirty seconds. Without the template declaring its
   * own furniture, every blank bipolar lane imports as a line drawn dead centre
   * for the whole piece, which is both wrong and completely plausible looking.
   */
  const blank = await renderSheet(200);
  const result = importSheet(blank, { laneColumns: COLUMNS });
  assert.ok(result.ok);
  if (!result.ok) return;

  for (const role of ['VIB', 'TRN']) {
    const coverage = result.contents.coverage[role]!;
    assert.ok(
      coverage < 0.02,
      `${role} reads ${(coverage * 100).toFixed(0)}% covered on a blank sheet`,
    );
  }
  for (const role of Object.keys(result.contents.coverage)) {
    assert.ok(
      result.contents.coverage[role]! < 0.02,
      `${role} reads ${(result.contents.coverage[role]! * 100).toFixed(0)}% covered on a blank sheet`,
    );
  }
});

test('a mark drawn behind the rail labels is read, not dropped', { skip }, async () => {
  /*
   * The amplitude labels sit inside the band, at the left. A line drawn low
   * across the whole sheet passes behind "silence" and goes unread there, which
   * used to leave the first half second of the piece silent: an amplitude that
   * fades in where the drawing has none.
   */
  const low = new Float32Array(COLUMNS).fill(0.18);
  const image = await renderSheet(150, { AMP1: low });
  const result = importSheet(image, { laneColumns: 600 });
  assert.ok(result.ok, result.ok ? '' : result.message);

  const values = result.contents.lanes.AMP1!;
  const drawnTo = (fraction: number): number => values[Math.round(fraction * (values.length - 1))]!;
  for (const at of [0, 0.004, 0.01, 0.02, 0.5, 0.99]) {
    assert.ok(Number.isFinite(drawnTo(at)), `nothing read at ${at * 100}% across`);
    assert.ok(Math.abs(drawnTo(at) - 0.18) < 0.06, `read ${drawnTo(at)} at ${at * 100}%`);
  }
});

test('a scanned timbre stroke comes back at the weight a brush lays', () => {
  /*
   * A pen line on paper is about a twentieth of the panel high, where the app's
   * own brush lays a seventh, and the scanning spot is wider than the pen line
   * is. Read as drawn, the servo gets a weak, broken edge to ride and the voice
   * comes out several times quieter than the same shape drawn on screen.
   */
  const W = 512;
  const H = 256;
  const field = new Float32Array(W * H);
  const at = (x: number): number => Math.round(H / 2 + (H / 3) * Math.sin((2 * Math.PI * x) / W));
  for (let x = 0; x < W; x++) {
    // A hairline four rows deep, with two pen skips and a speck of border ink.
    if ((x > 140 && x < 148) || (x > 300 && x < 304)) continue;
    for (let k = 0; k < 4; k++) field[(at(x) + k) * W + x] = 1;
    field[1 * W + x] = 1;
  }

  const out = inkRibbon(field, W, H);
  const thickness = (x: number): number => {
    let n = 0;
    for (let y = 0; y < H; y++) if (out[y * W + x]! >= 0.5) n++;
    return n;
  };
  const top = (x: number): number => {
    for (let y = 0; y < H; y++) if (out[y * W + x]! >= 0.5) return y;
    return -1;
  };

  for (const x of [20, 200, 400, 500]) {
    // The app's own brush lays 14% of the panel height.
    assert.ok(thickness(x) >= 30, `column ${x} came back ${thickness(x)} deep`);
    // And the top edge, the part the spot rides, stays where it was drawn.
    assert.equal(top(x), at(x), `column ${x} moved from ${at(x)} to ${top(x)}`);
  }

  // The skips are bridged: a dropped column drops the spot once per cycle.
  for (const x of [144, 302]) assert.ok(thickness(x) > 0, `skip at ${x} was left open`);

  // And nothing is laid along the speck of border ink, which used to put a
  // brush-wide bar across the top of every imported slide.
  for (const x of [20, 200, 400]) assert.ok(top(x) > 10, `column ${x} rode the border at ${top(x)}`);
});

test('a sheet printed on Letter reads back the same as one on Legal', { skip }, async () => {
  /*
   * Letter is 76 mm narrower, so the whole sheet is printed smaller: 30 seconds
   * still fit, at about 8 mm to the second rather than 10. The importer is told
   * none of this. It registers on the four corner squares, and a sheet shrunk
   * evenly leaves them a smaller copy of the same rectangle, which the
   * homography undoes along with print scale and camera angle.
   */
  const letter = await renderSheet(150, OVERLAYS, 'A3F91C2D', 'FULL', 'letter');
  const result = importSheet(letter, { laneColumns: COLUMNS });
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;
  assert.equal(result.payload?.sheetId, 'A3F91C2D');

  for (const role of Object.keys(OVERLAYS)) {
    const stats = compare(result.contents.lanes[role]!, OVERLAYS[role]! as Float32Array);
    assert.ok(stats.worst < 0.09, `${role} worst error ${stats.worst.toFixed(3)} of the band`);
    assert.ok(stats.mean < 0.02, `${role} mean error ${stats.mean.toFixed(4)}`);
  }
});
