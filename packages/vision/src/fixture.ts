/**
 * Rendering a sheet to pixels, for tests.
 *
 * Lives outside the test file because more than one test wants it and because
 * rasterising costs a second. Uses `pdftoppm`, which comes with poppler and is
 * already on any machine that can look at the sheets. If it is missing, the
 * tests that need it say so and skip rather than fail: nothing here is a claim
 * about the importer.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDocument, sheetPayload, type Layout, type Overlays, type Paper } from '@oramics/template';

import { parsePgm } from './testing.js';
import type { Gray } from './image.js';

export const hasRasteriser = (): boolean => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Render the sheet at a given DPI, with optional drawn overlays. */
export const renderSheet = async (
  dpi: number,
  overlays?: Overlays,
  sheetId = 'A3F91C2D',
  layout: Layout = 'FULL',
  paper: Paper = 'legal',
): Promise<Gray> => {
  const payload = sheetPayload(sheetId, undefined, layout);
  const pdf = await buildDocument({
    pages: [{ kind: 'machine', options: { payload, paper, ...(overlays ? { overlays } : {}) } }],
  });

  const dir = mkdtempSync(join(tmpdir(), 'oramics-vision-'));
  try {
    const pdfPath = join(dir, 'sheet.pdf');
    writeFileSync(pdfPath, pdf);
    execFileSync('pdftoppm', ['-gray', '-r', String(dpi), '-singlefile', pdfPath, join(dir, 'page')]);
    return parsePgm(readFileSync(join(dir, 'page.pgm')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
