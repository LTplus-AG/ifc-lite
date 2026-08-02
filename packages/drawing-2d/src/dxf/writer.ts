/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ASCII DXF writer (issue #1861): the counterpart to `parser.ts` (DXF
 * import, #1782). Produces DXF R12 (AC1009) text — HEADER, TABLES (LTYPE,
 * STYLE, LAYER), ENTITIES — from generic entities (POLYLINE/VERTEX/SEQEND,
 * LINE, TEXT) with a layer name and colour, so any CAD/BIM tool that reads
 * plain ASCII DXF can open the result.
 *
 * R12 is deliberate, not a placeholder: entity handles (group 5) and
 * subclass markers (group 100, e.g. `AcDbEntity`/`AcDbPolyline`) are
 * MANDATORY from R13 onward, and a genuinely valid R2000+ file additionally
 * needs a BLOCK_RECORD table, `*Model_Space`/`*Paper_Space` BLOCKS, and an
 * OBJECTS section with the root dictionary — none of which this writer
 * produces. Declaring a later `$ACADVER` while omitting all of that would
 * make the file reject or force-repair in strict readers (AutoCAD,
 * ODA/Teigha-based BIM tools). R12 requires none of it and is the universal
 * interop baseline every DXF-capable tool still reads; a full R2000+
 * skeleton (handles, subclass markers, BLOCK_RECORD, paper space, OBJECTS)
 * is a possible follow-up, not this writer's job.
 *
 * Consequences of the R12 target:
 *  - No `$INSUNITS` header variable (introduced in R14) — the exported
 *    unit (always metres) is instead stated in a `999` comment at the very
 *    top of the file (valid in every DXF version, ignored by every reader).
 *  - `LWPOLYLINE` doesn't exist until R14 either; polylines are written as
 *    classic `POLYLINE` + `VERTEX`* + `SEQEND`.
 *  - No group 5 (handle) or group 100 (subclass marker) anywhere in this
 *    file — `writer.test.ts` asserts that invariant so a future edit can't
 *    reintroduce a half-upgraded, invalid hybrid. The same goes for LTYPE
 *    group 74 (complex-linetype element type, R13+): R12 linetype patterns
 *    are plain `49` dash lengths only.
 *  - Symbol (layer) names follow the R12 rules: at most 31 characters from
 *    `A-Z a-z 0-9 $ - _` — see {@link sanitizeDxfLayerName}. Distinct
 *    source names that collide after sanitizing get a numeric suffix so
 *    they never silently merge into one layer.
 *  - TABLES carries LTYPE, STYLE (the `STANDARD` text style every TEXT
 *    entity implicitly references), and LAYER. VPORT/VIEW/UCS/APPID/
 *    DIMSTYLE are optional in R12 (readers create defaults) and are
 *    omitted.
 *
 * Coordinates are written verbatim in the caller's unit (drawing metres);
 * see `dxf-exporter.ts` for how the viewer maps its render-frame
 * coordinates into true world/map metres before they reach this writer.
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

/** Default `999` comment prepended to the file (states units — R12 has no `$INSUNITS`). */
const DEFAULT_HEADER_COMMENT = 'ifc-lite section export - units: metres';

/**
 * R12 symbol (table-entry) names allow only letters, digits, `$`, `-` and
 * `_` — anything else (unicode, spaces, punctuation) must be replaced.
 * Later DXF versions relax this, but this writer targets R12 (see module
 * docs), so it enforces the strict R12 set.
 */
const INVALID_LAYER_CHARS = /[^A-Za-z0-9$_-]/g;

/** R12 symbol names are limited to 31 characters (255 is an R2000+ limit). */
const MAX_LAYER_NAME_LENGTH = 31;

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
 * Sanitize a free-text label into a valid DXF R12 LAYER name: every
 * character outside the R12 symbol-name set (`A-Z a-z 0-9 $ - _` — spaces,
 * unicode and punctuation included) becomes `_`, runs of `_` produced by
 * adjacent replacements are collapsed, the result is made non-empty, and
 * truncated to the R12 31-character symbol-name limit.
 *
 * Distinct inputs can collide after this mapping (`Wände`/`Wønde` →
 * `W_nde`); {@link DxfWriter.layer} disambiguates with a numeric suffix so
 * two source layers never silently merge.
 */
export function sanitizeDxfLayerName(name: string): string {
  const stripped = name.replace(INVALID_LAYER_CHARS, '_').replace(/_{2,}/g, '_');
  const trimmed = stripped.replace(/^_+|_+$/g, '') || stripped;
  const safe = trimmed.length > 0 ? trimmed : 'LAYER';
  return safe.slice(0, MAX_LAYER_NAME_LENGTH);
}

/** Sanitize a single line of DXF TEXT content: strip control characters (no raw newlines). */
function sanitizeDxfText(text: string): string {
  return stripControlChars(text, ' ');
}

/** Sanitize a `999` comment line: no raw newlines/control characters. */
function sanitizeDxfComment(text: string): string {
  return stripControlChars(text, ' ');
}

