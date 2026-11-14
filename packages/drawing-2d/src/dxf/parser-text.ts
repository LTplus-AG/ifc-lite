/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** TEXT / MTEXT entity parsing and inline-format decoding. */

import { dxfEstimatedTextWidth } from './text-layout.js';
import { int, num, parseCommon } from './parser-util.js';
import type { DxfPair, DxfTextEntity } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// TEXT DECODING
// ═══════════════════════════════════════════════════════════════════════════

/** Decode DXF special sequences (%%d, %%p, %%c, \U+XXXX). */
export function decodeDxfText(raw: string): string {
  return raw
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'Ø')
    .replace(/%%[uUoO]/g, '') // underline/overline toggles
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Strip MTEXT inline formatting down to plain text. Best-effort. */
export function stripMtextFormatting(raw: string): string {
  let s = raw;
  s = s.replace(/\\\\/g, '\u0001'); // placeholder protecting literal backslashes
  s = s.replace(/\\P/g, '\n');
  s = s.replace(/\\~/g, ' ');
  s = s.replace(/\\S([^;]*)\^\s?([^;]*);/g, '$1/$2'); // stacked fractions
  s = s.replace(/\\[ACFHQTWfp][^;]*;/g, ''); // parametrised format codes
  s = s.replace(/\\[LlOoKkX]/g, ''); // toggle codes
  s = s.replace(/[{}]/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\u0001/g, '\\');
  return decodeDxfText(s);
}

export function parseText(body: DxfPair[]): DxfTextEntity {
  const e: DxfTextEntity = {
    ...parseCommon(body),
    kind: 'text',
    x: 0,
    y: 0,
    height: 1,
    rotationDeg: 0,
    text: '',
    hAlign: 'left',
    vAlign: 'baseline',
  };
  let alignX: number | null = null;
  let alignY: number | null = null;
  let hJust = 0;
  let vJust = 0;
  let widthFactor = 1;
  for (const { code, value } of body) {
    switch (code) {
      case 10:
        e.x = num(value);
        break;
      case 20:
        e.y = num(value);
        break;
      case 11:
        alignX = num(value);
        break;
      case 21:
        alignY = num(value);
        break;
      case 40:
        e.height = num(value);
        break;
      case 41:
        widthFactor = num(value);
        break;
      case 50:
        e.rotationDeg = num(value);
        break;
      case 72:
        hJust = int(value);
        break;
      case 73:
        vJust = int(value);
        break;
      case 1:
        e.text = decodeDxfText(value);
        break;
    }
  }
  // Aligned (3) / Fit (5) span points 10-11; the span is measured against a
  // documented glyph-width estimate (see dxfEstimatedTextWidth).
  const stretched = hJust === 3 || hJust === 5;
  if (stretched && alignX !== null && alignY !== null) {
    const span = Math.hypot(alignX - e.x, alignY - e.y);
    const naturalWidth = dxfEstimatedTextWidth(e.text, e.height);
    if (span > 0 && naturalWidth > 0) {
      e.rotationDeg = Math.atan2(alignY - e.y, alignX - e.x) * 180 / Math.PI;
      e.fitWidth = span;
      const fit = span / naturalWidth;
      // Aligned scales height and width together; fit keeps the height and
      // stretches only along the baseline. Both start at point 10.
      if (hJust === 3) e.height *= fit;
      else e.widthScale = fit;
    }
  } else if (Number.isFinite(widthFactor) && widthFactor > 0 && widthFactor !== 1) e.widthScale = widthFactor;
  if (hJust === 1 || hJust === 4) e.hAlign = 'center';
  else if (hJust === 2) e.hAlign = 'right';
  if (stretched) e.vAlign = 'baseline';
  else if (vJust === 1) e.vAlign = 'bottom';
  else if (vJust === 2 || (vJust === 0 && hJust === 4)) e.vAlign = 'middle'; // Middle (72=4) centres both ways
  else if (vJust === 3) e.vAlign = 'top';
  // Other non-default justification anchors at the second alignment point.
  if (!stretched && (hJust || vJust) && alignX !== null && alignY !== null) { e.x = alignX; e.y = alignY; }
  return e;
}

export function parseMtext(body: DxfPair[]): DxfTextEntity {
  const e: DxfTextEntity = {
    ...parseCommon(body),
    kind: 'text',
    x: 0,
    y: 0,
    height: 1,
    rotationDeg: 0,
    text: '',
    hAlign: 'left',
    vAlign: 'top', // MTEXT default attachment is top-left
  };
  let chunks = '';
  let dirX: number | null = null;
  let dirY: number | null = null;
  let lineSpacingFactor = 1;
  for (const { code, value } of body) {
    switch (code) {
      case 10:
        e.x = num(value);
        break;
      case 20:
        e.y = num(value);
        break;
      case 40:
        e.height = num(value);
        break;
      case 44: {
        const factor = Number.parseFloat(value);
        lineSpacingFactor = Number.isFinite(factor) ? Math.max(0.25, Math.min(4, factor)) : 1;
        break;
      }
      case 50:
        e.rotationDeg = num(value);
        break;
      case 11:
        dirX = num(value);
        break;
      case 21:
        dirY = num(value);
        break;
      case 71: {
        const attach = int(value); // 1..9 grid: rows top/middle/bottom, columns left/center/right
        const col = (attach - 1) % 3;
        const row = Math.floor((attach - 1) / 3);
        e.hAlign = col === 1 ? 'center' : col === 2 ? 'right' : 'left';
        e.vAlign = row === 1 ? 'middle' : row === 2 ? 'bottom' : 'top';
        break;
      }
      case 3:
        chunks += value;
        break;
      case 1:
        chunks += value;
        break;
    }
  }
  if (dirX !== null && dirY !== null && (dirX !== 0 || dirY !== 0)) {
    e.rotationDeg = (Math.atan2(dirY, dirX) * 180) / Math.PI;
  }
  e.text = stripMtextFormatting(chunks);
  e.lineSpacingFactor = lineSpacingFactor;
  return e;
}
