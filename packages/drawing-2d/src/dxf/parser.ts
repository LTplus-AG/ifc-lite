/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ASCII DXF parser (issue #1782).
 *
 * DXF is a stream of (group code, value) line pairs organised into sections.
 * This parser reads the sections that matter for a 2D reference underlay:
 * HEADER ($INSUNITS), TABLES (LAYER records), BLOCKS, and ENTITIES. It is
 * deliberately lenient: unknown group codes are ignored, unknown entity
 * types are counted in `skipped`, and truncated sections parse as far as
 * they go. Only structurally broken files (odd pairing, binary DXF) throw.
 */

import { sampleArc, sampleEllipse } from './geom.js';
import type {
  DxfArcEntity,
  DxfBlockInfo,
  DxfCircleEntity,
  DxfDimensionEntity,
  DxfDocument,
  DxfEllipseEntity,
  DxfEntity,
  DxfEntityCommon,
  DxfHatchEntity,
  DxfHatchPath,
  DxfInsertEntity,
  DxfLayerInfo,
  DxfLineEntity,
  DxfPair,
  DxfPolylineEntity,
  DxfTextEntity,
  DxfVertex,
} from './types.js';

const BINARY_DXF_SENTINEL = 'AutoCAD Binary DXF';

/** Cap on parsed entities (top level + per block) against hostile inputs. */
const MAX_ENTITIES = 500_000;

// ═══════════════════════════════════════════════════════════════════════════
// GROUP-CODE READER
// ═══════════════════════════════════════════════════════════════════════════

const GROUP_CODE_RE = /^-?\d+$/;

/** Split an ASCII DXF file into (code, value) pairs. */
export function readDxfPairs(text: string): DxfPair[] {
  if (text.startsWith(BINARY_DXF_SENTINEL)) {
    throw new Error('Binary DXF files are not supported; re-save as ASCII DXF.');
  }
  const lines = text.split(/\r\n|\r|\n/);
  // Trailing newlines produce empty final lines; tolerate them.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  const pairs: DxfPair[] = [];
  for (let i = 0; i < end; i += 2) {
    const codeStr = lines[i].trim();
    if (!GROUP_CODE_RE.test(codeStr)) {
      throw new Error(`Malformed DXF: expected a group code at line ${i + 1}, got "${codeStr.slice(0, 32)}"`);
    }
    if (i + 1 >= end) {
      throw new Error(`Malformed DXF: group code ${codeStr} at line ${i + 1} has no value line`);
    }
    pairs.push({ code: Number.parseInt(codeStr, 10), value: lines[i + 1] });
  }
  return pairs;
}

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
  s = s.replace(/\u0001/g, '\\');
  return decodeDxfText(s);
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════════════

function num(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function int(value: string): number {
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Index of the next pair with code 0 at or after `start` (or `end`). */
function nextEntityStart(pairs: DxfPair[], start: number, end: number): number {
  let i = start;
  while (i < end && pairs[i].code !== 0) i++;
  return i;
}

function findEndSec(pairs: DxfPair[], start: number): number {
  for (let i = start; i < pairs.length; i++) {
    if (pairs[i].code === 0 && pairs[i].value.trim() === 'ENDSEC') return i;
  }
  return pairs.length;
}

export function parseDxf(text: string): DxfDocument {
  const pairs = readDxfPairs(text);
  const doc: DxfDocument = {
    insunits: 0,
    layers: new Map(),
    blocks: new Map(),
    entities: [],
    skipped: {},
    warnings: [],
  };

  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i];
    if (p.code === 0 && p.value.trim() === 'EOF') break;
    if (p.code === 0 && p.value.trim() === 'SECTION') {
      const namePair = pairs[i + 1];
      const name = namePair && namePair.code === 2 ? namePair.value.trim() : '';
      const bodyStart = i + 2;
      const end = findEndSec(pairs, bodyStart);
      switch (name) {
        case 'HEADER':
          parseHeader(pairs, bodyStart, end, doc);
          break;
        case 'TABLES':
          parseTables(pairs, bodyStart, end, doc);
          break;
        case 'BLOCKS':
          parseBlocks(pairs, bodyStart, end, doc);
          break;
        case 'ENTITIES':
          doc.entities = parseEntityList(pairs, bodyStart, end, doc);
          break;
        default:
          break; // CLASSES, OBJECTS, THUMBNAILIMAGE — irrelevant here
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return doc;
}

function parseHeader(pairs: DxfPair[], start: number, end: number, doc: DxfDocument): void {
  for (let i = start; i < end; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim() === '$INSUNITS') {
      const next = pairs[i + 1];
      if (next && next.code === 70) doc.insunits = int(next.value);
      return;
    }
  }
}

function parseTables(pairs: DxfPair[], start: number, end: number, doc: DxfDocument): void {
  let i = start;
  while (i < end) {
    const p = pairs[i];
    if (p.code === 0 && p.value.trim() === 'LAYER') {
      const bodyEnd = nextEntityStart(pairs, i + 1, end);
      const layer: DxfLayerInfo = { name: '', colorNumber: 7, visible: true };
      for (let j = i + 1; j < bodyEnd; j++) {
        const { code, value } = pairs[j];
        switch (code) {
          case 2:
            layer.name = value.trim();
            break;
          case 62: {
            const c = int(value);
            if (c < 0) layer.visible = false; // layer is off
            layer.colorNumber = Math.abs(c) || 7;
            break;
          }
          case 70:
            if ((int(value) & 1) !== 0) layer.visible = false; // frozen
            break;
          case 6:
            layer.linetype = value.trim();
            break;
          case 420:
            layer.trueColor = int(value) & 0xffffff;
            break;
          case 370: {
            const lw = int(value);
            if (lw > 0) layer.lineweightMm = lw / 100;
            break;
          }
        }
      }
      if (layer.name) doc.layers.set(layer.name, layer);
      i = bodyEnd;
      continue;
    }
    i++;
  }
}

function parseBlocks(pairs: DxfPair[], start: number, end: number, doc: DxfDocument): void {
  let i = start;
  while (i < end) {
    const p = pairs[i];
    if (p.code === 0 && p.value.trim() === 'BLOCK') {
      const headerEnd = nextEntityStart(pairs, i + 1, end);
      const block: DxfBlockInfo = { name: '', baseX: 0, baseY: 0, entities: [] };
      for (let j = i + 1; j < headerEnd; j++) {
        const { code, value } = pairs[j];
        if (code === 2 && !block.name) block.name = value.trim();
        else if (code === 10) block.baseX = num(value);
        else if (code === 20) block.baseY = num(value);
      }
      // Entities run until the matching ENDBLK.
      let blockEnd = headerEnd;
      while (blockEnd < end && !(pairs[blockEnd].code === 0 && pairs[blockEnd].value.trim() === 'ENDBLK')) {
        blockEnd = nextEntityStart(pairs, blockEnd + 1, end);
      }
      block.entities = parseEntityList(pairs, headerEnd, blockEnd, doc);
      if (block.name) doc.blocks.set(block.name, block);
      i = blockEnd + 1;
      continue;
    }
    i++;
  }
}

/** Parse a run of entities between `start` and `end` (exclusive). */
function parseEntityList(pairs: DxfPair[], start: number, end: number, doc: DxfDocument): DxfEntity[] {
  const entities: DxfEntity[] = [];
  let i = nextEntityStart(pairs, start, end);

  while (i < end) {
    const type = pairs[i].value.trim();
    if (type === 'ENDSEC' || type === 'ENDBLK' || type === 'EOF') break;
    const bodyStart = i + 1;
    const bodyEnd = nextEntityStart(pairs, bodyStart, end);
    const body = pairs.slice(bodyStart, bodyEnd);

    if (entities.length >= MAX_ENTITIES) {
      doc.warnings.push(`Entity limit (${MAX_ENTITIES}) reached; remaining entities ignored.`);
      break;
    }

    switch (type) {
      case 'LINE':
        entities.push(parseLine(body));
        break;
      case 'LWPOLYLINE':
        entities.push(parseLwPolyline(body));
        break;
      case 'POLYLINE': {
        const { entity, next } = parsePolyline(pairs, body, bodyEnd, end);
        entities.push(entity);
        i = next;
        continue;
      }
      case 'CIRCLE':
        entities.push(parseCircle(body));
        break;
      case 'ARC':
        entities.push(parseArc(body));
        break;
      case 'ELLIPSE':
        entities.push(parseEllipse(body));
        break;
      case 'TEXT':
        entities.push(parseText(body));
        break;
      case 'MTEXT':
        entities.push(parseMtext(body));
        break;
      case 'SPLINE':
        entities.push(parseSpline(body, doc));
        break;
      case 'SOLID':
      case 'TRACE':
        entities.push(parseSolid(body));
        break;
      case 'INSERT':
        entities.push(parseInsert(body));
        break;
      case 'DIMENSION':
        entities.push(parseDimension(body));
        break;
      case 'HATCH':
        entities.push(parseHatch(body, doc));
        break;
      case 'VERTEX':
      case 'SEQEND':
        // Only meaningful inside a POLYLINE chain (handled there); stray
        // occurrences are ignored.
        break;
      case 'ATTRIB':
      case 'ATTDEF':
        // Block attribute definitions/values; not part of the graphic underlay.
        break;
      default:
        doc.skipped[type] = (doc.skipped[type] ?? 0) + 1;
        break;
    }
    i = bodyEnd;
  }
  return entities;
}

function parseCommon(body: DxfPair[]): DxfEntityCommon {
  const common: DxfEntityCommon = {
    layer: '0',
    colorNumber: 256,
    invisible: false,
    extrusionZ: 1,
  };
  for (const { code, value } of body) {
    switch (code) {
      case 8:
        common.layer = value.trim() || '0';
        break;
      case 62:
        common.colorNumber = int(value);
        break;
      case 420:
        common.trueColor = int(value) & 0xffffff;
        break;
      case 6:
        common.linetype = value.trim();
        break;
      case 370: {
        const lw = int(value); // 1/100 mm; negative values are BYLAYER/BYBLOCK/default
        if (lw > 0) common.lineweightMm = lw / 100;
        break;
      }
      case 60:
        common.invisible = int(value) === 1;
        break;
      case 230:
        common.extrusionZ = num(value);
        break;
    }
  }
  return common;
}

function parseLine(body: DxfPair[]): DxfLineEntity {
  const e: DxfLineEntity = { ...parseCommon(body), kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0 };
  for (const { code, value } of body) {
    if (code === 10) e.x1 = num(value);
    else if (code === 20) e.y1 = num(value);
    else if (code === 11) e.x2 = num(value);
    else if (code === 21) e.y2 = num(value);
  }
  return e;
}

function parseLwPolyline(body: DxfPair[]): DxfPolylineEntity {
  const e: DxfPolylineEntity = { ...parseCommon(body), kind: 'polyline', vertices: [], closed: false };
  let current: DxfVertex | null = null;
  for (const { code, value } of body) {
    switch (code) {
      case 10:
        current = { x: num(value), y: 0, bulge: 0 };
        e.vertices.push(current);
        break;
      case 20:
        if (current) current.y = num(value);
        break;
      case 42:
        if (current) current.bulge = num(value);
        break;
      case 70:
        e.closed = (int(value) & 1) !== 0;
        break;
    }
  }
  return e;
}

/** Classic POLYLINE: consume the following VERTEX chain up to SEQEND. */
function parsePolyline(
  pairs: DxfPair[],
  headerBody: DxfPair[],
  chainStart: number,
  end: number,
): { entity: DxfPolylineEntity; next: number } {
  const entity: DxfPolylineEntity = {
    ...parseCommon(headerBody),
    kind: 'polyline',
    vertices: [],
    closed: false,
  };
  for (const { code, value } of headerBody) {
    if (code === 70) entity.closed = (int(value) & 1) !== 0;
  }

  let i = chainStart;
  while (i < end && pairs[i].code === 0) {
    const type = pairs[i].value.trim();
    const bodyEnd = nextEntityStart(pairs, i + 1, end);
    if (type === 'VERTEX') {
      const v: DxfVertex = { x: 0, y: 0, bulge: 0 };
      let flags = 0;
      for (let j = i + 1; j < bodyEnd; j++) {
        const { code, value } = pairs[j];
        if (code === 10) v.x = num(value);
        else if (code === 20) v.y = num(value);
        else if (code === 42) v.bulge = num(value);
        else if (code === 70) flags = int(value);
      }
      // Skip spline-frame control points (bit 4 set, bit 8 clear).
      if ((flags & 16) === 0 || (flags & 8) !== 0) entity.vertices.push(v);
      i = bodyEnd;
      continue;
    }
    if (type === 'SEQEND') {
      i = bodyEnd;
      break;
    }
    break; // unexpected entity: leave it for the main loop
  }
  return { entity, next: i };
}

function parseCircle(body: DxfPair[]): DxfCircleEntity {
  const e: DxfCircleEntity = { ...parseCommon(body), kind: 'circle', cx: 0, cy: 0, r: 0 };
  for (const { code, value } of body) {
    if (code === 10) e.cx = num(value);
    else if (code === 20) e.cy = num(value);
    else if (code === 40) e.r = num(value);
  }
  return e;
}

function parseArc(body: DxfPair[]): DxfArcEntity {
  const e: DxfArcEntity = { ...parseCommon(body), kind: 'arc', cx: 0, cy: 0, r: 0, startDeg: 0, endDeg: 360 };
  for (const { code, value } of body) {
    if (code === 10) e.cx = num(value);
    else if (code === 20) e.cy = num(value);
    else if (code === 40) e.r = num(value);
    else if (code === 50) e.startDeg = num(value);
    else if (code === 51) e.endDeg = num(value);
  }
  return e;
}

function parseEllipse(body: DxfPair[]): DxfEllipseEntity {
  const e: DxfEllipseEntity = {
    ...parseCommon(body),
    kind: 'ellipse',
    cx: 0,
    cy: 0,
    majorX: 1,
    majorY: 0,
    ratio: 1,
    startParam: 0,
    endParam: Math.PI * 2,
  };
  for (const { code, value } of body) {
    if (code === 10) e.cx = num(value);
    else if (code === 20) e.cy = num(value);
    else if (code === 11) e.majorX = num(value);
    else if (code === 21) e.majorY = num(value);
    else if (code === 40) e.ratio = num(value);
    else if (code === 41) e.startParam = num(value);
    else if (code === 42) e.endParam = num(value);
  }
  return e;
}

function parseText(body: DxfPair[]): DxfTextEntity {
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
  if (hJust === 1 || hJust === 4) e.hAlign = 'center';
  else if (hJust === 2) e.hAlign = 'right';
  if (vJust === 1) e.vAlign = 'bottom';
  else if (vJust === 2) e.vAlign = 'middle';
  else if (vJust === 3) e.vAlign = 'top';
  // Non-default justification anchors at the second alignment point.
  if ((hJust !== 0 || vJust !== 0) && alignX !== null && alignY !== null) {
    e.x = alignX;
    e.y = alignY;
  }
  return e;
}

function parseSpline(body: DxfPair[], doc: DxfDocument): import('./types.js').DxfSplineEntity {
  const e: import('./types.js').DxfSplineEntity = {
    ...parseCommon(body),
    kind: 'spline',
    degree: 3,
    closed: false,
    knots: [],
    controlPoints: [],
    fitPoints: [],
  };
  const weights: number[] = [];
  let flags = 0;
  let currentCtrl: { x: number; y: number } | null = null;
  let currentFit: { x: number; y: number } | null = null;
  for (const { code, value } of body) {
    switch (code) {
      case 70:
        flags = int(value);
        e.closed = (flags & 1) !== 0;
        break;
      case 71:
        e.degree = Math.max(1, int(value));
        break;
      case 40:
        e.knots.push(num(value));
        break;
      case 41:
        weights.push(num(value));
        break;
      case 10:
        currentCtrl = { x: num(value), y: 0 };
        e.controlPoints.push(currentCtrl);
        break;
      case 20:
        if (currentCtrl) currentCtrl.y = num(value);
        break;
      case 11:
        currentFit = { x: num(value), y: 0 };
        e.fitPoints.push(currentFit);
        break;
      case 21:
        if (currentFit) currentFit.y = num(value);
        break;
    }
  }
  // The tessellator evaluates a non-rational clamped B-spline. Rational
  // splines with non-uniform weights and periodic splines deviate from
  // that; surface a warning instead of failing (periodic knot vectors
  // also fail the clamped-knot check and fall back to the control
  // polygon). Fit points, when present, are exact either way.
  if (e.fitPoints.length < 2) {
    const nonUniform = weights.length > 0 && weights.some((w) => Math.abs(w - weights[0]) > 1e-9);
    if (nonUniform) {
      doc.warnings.push('Rational SPLINE with non-uniform weights approximated as non-rational.');
    }
    if ((flags & 2) !== 0) {
      doc.warnings.push('Periodic SPLINE approximated by its control polygon.');
    }
  }
  return e;
}

function parseSolid(body: DxfPair[]): import('./types.js').DxfSolidEntity {
  // DXF stores SOLID corners in Z-order: draw order is 1, 2, 4, 3.
  const c = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  let has4 = false;
  for (const { code, value } of body) {
    switch (code) {
      case 10: c[0].x = num(value); break;
      case 20: c[0].y = num(value); break;
      case 11: c[1].x = num(value); break;
      case 21: c[1].y = num(value); break;
      case 12: c[3].x = num(value); break;
      case 22: c[3].y = num(value); break;
      case 13: c[2].x = num(value); has4 = true; break;
      case 23: c[2].y = num(value); has4 = true; break;
    }
  }
  const corners = has4 && (c[2].x !== c[3].x || c[2].y !== c[3].y)
    ? [c[0], c[1], c[2], c[3]]
    : [c[0], c[1], c[3]];
  return { ...parseCommon(body), kind: 'solid', corners };
}

function parseMtext(body: DxfPair[]): DxfTextEntity {
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
  return e;
}

function parseInsert(body: DxfPair[]): DxfInsertEntity {
  const e: DxfInsertEntity = {
    ...parseCommon(body),
    kind: 'insert',
    blockName: '',
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    columnCount: 1,
    rowCount: 1,
    columnSpacing: 0,
    rowSpacing: 0,
  };
  for (const { code, value } of body) {
    switch (code) {
      case 2:
        e.blockName = value.trim();
        break;
      case 10:
        e.x = num(value);
        break;
      case 20:
        e.y = num(value);
        break;
      case 41:
        e.scaleX = num(value) || 1;
        break;
      case 42:
        e.scaleY = num(value) || 1;
        break;
      case 50:
        e.rotationDeg = num(value);
        break;
      case 70:
        e.columnCount = Math.max(1, int(value));
        break;
      case 71:
        e.rowCount = Math.max(1, int(value));
        break;
      case 44:
        e.columnSpacing = num(value);
        break;
      case 45:
        e.rowSpacing = num(value);
        break;
    }
  }
  return e;
}

function parseDimension(body: DxfPair[]): DxfDimensionEntity {
  const e: DxfDimensionEntity = { ...parseCommon(body), kind: 'dimension', blockName: '' };
  for (const { code, value } of body) {
    if (code === 2) e.blockName = value.trim();
  }
  return e;
}

/**
 * HATCH boundary parsing. The group codes inside a HATCH are positional:
 * 91 = number of boundary paths, then per path 92 (type flags) followed by
 * either a polyline vertex list (flag bit 1) or a typed edge list. Codes 72
 * and 73 change meaning depending on position, so this parser walks the body
 * sequentially with a cursor.
 */
function parseHatch(body: DxfPair[], doc: DxfDocument): DxfHatchEntity {
  const e: DxfHatchEntity = { ...parseCommon(body), kind: 'hatch', solid: false, paths: [] };
  let j = 0;

  const peek = (): DxfPair | undefined => body[j];
  const take = (): DxfPair => body[j++];
  const takeIf = (code: number): number | null => {
    const p = body[j];
    if (p && p.code === code) {
      j++;
      return num(p.value);
    }
    return null;
  };

  // Scan up to the first boundary path for the solid flag.
  while (j < body.length && body[j].code !== 92) {
    const p = take();
    if (p.code === 70) e.solid = int(p.value) === 1;
  }

  while (j < body.length) {
    const p = peek();
    if (!p) break;
    if (p.code !== 92) {
      j++;
      continue;
    }
    const flags = int(take().value);
    const isPolyline = (flags & 2) !== 0;
    const path: DxfHatchPath = { vertices: [] };

    if (isPolyline) {
      takeIf(72); // has-bulge flag
      takeIf(73); // is-closed flag (paths are treated as closed regions anyway)
      takeIf(93); // vertex count (we read by codes, not count)
      while (j < body.length) {
        const x = takeIf(10);
        if (x === null) break;
        const y = takeIf(20) ?? 0;
        const bulge = takeIf(42) ?? 0;
        path.vertices.push({ x, y, bulge });
      }
    } else {
      const edgeCount = takeIf(93) ?? 0;
      for (let k = 0; k < edgeCount && j < body.length; k++) {
        const edgeType = takeIf(72);
        if (edgeType === null) break;
        if (edgeType === 1) {
          const x1 = takeIf(10) ?? 0;
          const y1 = takeIf(20) ?? 0;
          const x2 = takeIf(11) ?? 0;
          const y2 = takeIf(21) ?? 0;
          if (path.vertices.length === 0) path.vertices.push({ x: x1, y: y1, bulge: 0 });
          path.vertices.push({ x: x2, y: y2, bulge: 0 });
        } else if (edgeType === 2) {
          const cx = takeIf(10) ?? 0;
          const cy = takeIf(20) ?? 0;
          const r = takeIf(40) ?? 0;
          let start = takeIf(50) ?? 0;
          let end = takeIf(51) ?? 360;
          const ccw = (takeIf(73) ?? 1) !== 0;
          if (!ccw) {
            // Clockwise edges store angles measured clockwise; negate and
            // swap to recover the true geometry (ezdxf's convention).
            const s = start;
            start = -end;
            end = -s;
          }
          const pts = sampleArc(cx, cy, r, start, end);
          const startIdx = path.vertices.length > 0 ? 1 : 0;
          for (let m = startIdx; m < pts.length; m++) {
            path.vertices.push({ x: pts[m].x, y: pts[m].y, bulge: 0 });
          }
        } else if (edgeType === 3) {
          const cx = takeIf(10) ?? 0;
          const cy = takeIf(20) ?? 0;
          const mx = takeIf(11) ?? 1;
          const my = takeIf(21) ?? 0;
          const ratio = takeIf(40) ?? 1;
          let startDeg = takeIf(50) ?? 0;
          let endDeg = takeIf(51) ?? 360;
          const ccw = (takeIf(73) ?? 1) !== 0;
          if (!ccw) {
            // Clockwise edges mirror the parameter sweep, same as arc edges.
            const s = startDeg;
            startDeg = -endDeg;
            endDeg = -s;
          }
          const pts = sampleEllipse(
            cx,
            cy,
            mx,
            my,
            ratio,
            (startDeg * Math.PI) / 180,
            (endDeg * Math.PI) / 180,
          );
          const startIdx = path.vertices.length > 0 ? 1 : 0;
          for (let m = startIdx; m < pts.length; m++) {
            path.vertices.push({ x: pts[m].x, y: pts[m].y, bulge: 0 });
          }
        } else {
          // Spline edge (4): approximate by its control/fit points.
          doc.warnings.push('HATCH spline edge approximated by its control points.');
          takeIf(94); // degree
          takeIf(73); // rational
          takeIf(74); // periodic
          const knotCount = takeIf(95) ?? 0;
          const ctrlCount = takeIf(96) ?? 0;
          for (let m = 0; m < knotCount; m++) takeIf(40);
          for (let m = 0; m < ctrlCount; m++) {
            const x = takeIf(10);
            if (x === null) break;
            const y = takeIf(20) ?? 0;
            takeIf(42); // weight
            path.vertices.push({ x, y, bulge: 0 });
          }
          const fitCount = takeIf(97) ?? 0;
          for (let m = 0; m < fitCount; m++) {
            const x = takeIf(11);
            if (x === null) break;
            takeIf(21);
          }
        }
      }
    }

    if (path.vertices.length >= 3) e.paths.push(path);
  }
  return e;
}
