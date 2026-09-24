/**
 * The QR payload. A printed sheet describes itself completely, so importing is
 * a scan-and-drop operation with no manual lane assignment and no need for the
 * operator to know what speed the sheet was drawn for.
 *
 * Format, pipe-free so it stays inside QR alphanumeric mode (0-9 A-Z and
 * "$%*+-./:" only, which is ~40% denser than byte mode):
 *
 *   ORAM1*<SHEET>*<LANE>*<ROLE>*<DURMS>*<FX>*<FY>*<FW>*<FH>
 *
 * SHEET  8 uppercase hex, groups sheets belonging to one piece
 * LANE   two digits, 01-99
 * ROLE   role id, see roles.ts
 * DURMS  intended duration of the field in milliseconds
 * FX FY  field top-left, relative to the top-left fiducial *centre*
 * FW FH  field size
 *
 * The four geometry values are in TENTHS of a millimetre so they stay integers
 * and stay inside alphanumeric mode. They are what lets the extractor find the
 * field after the homography without hardcoding this template's layout — a
 * later template revision can move the field and old sheets still import.
 */

import {
  SHEET_DURATION_S,
  type Layout,
  machineFieldRect,
  relativeToFiducials,
  soloFieldRect,
} from './geometry.js';

/**
 * ORAM2 moved the bands up the page and put the four timbres in a strip below
 * them, on the same sheet. The subdivision is implied by the version rather
 * than spelled out in the QR, so a layout change has to move the version with
 * it or an ORAM1 sheet would be read against ORAM2 rectangles.
 */
export const PAYLOAD_VERSION = 'ORAM2';

export interface SheetPayload {
  sheetId: string;
  lane: number;
  role: string;
  durationMs: number;
  /** Field rect relative to the top-left fiducial centre, in millimetres. */
  field: { x: number; y: number; w: number; h: number };
}

const toTenths = (mm: number): number => Math.round(mm * 10);
const fromTenths = (tenths: number): number => tenths / 10;

export const encodePayload = (p: SheetPayload): string =>
  [
    PAYLOAD_VERSION,
    p.sheetId.toUpperCase(),
    String(p.lane).padStart(2, '0'),
    p.role.toUpperCase(),
    String(Math.round(p.durationMs)),
    String(toTenths(p.field.x)),
    String(toTenths(p.field.y)),
    String(toTenths(p.field.w)),
    String(toTenths(p.field.h)),
  ].join('*');

export const decodePayload = (text: string): SheetPayload => {
  const parts = text.trim().toUpperCase().split('*');
  if (parts[0] !== PAYLOAD_VERSION) {
    throw new Error(
      `Not an Oramics sheet payload (expected ${PAYLOAD_VERSION}, got "${parts[0] ?? ''}")`,
    );
  }
  if (parts.length !== 9) {
    throw new Error(`Malformed payload: expected 9 fields, got ${parts.length}`);
  }
  const num = (i: number, name: string): number => {
    const v = Number(parts[i]);
    if (!Number.isFinite(v)) throw new Error(`Malformed ${name}: "${parts[i]}"`);
    return v;
  };
  return {
    sheetId: parts[1]!,
    lane: num(2, 'lane'),
    role: parts[3]!,
    durationMs: num(4, 'duration'),
    field: {
      x: fromTenths(num(5, 'field.x')),
      y: fromTenths(num(6, 'field.y')),
      w: fromTenths(num(7, 'field.w')),
      h: fromTenths(num(8, 'field.h')),
    },
  };
};

/** Build the payload for a standard solo sheet. */
export const soloPayload = (
  sheetId: string,
  lane: number,
  role: string,
  durationMs = SHEET_DURATION_S * 1000,
): SheetPayload => ({
  sheetId,
  lane,
  role,
  durationMs,
  field: relativeToFiducials(soloFieldRect()),
});

/**
 * Layout id for the whole sheet. It occupies the ROLE slot, and the band and
 * panel subdivision is looked up from `machineBands()` / `slidePanels()` for
 * the payload version rather than being spelled out in the QR — twelve
 * rectangles would not fit, and they are fully determined by the version
 * anyway. Bump PAYLOAD_VERSION if the subdivision ever changes.
 */
export const LAYOUT_SHEET = 'FULL';

/** The note-and-octave sheet. Same field, different bands inside it. */
export const LAYOUT_TONAL = 'TONE';

/** Which bands a payload's sheet carries. Anything unrecognised reads as FULL. */
export const layoutOf = (payload: SheetPayload | null): Layout =>
  payload?.role === LAYOUT_TONAL ? 'TONE' : 'FULL';

/**
 * Payload for the sheet.
 *
 * The declared field is the band region, because that is the one the declared
 * duration applies to. The timbre strip is phase rather than time and has no
 * duration to declare, so it comes from `slidePanels()` for this version along
 * with the band subdivision.
 */
export const sheetPayload = (
  sheetId: string,
  durationMs = SHEET_DURATION_S * 1000,
  layout: Layout = 'FULL',
): SheetPayload => ({
  sheetId,
  lane: 0,
  role: layout === 'TONE' ? LAYOUT_TONAL : LAYOUT_SHEET,
  durationMs,
  field: relativeToFiducials(machineFieldRect()),
});

/** Deterministic-length id. Pass a source of randomness so callers can seed it. */
export const makeSheetId = (rand: () => number = Math.random): string =>
  Array.from({ length: 8 }, () =>
    Math.floor(rand() * 16)
      .toString(16)
      .toUpperCase(),
  ).join('');
