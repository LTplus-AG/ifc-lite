/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PdfAppearanceError } from './types.js';
import type { PdfAffine } from './vector-types.js';

/** Resolved PDF.js font objects (`page.commonObjs`); only the advance metrics are read. */
export interface PdfFontObjects { has(id: string): boolean; get(id: string): unknown }
export type PdfTextRun = { quad: [number, number, number, number, number, number, number, number]; invisible: boolean };
interface TextState {
  tm: PdfAffine | null; x: number; y: number; lineX: number; lineY: number;
  fontSize: number; fontMatrix0: number; vertical: boolean;
  charSpacing: number; wordSpacing: number; hscale: number; leading: number; rise: number; mode: number;
}
const MAX_GLYPHS = 100_000;
const FONT_IDENTITY_MATRIX0 = 0.001;
/** Em-box estimate: text extents come from advances, never from glyph outlines. */
const ASCENT = 1, DESCENT = 0.3;
function fresh(): TextState {
  return { tm: null, x: 0, y: 0, lineX: 0, lineY: 0, fontSize: 0, fontMatrix0: FONT_IDENTITY_MATRIX0, vertical: false,
    charSpacing: 0, wordSpacing: 0, hscale: 1, leading: 0, rise: 0, mode: 0 };
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new PdfAppearanceError('unsupported', 'Invalid PDF text state argument.');
  return value;
}
/** Mirrors the pinned CanvasGraphics text state, including save/restore and
 * the implicit form/group scopes, so each run's origin and advance are placed
 * where PDF.js paints them. Heights are an em-box estimate. */
export class PdfTextTracker {
  private stack: TextState[] = [];
  private current = fresh();
  private clipPending = false;
  constructor(private readonly fonts: PdfFontObjects | undefined) {}
  save(): void { this.stack.push({ ...this.current }); }
  restore(): void { const previous = this.stack.pop(); if (previous) this.current = previous; }
  /** Annotation appearance streams start from a fresh state. */
  reset(): void { this.stack = []; this.current = fresh(); this.clipPending = false; }
  setFont(name: unknown, size: unknown): void {
    const fontSize = Math.abs(finite(size));
    let fontMatrix0 = FONT_IDENTITY_MATRIX0, vertical = false;
    if (typeof name === 'string' && this.fonts?.has(name)) {
      const font = this.fonts.get(name) as { fontMatrix?: unknown; vertical?: unknown } | null;
      const matrix = font?.fontMatrix;
      if (Array.isArray(matrix) && typeof matrix[0] === 'number' && Number.isFinite(matrix[0]) && matrix[0] !== 0) fontMatrix0 = matrix[0];
      vertical = font?.vertical === true;
    }
    Object.assign(this.current, { fontSize, fontMatrix0, vertical });
  }
  /** True when the operator belongs to text state and was consumed. */
  operate(name: string, args: unknown[]): boolean {
    const c = this.current;
    switch (name) {
      case 'beginText': c.tm = null; c.x = c.y = c.lineX = c.lineY = 0; return true;
      case 'endText': return true;
      case 'setFont': this.setFont(args[0], args[1]); return true;
      case 'setTextMatrix': {
        const m = args[0];
        if (!Array.isArray(m) && !(m instanceof Float32Array) && !(m instanceof Float64Array)) throw new PdfAppearanceError('unsupported', 'Invalid PDF text matrix.');
        const values = Array.from(m as ArrayLike<unknown>, finite);
        if (values.length !== 6) throw new PdfAppearanceError('unsupported', 'Invalid PDF text matrix.');
        c.tm = values as PdfAffine; c.x = c.y = c.lineX = c.lineY = 0; return true;
      }
      case 'moveText': c.x = c.lineX += finite(args[0]); c.y = c.lineY += finite(args[1]); return true;
      case 'setLeadingMoveText': c.leading = finite(args[1]); c.x = c.lineX += finite(args[0]); c.y = c.lineY += finite(args[1]); return true;
      case 'setLeading': c.leading = -finite(args[0]); return true;
      case 'nextLine': c.x = c.lineX; c.y = c.lineY += c.leading; return true;
      case 'setCharSpacing': c.charSpacing = finite(args[0]); return true;
      case 'setWordSpacing': c.wordSpacing = finite(args[0]); return true;
      case 'setHScale': c.hscale = finite(args[0]) / 100; return true;
      case 'setTextRise': c.rise = finite(args[0]); return true;
      case 'setTextRenderingMode': c.mode = finite(args[0]); return true;
      default: return false;
    }
  }
  /** Consume one showText; returns the run extent or nothing when PDF.js paints nothing. */
  showText(glyphs: unknown, contentVisible: boolean): PdfTextRun | undefined {
    const c = this.current;
    if (!Array.isArray(glyphs) || glyphs.length > MAX_GLYPHS) throw new PdfAppearanceError('unsupported', 'Unexpected pinned PDF text arguments.');
    if (c.fontSize === 0) return;
    let advance = 0;
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') { advance -= glyph * c.fontSize / 1000; continue; }
      if (!glyph || typeof glyph !== 'object') throw new PdfAppearanceError('unsupported', 'Unexpected pinned PDF glyph layout.');
      const width = (glyph as { width?: unknown }).width, space = (glyph as { isSpace?: unknown }).isSpace === true;
      const w = typeof width === 'number' && Number.isFinite(width) ? width : 0;
      advance += w * c.fontMatrix0 * c.fontSize + c.charSpacing + (space ? c.wordSpacing : 0);
    }
    const invisible = c.mode === 3 || c.mode === 7;
    if (c.mode >= 4 && contentVisible) this.clipPending = true;
    const fs = c.fontSize;
    const box: [number, number, number, number] = c.vertical
      ? [c.x - fs / 2, c.y - advance, c.x + fs / 2, c.y + DESCENT * fs]
      : [c.x, c.y + c.rise - DESCENT * fs, c.x + advance * c.hscale, c.y + c.rise + ASCENT * fs];
    if (c.vertical) c.y -= advance; else c.x += advance * c.hscale;
    const corners = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] as const;
    const m = c.tm ?? [1, 0, 0, 1, 0, 0];
    const quad = corners.flatMap(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    if (!quad.every(Number.isFinite)) throw new PdfAppearanceError('unsupported', 'PDF text placement exceeds numeric range.');
    return { quad: quad as PdfTextRun['quad'], invisible };
  }
  /** ET adds painted clip-mode glyphs to the clip; report it once per text object. */
  endText(): boolean { const clip = this.clipPending; this.clipPending = false; return clip; }
}