function fmt(n: number): string {
  // Non-finite input stays deterministic ('0.0'); the condition is surfaced
  // to the caller via DxfWriter.extend()'s once-per-document console.warn.
  if (!Number.isFinite(n)) return '0.0';
  // Fixed precision keeps output deterministic (stable for golden/round-trip
  // tests) while giving sub-micrometre resolution at metre scale.
  return n.toFixed(6);
}

interface EntityWrite {
  (): string;
}

export interface DxfWriterOptions {
  /**
   * `999` comment written at the very top of the file, before the HEADER
   * section (valid DXF in every version; the conventional place to state
   * metadata a reader should show a human but never needs to parse — here,
   * the unit R12 can't declare via `$INSUNITS`). Defaults to a generic
   * "units: metres" note; pass a longer string (e.g. including the
   * `IfcProjectedCRS` name) for a georeferenced export.
   */
  headerComment?: string;
}

/**
 * Accumulates DXF entities and layer definitions, then assembles the full
 * ASCII DXF R12 (AC1009) document text. One writer instance == one DXF
 * file; layers are registered on first use (`addPolyline`/`addLine`/
 * `addText`) via a CSS colour, resolved to the nearest ACI with
 * {@link cssToAci}.
 */
export class DxfWriter {
  private readonly layers = new Map<string, DxfLayerRecord>();
  /** Raw (pre-sanitization) name → assigned safe name, for stable reuse + collision disambiguation. */
  private readonly layerNameBySource = new Map<string, string>();
  private readonly entities: EntityWrite[] = [];
  private readonly headerComment: string;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  /** One warning per document for non-finite input coordinates — see extend(). */
  private warnedNonFinite = false;

  constructor(options: DxfWriterOptions = {}) {
    this.headerComment = sanitizeDxfComment(options.headerComment ?? DEFAULT_HEADER_COMMENT);
  }

