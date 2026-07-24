/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ASCII DXF writer (issue #1861): the counterpart to `parser.ts` (DXF
 * import, #1782). Produces AC1015 (R2000) DXF text — HEADER, TABLES
 * (LTYPE, LAYER), ENTITIES — from generic entities (LWPOLYLINE / LINE /
 * TEXT) with a layer name and colour, so any CAD/BIM tool that reads plain
 * ASCII DXF can open the result.
 *
 * Coordinates are written verbatim in the caller's unit (drawing metres);
 * `$INSUNITS` is fixed to 6 (metres) — see `dxf-exporter.ts` for how the
 * viewer maps its render-frame coordinates into true world/map metres
 * before they reach this writer.
 */

import { cssToAci } from './aci-colors.js';
import type { Point2D } from '../types.js';

/** Line style resolved to a DXF linetype. `dashed` maps to the `DASHED` LTYPE. */
export type DxfLinetype = 'CONTINUOUS' | 'DASHED';

/** Horizontal text justification (subset of DXF group 72). */
export type DxfTextHAlign = 'left' | 'center' | 'right';
/** Vertical text justification (subset of DXF group 73). */
export type DxfTextVAlign = 'baseline' | 'bottom' | 'middle' | 'top';

interface DxfLayerRecord {
  /** Sanitized, DXF-safe layer name (used as the table key and entity group 8). */
  name: string;
  aci: number;
  linetype: DxfLinetype;
}

const H_ALIGN_CODE: Record<DxfTextHAlign, number> = { left: 0, center: 1, right: 2 };
const V_ALIGN_CODE: Record<DxfTextVAlign, number> = { baseline: 0, bottom: 1, middle: 2, top: 3 };

/** DXF §5.7: table/layer names forbid these characters (control codes are stripped separately). */
const INVALID_LAYER_CHARS = /[<>/\\":;?*|=`]/g;

/**
 * True for an ASCII control character (C0 range or DEL) — these are never
 * legal inside a DXF layer name or TEXT string. Written as a codepoint
 * comparison rather than a control-character regex literal (`\x00`-`\x1f`)
 * so the disallowed bytes never appear as raw source text.
 */
function isControlCharCode(code: number): boolean {
  return code <= 31 || code === 127;
}

function stripControlChars(text: string, replacement: string): string {
  let out = '';
  for (const ch of text) {
    out += isControlCharCode(ch.codePointAt(0) ?? 0) ? replacement : ch;
  }
  return out;
}

/**
 * Sanitize a free-text label into a valid DXF LAYER name: strips characters
 * the DXF spec forbids in table names, replaces whitespace with `_` (spaces
 * are technically legal in a DXF name but trip up some CAD tools' layer
 * pickers), collapses the result to something non-empty, and truncates to
 * the 255-byte symbol name limit.
 */
export function sanitizeDxfLayerName(name: string): string {
  const stripped = stripControlChars(name.replace(INVALID_LAYER_CHARS, '_'), '_')
    .trim()
    .replace(/\s+/g, '_');
  const safe = stripped.length > 0 ? stripped : 'LAYER';
  return safe.slice(0, 255);
}

/** Sanitize a single line of DXF TEXT content: strip control characters (no raw newlines). */
function sanitizeDxfText(text: string): string {
  return stripControlChars(text, ' ');
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0.0';
  // Fixed precision keeps output deterministic (stable for golden/round-trip
  // tests) while giving sub-micrometre resolution at metre scale.
  return n.toFixed(6);
}

interface EntityWrite {
  (): string;
}

/**
 * Accumulates DXF entities and layer definitions, then assembles the full
 * ASCII DXF document text. One writer instance == one DXF file; layers are
 * registered on first use (`addLwPolyline`/`addLine`/`addText`) via a CSS
 * colour, resolved to the nearest ACI with {@link cssToAci}.
 */
export class DxfWriter {
  private readonly layers = new Map<string, DxfLayerRecord>();
  private readonly entities: EntityWrite[] = [];
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  private extend(p: Point2D): void {
    if (p.x < this.minX) this.minX = p.x;
    if (p.x > this.maxX) this.maxX = p.x;
    if (p.y < this.minY) this.minY = p.y;
    if (p.y > this.maxY) this.maxY = p.y;
  }

  /**
   * Register (or reuse) a layer. Returns the sanitized layer name to pass to
   * `addLwPolyline`/`addLine`/`addText`. Re-registering an existing name with
   * a different colour/linetype is a no-op (first registration wins) —
   * callers should derive one style per logical layer.
   */
  layer(name: string, cssColor: string, linetype: DxfLinetype = 'CONTINUOUS'): string {
    const safe = sanitizeDxfLayerName(name);
    if (!this.layers.has(safe)) {
      this.layers.set(safe, { name: safe, aci: cssToAci(cssColor), linetype });
    }
    return safe;
  }

  /** `62\n<aci>\n` when an entity overrides its layer's colour, else ''. */
  private colorOverrideGroup(cssColor: string | undefined): string {
    return cssColor !== undefined ? '62\n' + cssToAci(cssColor) + '\n' : '';
  }

  /**
   * Add a closed or open polyline (tessellated arcs/circles are pre-sampled
   * by the caller). `colorOverride` (CSS colour) emits a per-entity ACI
   * (group 62) instead of inheriting the layer colour — used when several
   * IFC types share one category layer but render with distinct colours in
   * the source drawing (matching the SVG exporter's per-entity fill/stroke).
   */
  addLwPolyline(points: readonly Point2D[], layer: string, closed: boolean, colorOverride?: string): void {
    if (points.length < 2) return;
    for (const p of points) this.extend(p);
    const pts = points.slice();
    const colorGroup = this.colorOverrideGroup(colorOverride);
    this.entities.push(() => {
      let s =
        '0\nLWPOLYLINE\n8\n' + layer + '\n' + colorGroup +
        '90\n' + pts.length + '\n70\n' + (closed ? 1 : 0) + '\n43\n0.0\n';
      for (const p of pts) {
        s += '10\n' + fmt(p.x) + '\n20\n' + fmt(p.y) + '\n';
      }
      return s;
    });
  }

  /** Add a single straight segment. `colorOverride`: see {@link addLwPolyline}. */
  addLine(start: Point2D, end: Point2D, layer: string, colorOverride?: string): void {
    this.extend(start);
    this.extend(end);
    const colorGroup = this.colorOverrideGroup(colorOverride);
    this.entities.push(
      () =>
        '0\nLINE\n8\n' + layer + '\n' + colorGroup +
        '10\n' + fmt(start.x) + '\n20\n' + fmt(start.y) + '\n30\n0.0\n' +
        '11\n' + fmt(end.x) + '\n21\n' + fmt(end.y) + '\n31\n0.0\n',
    );
  }

  /**
   * Add single-line text. Multiline callers (annotations/MTEXT) should split
   * on `\n` and call this once per line, offsetting `position` themselves
   * (matching the SVG exporter's tspan stacking) — DXF `TEXT` group 1 is a
   * single line. `colorOverride`: see {@link addLwPolyline}.
   */
  addText(
    position: Point2D,
    text: string,
    height: number,
    layer: string,
    options: {
      rotationDeg?: number;
      hAlign?: DxfTextHAlign;
      vAlign?: DxfTextVAlign;
      colorOverride?: string;
    } = {},
  ): void {
    const clean = sanitizeDxfText(text);
    if (!clean.trim() || height <= 0) return;
    this.extend(position);
    const rotationDeg = options.rotationDeg ?? 0;
    const hAlign = options.hAlign ?? 'left';
    const vAlign = options.vAlign ?? 'baseline';
    const hCode = H_ALIGN_CODE[hAlign];
    const vCode = V_ALIGN_CODE[vAlign];
    const needsAlignPoint = hCode !== 0 || vCode !== 0;
    const colorGroup = this.colorOverrideGroup(options.colorOverride);
    this.entities.push(() => {
      let s =
        '0\nTEXT\n8\n' + layer + '\n' + colorGroup +
        '10\n' + fmt(position.x) + '\n20\n' + fmt(position.y) + '\n30\n0.0\n' +
        '40\n' + fmt(height) + '\n1\n' + clean + '\n' +
        '50\n' + fmt(rotationDeg) + '\n' +
        '72\n' + hCode + '\n';
      if (needsAlignPoint) {
        s += '11\n' + fmt(position.x) + '\n21\n' + fmt(position.y) + '\n31\n0.0\n';
      }
      s += '73\n' + vCode + '\n';
      return s;
    });
  }

  /** True once at least one finite point has been written (controls $EXTMIN/$EXTMAX). */
  private hasExtents(): boolean {
    return Number.isFinite(this.minX) && Number.isFinite(this.maxX);
  }

  private buildHeader(): string {
    const [minX, minY, maxX, maxY] = this.hasExtents()
      ? [this.minX, this.minY, this.maxX, this.maxY]
      : [0, 0, 0, 0];
    return (
      '0\nSECTION\n2\nHEADER\n' +
      '9\n$ACADVER\n1\nAC1015\n' +
      '9\n$INSUNITS\n70\n6\n' +
      '9\n$EXTMIN\n10\n' + fmt(minX) + '\n20\n' + fmt(minY) + '\n30\n0.0\n' +
      '9\n$EXTMAX\n10\n' + fmt(maxX) + '\n20\n' + fmt(maxY) + '\n30\n0.0\n' +
      '0\nENDSEC\n'
    );
  }

  private buildLtypeTable(): string {
    let s = '0\nTABLE\n2\nLTYPE\n70\n2\n';
    s += '0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n';
    // Dash 0.2, gap 0.1 (metres) — a reasonable default at typical drawing scale.
    s +=
      '0\nLTYPE\n2\nDASHED\n70\n0\n3\nDashed line\n72\n65\n73\n2\n40\n0.3\n' +
      '49\n0.2\n74\n0\n49\n-0.1\n74\n0\n';
    s += '0\nENDTAB\n';
    return s;
  }

  private buildLayerTable(): string {
    let s = '0\nTABLE\n2\nLAYER\n70\n' + this.layers.size + '\n';
    for (const l of this.layers.values()) {
      s += '0\nLAYER\n2\n' + l.name + '\n70\n0\n62\n' + l.aci + '\n6\n' + l.linetype + '\n';
    }
    s += '0\nENDTAB\n';
    return s;
  }

  private buildTables(): string {
    return '0\nSECTION\n2\nTABLES\n' + this.buildLtypeTable() + this.buildLayerTable() + '0\nENDSEC\n';
  }

  private buildEntities(): string {
    let s = '0\nSECTION\n2\nENTITIES\n';
    for (const write of this.entities) s += write();
    s += '0\nENDSEC\n';
    return s;
  }

  /** Assemble the full ASCII DXF document (HEADER + TABLES + ENTITIES + EOF). */
  toString(): string {
    // Any point written through addLwPolyline/addLine/addText must land on a
    // registered layer, so ensure at least the "0" default layer exists for
    // callers that add geometry before their first `layer()` call.
    if (!this.layers.has('0')) {
      this.layers.set('0', { name: '0', aci: 7, linetype: 'CONTINUOUS' });
    }
    return this.buildHeader() + this.buildTables() + this.buildEntities() + '0\nEOF\n';
  }
}
