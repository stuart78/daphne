/**
 * Where the sheet prints its own ink inside the drawing areas.
 *
 * An extractor looking at a scan cannot tell a printed rule from a pen stroke by
 * looking at it. Most of the template is light enough to fall below any sane ink
 * threshold, but three things are not: the band borders, the centre rails on the
 * bipolar lanes, and the little rail labels tucked inside each band. Left alone,
 * the centre rail on the vibrato lane reads as a line somebody drew across the
 * whole thirty seconds.
 *
 * This lives here rather than in the vision package because it is a fact about
 * what `render.ts` draws, and the two have to move together. The regions are
 * deliberately positional: a column is only ignored at the heights the template
 * actually printed something, so a stroke drawn through the same column at a
 * different height still reads.
 */

import { machineBands, slidePanels, type Layout, type Rect } from './geometry.js';
import { PITCH_MARKS, PITCH_MAX_HZ, getRole } from './roles.js';

/**
 * Half-height of the strip claimed around a printed rule, in millimetres.
 *
 * A little over the widest rule the sheet draws, which is the 0.6 mm border.
 * It wants to be tight: the extractor discards a mark only when it fits
 * entirely inside one of these, so a strip much wider than the ink it stands
 * for starts swallowing thin pen strokes drawn nearby. A stroke laid exactly
 * along a printed rail is the one case this cannot separate, and it reads as
 * the rail rather than as a mark.
 */
const RULE_MM = 0.45;

/**
 * The dashed reference rules are thinner than the rails, and their strip has to
 * be thinner still: they sit exactly where people draw, so a strip any wider
 * than the printed ink starts swallowing the pen strokes laid along them.
 */
const DASH_MM = 0.3;

/** The rail labels are 4.8 pt text set 1.2 mm in from the left edge. */
const LABEL = { insetMm: 1.2, widthMm: 7.5, heightMm: 2.4 } as const;

const ruleAt = (x: number, w: number, y: number): Rect => ({
  x,
  y: y - RULE_MM,
  w,
  h: RULE_MM * 2,
});

/**
 * Regions the extractor should treat as blank paper, in page millimetres.
 *
 * Covers the drawing areas only. Everything outside a band or a panel is
 * already ignored, so the header, the gutter names and the footer need no
 * entry here.
 */
export const sheetFurniture = (layout: Layout = 'FULL'): Rect[] => {
  const out: Rect[] = [];

  for (const band of machineBands(layout)) {
    const f = band.rect;
    const role = getRole(band.role);
    const valueY = (v: number): number => f.y + f.h * (1 - v);

    // The border box. Also handles a line drawn hard against a rail, which
    // would otherwise merge with it and read as ink at the wrong height.
    out.push(ruleAt(f.x, f.w, f.y), ruleAt(f.x, f.w, f.y + f.h));

    // The centre rail on a bipolar lane is printed at full ink weight.
    if (role.kind === 'bipolar') out.push(ruleAt(f.x, f.w, valueY(0.5)));

    /*
     * The dashed reference rules, at 55% grey.
     *
     * A tight strip each, because the threshold has to sit low enough to read
     * pencil and pencil is not much darker than these are. Containment does the
     * separating: the printed rule is 0.4 mm and fits, a pencil line laid along
     * the 220 Hz rule is wider and does not.
     */
    const dash = (y: number): Rect => ({ x: f.x, y: y - DASH_MM, w: f.w, h: DASH_MM * 2 });
    if (role.kind === 'logpitch') {
      for (const hz of PITCH_MARKS) {
        if (hz > PITCH_MAX_HZ) continue;
        out.push(dash(valueY(hz / PITCH_MAX_HZ)));
      }
    } else {
      for (const ref of role.referenceLines ?? []) {
        if (ref.at !== 0.5) continue; // the only one that survives at band scale
        out.push(dash(valueY(ref.at)));
      }
    }

    // Rail labels, top and bottom left. Small, and only at their own height.
    out.push({
      x: f.x + LABEL.insetMm,
      y: f.y + 1,
      w: LABEL.widthMm,
      h: LABEL.heightMm,
    });
    out.push({
      x: f.x + LABEL.insetMm,
      y: f.y + f.h - LABEL.heightMm - 0.6,
      w: LABEL.widthMm,
      h: LABEL.heightMm,
    });

    // The pitch band carries a column of frequency numbers all the way down.
    if (role.kind === 'logpitch') {
      out.push({ x: f.x + LABEL.insetMm, y: f.y, w: LABEL.widthMm - 1.5, h: f.h });
    }

    // Note and octave rows are named at both edges, all the way down.
    if (role.kind === 'notes' || role.kind === 'octaves') {
      out.push({ x: f.x + LABEL.insetMm, y: f.y, w: 5, h: f.h });
      out.push({ x: f.x + f.w - LABEL.insetMm - 5, y: f.y, w: 5, h: f.h });
    }
  }

  for (const p of slidePanels()) {
    out.push(ruleAt(p.x, p.w, p.y), ruleAt(p.x, p.w, p.y + p.h));
    out.push(ruleAt(p.x, p.w, p.y + p.h / 2));
    // +1, zero and -1 sit against the right-hand edge of every panel.
    out.push({ x: p.x + p.w - 9, y: p.y + 1, w: 8.5, h: p.h - 2 });
  }

  return out;
};