  private extend(p: Point2D): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      // A bad upstream coordinate (e.g. a pathological georeference scale)
      // would otherwise vanish silently: NaN fails every comparison below, so
      // it never extends $EXTMIN/$EXTMAX, and fmt() writes it as a
      // deterministic 0.0. Keep both behaviours (the file stays valid and
      // reproducible) but surface the problem — once per document, not per
      // vertex, so a fully-degenerate polyline can't spam the console.
      if (!this.warnedNonFinite) {
        this.warnedNonFinite = true;
        console.warn(
          `[DxfWriter] non-finite coordinate (${p.x}, ${p.y}) — written as 0.0 and excluded from $EXTMIN/$EXTMAX (further occurrences in this document are not logged)`,
        );
      }
      return;
    }
    if (p.x < this.minX) this.minX = p.x;
    if (p.x > this.maxX) this.maxX = p.x;
    if (p.y < this.minY) this.minY = p.y;
    if (p.y > this.maxY) this.maxY = p.y;
  }

  /**
   * Register (or reuse) a layer. Returns the sanitized layer name to pass to
   * `addPolyline`/`addLine`/`addText`. Re-registering the same source name
   * with a different colour/linetype is a no-op (first registration wins) —
   * callers should derive one style per logical layer. DIFFERENT source
   * names whose sanitized forms collide (`Wände`/`Wønde` → `W_nde`) get a
   * numeric suffix (`W_nde`, `W_nde_2`, …) instead of silently merging onto
   * one layer.
   */
  layer(name: string, cssColor: string, linetype: DxfLinetype = 'CONTINUOUS'): string {
    const assigned = this.layerNameBySource.get(name);
    if (assigned !== undefined) return assigned;
    const base = sanitizeDxfLayerName(name);
    let safe = base;
    for (let n = 2; this.layers.has(safe); n++) {
      const suffix = `_${n}`;
      safe = base.slice(0, MAX_LAYER_NAME_LENGTH - suffix.length) + suffix;
    }
    this.layers.set(safe, { name: safe, aci: cssToAci(cssColor), linetype });
    this.layerNameBySource.set(name, safe);
    return safe;
  }

  /** `62\n<aci>\n` when an entity overrides its layer's colour, else ''. */
  private colorOverrideGroup(cssColor: string | undefined): string {
    return cssColor !== undefined ? '62\n' + cssToAci(cssColor) + '\n' : '';
  }

  /**
   * Add a closed or open polyline (tessellated arcs/circles are pre-sampled
   * by the caller), written as classic `POLYLINE` + `VERTEX`* + `SEQEND` —
   * `LWPOLYLINE` does not exist before R14. `colorOverride` (CSS colour)
   * emits a per-entity ACI (group 62) on the POLYLINE header instead of
   * inheriting the layer colour — used when several IFC types share one
   * category layer but render with distinct colours in the source drawing
   * (matching the SVG exporter's per-entity fill/stroke).
   */
  addPolyline(points: readonly Point2D[], layer: string, closed: boolean, colorOverride?: string): void {
    if (points.length < 2) return;
    for (const p of points) this.extend(p);
    const pts = points.slice();
    const colorGroup = this.colorOverrideGroup(colorOverride);
    this.entities.push(() => {
      // The 10/20/30 "dummy point" (always 0) is part of the R12 POLYLINE
      // entity — the real coordinates live on the VERTEX chain.
      let s =
        '0\nPOLYLINE\n8\n' + layer + '\n' + colorGroup +
        '66\n1\n10\n0.0\n20\n0.0\n30\n0.0\n70\n' + (closed ? 1 : 0) + '\n';
      for (const p of pts) {
        s += '0\nVERTEX\n8\n' + layer + '\n10\n' + fmt(p.x) + '\n20\n' + fmt(p.y) + '\n30\n0.0\n';
      }
      s += '0\nSEQEND\n8\n' + layer + '\n';
      return s;
    });
  }

  /** Add a single straight segment. `colorOverride`: see {@link addPolyline}. */
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
   * single line. `colorOverride`: see {@link addPolyline}.
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
    // `height <= 0` alone lets NaN/Infinity through (both compare false), and
    // `fmt` would then write them as the deterministic '0.0' fallback — i.e. a
    // zero-height, invisible TEXT entity, exactly what the guard exists to
    // skip. Reject non-finite heights outright instead.
    if (!clean.trim() || !Number.isFinite(height) || height <= 0) return;
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
        '72\n' + hCode + '\n' +
        '73\n' + vCode + '\n';
      if (needsAlignPoint) {
        s += '11\n' + fmt(position.x) + '\n21\n' + fmt(position.y) + '\n31\n0.0\n';
      }
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
    // R12 (AC1009): no $INSUNITS (introduced R14) — see the `999` comment
    // this.toString() prepends ahead of this section instead.
    return (
      '0\nSECTION\n2\nHEADER\n' +
      '9\n$ACADVER\n1\nAC1009\n' +
      '9\n$EXTMIN\n10\n' + fmt(minX) + '\n20\n' + fmt(minY) + '\n30\n0.0\n' +
      '9\n$EXTMAX\n10\n' + fmt(maxX) + '\n20\n' + fmt(maxY) + '\n30\n0.0\n' +
      '0\nENDSEC\n'
    );
  }

  private buildLtypeTable(): string {
    let s = '0\nTABLE\n2\nLTYPE\n70\n2\n';
    s += '0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n';
    // Dash 0.2, gap 0.1 (metres) — a reasonable default at typical drawing
    // scale. R12 pattern elements are plain `49` lengths; group 74
    // (complex-linetype element type) is an R13+ construct and must NOT
    // appear here.
    s +=
      '0\nLTYPE\n2\nDASHED\n70\n0\n3\nDashed line\n72\n65\n73\n2\n40\n0.3\n' +
      '49\n0.2\n49\n-0.1\n';
    s += '0\nENDTAB\n';
    return s;
  }

  /**
   * STYLE table with the single `STANDARD` text style. Every TEXT entity
   * this writer emits carries no group 7 and therefore implicitly
   * references STANDARD; defining it keeps strict R12 readers from having
   * to invent it. (Fixed-height 0, width factor 1, `txt` font — the
   * classic defaults.)
   */
  private buildStyleTable(): string {
    return (
      '0\nTABLE\n2\nSTYLE\n70\n1\n' +
      '0\nSTYLE\n2\nSTANDARD\n70\n0\n40\n0.0\n41\n1.0\n50\n0.0\n71\n0\n42\n0.2\n3\ntxt\n4\n\n' +
      '0\nENDTAB\n'
    );
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
    // LTYPE before LAYER (layers reference linetypes by name); STYLE for
    // the implicit STANDARD text style. VPORT/VIEW/UCS/APPID/DIMSTYLE are
    // optional in R12 — readers supply defaults — and are omitted.
    return (
      '0\nSECTION\n2\nTABLES\n' +
      this.buildLtypeTable() +
      this.buildStyleTable() +
      this.buildLayerTable() +
      '0\nENDSEC\n'
    );
  }

  private buildEntities(): string {
    let s = '0\nSECTION\n2\nENTITIES\n';
    for (const write of this.entities) s += write();
    s += '0\nENDSEC\n';
    return s;
  }

  /**
   * Assemble the full ASCII DXF R12 document: a leading `999` comment
   * (units — see class docs), then HEADER + TABLES + ENTITIES + EOF. No
   * BLOCKS/OBJECTS sections and no BLOCK_RECORD table — R12 doesn't require
   * them (unlike R13+, where their absence would make the file invalid).
   */
  toString(): string {
    // Any point written through addPolyline/addLine/addText must land on a
    // registered layer, so ensure at least the "0" default layer exists for
    // callers that add geometry before their first `layer()` call.
    if (!this.layers.has('0')) {
      this.layers.set('0', { name: '0', aci: 7, linetype: 'CONTINUOUS' });
    }
    return (
      '999\n' + this.headerComment + '\n' +
      this.buildHeader() + this.buildTables() + this.buildEntities() + '0\nEOF\n'
    );
  }
}
