#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  NOMINAL_SPEED_MM_PER_S,
  SHEET_DURATION_S,
  TIME_FIELD_WIDTH_MM,
  paperScale,
  type Paper,
} from './geometry.js';
import { ROLES, getRole } from './roles.js';
import { makeSheetId, sheetPayload, soloPayload } from './payload.js';
import { buildDocument, type GridStyle, type Page } from './render.js';

const usage = `
Generate printable Oramics drawing sheets (US Legal, landscape).

  pnpm template -- [options]

By default you get one sheet: every time-domain lane as a band, with the four
timbres in a strip underneath. One page to print, one page to scan back.

Options
  --layout <l>      sheet (default) | tonal | solo
  --paper <p>       legal (default) | letter. Letter holds the same 30 s, smaller.
                    tonal splits pitch into a note band and an octave band
  --roles <a,b,c>   With --layout solo: which roles, one full sheet each.
  --neumes          Add the binary pitch sheet. It needs a page of its own.
  --list            Print the role table and exit.
  --sheet <id>      8-char id shared by every page of one piece. Default: random.
  --grid <style>    grey (default) | nonphoto
  --out <path>      Output PDF. Default: out/oramics-sheets.pdf

Roles for --layout solo: ${ROLES.map((r) => r.id).join(', ')}
`;

type Layout = 'sheet' | 'tonal' | 'solo';

const main = async (): Promise<void> => {
  // `pnpm run generate -- --all` forwards the separator itself, and parseArgs
  // would treat everything after it as positionals.
  const argv = process.argv.slice(2);
  const args = argv[0] === '--' ? argv.slice(1) : argv;

  const { values } = parseArgs({
    args,
    options: {
      layout: { type: 'string', default: 'sheet' },
      paper: { type: 'string', default: 'legal' },
      roles: { type: 'string' },
      neumes: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      sheet: { type: 'string' },
      grid: { type: 'string', default: 'grey' },
      out: { type: 'string', default: 'out/oramics-sheets.pdf' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(usage);
    return;
  }

  if (values.list) {
    for (const r of ROLES) {
      console.log(`  ${r.id.padEnd(6)} ${r.kind.padEnd(9)} ${r.title} — ${r.blurb}`);
    }
    return;
  }

  const paper = values.paper as Paper;
  if (paper !== 'legal' && paper !== 'letter') {
    throw new Error(`--paper must be legal or letter, got "${values.paper}"`);
  }
  const layout = values.layout as Layout;
  if (!['sheet', 'tonal', 'solo'].includes(layout)) {
    throw new Error(`--layout must be sheet, tonal or solo, got "${values.layout}"`);
  }

  const gridStyle = values.grid as GridStyle;
  if (gridStyle !== 'grey' && gridStyle !== 'nonphoto') {
    throw new Error(`--grid must be "grey" or "nonphoto", got "${values.grid}"`);
  }

  const sheetId = (values.sheet ?? makeSheetId()).toUpperCase();
  const pages: Page[] = [];

  if (layout === 'solo') {
    const ids = values.roles?.split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids?.length) throw new Error('--layout solo needs --roles');
    ids.forEach((id, i) => {
      const role = getRole(id);
      pages.push({
        kind: 'solo',
        options: { role, payload: soloPayload(sheetId, i + 1, role.id), gridStyle, paper },
      });
    });
  } else {
    const payload = sheetPayload(sheetId, undefined, layout === 'tonal' ? 'TONE' : 'FULL');
    pages.push({ kind: 'machine', options: { payload, gridStyle, paper } });
  }

  // The binary pitch grid cannot shrink to a band — twelve bit rows plus a
  // write-in row needs the full height — so it is always its own page.
  if (values.neumes) {
    const role = getRole('NEU');
    pages.push({
      kind: 'solo',
      options: { role, payload: soloPayload(sheetId, 99, role.id), gridStyle, paper },
    });
  }

  const pdf = await buildDocument({ pages, title: `Oramics drawing sheets — ${sheetId}` });

  const outPath = resolve(process.cwd(), values.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, pdf);

  console.log(`sheet id      ${sheetId}`);
  console.log(`layout        ${layout}`);
  console.log(`paper         ${paper}`);
  console.log(`pages         ${pages.length}  (${pages.map((p) => p.kind).join(', ')})`);
  console.log(
    `time field    ${(TIME_FIELD_WIDTH_MM * paperScale(paper)).toFixed(1)} mm at ` +
      `${(NOMINAL_SPEED_MM_PER_S * paperScale(paper)).toFixed(1)} mm/s = ${SHEET_DURATION_S.toFixed(3)} s`,
  );
  console.log(`grid          ${gridStyle}`);
  console.log(`written       ${outPath}`);
  console.log(`\nPrint at 100% / "Actual size". Do not scale to fit.`);
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
