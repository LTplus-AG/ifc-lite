/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF writer tests (issue #1861): header/tables/entities structure, layer
 * sanitization, and a round trip of every entity kind through this
 * package's own `parseDxf` (the counterpart parser from #1782).
 *
 * The writer targets DXF R12 (AC1009) deliberately (see `writer.ts` module
 * docs): entity handles (group 5) and subclass markers (group 100) are
 * mandatory from R13 on, and a real R2000+ file needs a BLOCK_RECORD table
 * plus a BLOCKS/OBJECTS skeleton this writer doesn't produce. Declaring a
 * later `$ACADVER` while omitting all of that would make the file invalid
 * for strict readers (AutoCAD, ODA/Teigha-based tools) even though this
 * package's own lenient parser would still read it — hence the explicit
 * "no group 100 / no group 5" guard test below.
 */

import { describe, expect, it } from 'vitest';
import { DxfWriter, sanitizeDxfLayerName } from './writer.js';
import { cssToAci, aciToCss } from './aci-colors.js';
import { parseDxf } from './parser.js';
import type { DxfLineEntity, DxfPolylineEntity, DxfTextEntity } from './types.js';

describe('DxfWriter structure', () => {
  it('writes HEADER with $ACADVER=AC1009 (R12) and no $INSUNITS', () => {
    const w = new DxfWriter();
    const layer = w.layer('A', '#000000');
    w.addLine({ x: 0, y: 0 }, { x: 1, y: 1 }, layer);
    const dxf = w.toString();
    expect(dxf).toContain('$ACADVER\n1\nAC1009');
    expect(dxf).not.toContain('$INSUNITS');
  });

  it('states the unit in a leading 999 comment (R12 has no $INSUNITS)', () => {
    const w = new DxfWriter();
    const dxf = w.toString();
    expect(dxf.startsWith('999\n')).toBe(true);
    expect(dxf).toContain('metres');
  });

  it('accepts a custom header comment (e.g. naming the IfcProjectedCRS)', () => {
    const w = new DxfWriter({ headerComment: 'ifc-lite export - units: metres, CRS: EPSG:32632' });
    const dxf = w.toString();
    expect(dxf.split('\n')[1]).toBe('ifc-lite export - units: metres, CRS: EPSG:32632');
  });

  it('never emits group 100 (subclass marker), group 5 (handle), or LTYPE group 74 — R13+-only constructs', () => {
    const w = new DxfWriter();
    const layer = w.layer('walls', '#ff0000');
    w.addLine({ x: 0, y: 0 }, { x: 1, y: 1 }, layer);
    w.addPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], layer, true);
    w.addText({ x: 0, y: 0 }, 'hello', 0.2, layer);
    const dxf = w.toString();
    const codes = dxf.split('\n').filter((_, i) => i % 2 === 0);
    expect(codes).not.toContain('100');
    expect(codes).not.toContain('5');
    expect(codes).not.toContain('74');
  });

  it('emits the R12 POLYLINE dummy point (10/20/30 = 0) ahead of the VERTEX chain', () => {
    const w = new DxfWriter();
    const layer = w.layer('slab', '#333333');
    w.addPolyline([{ x: 2, y: 3 }, { x: 4, y: 5 }], layer, false);
    expect(w.toString()).toContain('0\nPOLYLINE\n8\n' + layer + '\n66\n1\n10\n0.0\n20\n0.0\n30\n0.0\n70\n0');
  });

  it('declares the STANDARD text style in a STYLE table (TEXT references it implicitly)', () => {
    const dxf = new DxfWriter().toString();
    expect(dxf).toContain('TABLE\n2\nSTYLE');
    expect(dxf).toContain('0\nSTYLE\n2\nSTANDARD');
  });

  it('computes $EXTMIN/$EXTMAX from written geometry', () => {
    const w = new DxfWriter();
    const layer = w.layer('A', '#000000');
    w.addLine({ x: -5, y: 2 }, { x: 10, y: -3 }, layer);
    const dxf = w.toString();
    expect(dxf).toContain('$EXTMIN\n10\n-5.000000\n20\n-3.000000');
    expect(dxf).toContain('$EXTMAX\n10\n10.000000\n20\n2.000000');
  });

  it('declares CONTINUOUS and DASHED linetypes in the LTYPE table', () => {
    const w = new DxfWriter();
    const dxf = w.toString();
    expect(dxf).toContain('TABLE\n2\nLTYPE');
    expect(dxf).toContain('2\nCONTINUOUS');
    expect(dxf).toContain('2\nDASHED');
  });

  it('registers one LAYER row per distinct layer, colour resolved to ACI', () => {
    const w = new DxfWriter();
    const red = w.layer('Cut Lines', '#ff0000');
    w.addLine({ x: 0, y: 0 }, { x: 1, y: 0 }, red);
    const dxf = w.toString();
    expect(dxf).toContain('TABLE\n2\nLAYER');
    expect(dxf).toContain('2\nCut_Lines\n70\n0\n62\n1\n6\nCONTINUOUS'); // ACI 1 = red
  });

  it('sanitizes layer names to the R12 symbol charset and 31-character limit', () => {
    expect(sanitizeDxfLayerName('A/B:C')).toBe('A_B_C');
    expect(sanitizeDxfLayerName('Cut Lines')).toBe('Cut_Lines');
    expect(sanitizeDxfLayerName('')).toBe('LAYER');
    // R12 allows only A-Z a-z 0-9 $ - _ : unicode and punctuation collapse to _.
    expect(sanitizeDxfLayerName('Wände (EG)')).toBe('W_nde_EG');
    expect(sanitizeDxfLayerName('a$b-c_d')).toBe('a$b-c_d');
    // 31-character R12 symbol-name limit (255 is R2000+).
    expect(sanitizeDxfLayerName('X'.repeat(40))).toBe('X'.repeat(31));
  });

  it('disambiguates distinct source names that collide after sanitizing (no silent layer merge)', () => {
    const w = new DxfWriter();
    const a = w.layer('Wände', '#ff0000');
    const b = w.layer('Wønde', '#00ff00');
    const aAgain = w.layer('Wände', '#0000ff');
    expect(a).toBe('W_nde');
    expect(b).toBe('W_nde_2');
    expect(aAgain).toBe(a); // same source name keeps its assigned layer
    const dxf = w.toString();
    expect(dxf).toContain('2\nW_nde\n70\n0\n62\n1\n'); // first registration wins the colour
    expect(dxf).toContain('2\nW_nde_2\n70\n0\n62\n3\n');
  });
});

describe('DxfWriter entity round trip (via this package\'s own parser)', () => {
  it('round-trips a LINE entity', () => {
    const w = new DxfWriter();
    const layer = w.layer('walls', '#000000');
    w.addLine({ x: 1.5, y: -2.25 }, { x: 10, y: 20 }, layer);
    const doc = parseDxf(w.toString());
    // R12 has no $INSUNITS; the parser's default (0/unitless) is expected —
    // the writer always emits metres and states so via the 999 comment.
    expect(doc.insunits).toBe(0);
    expect(doc.entities).toHaveLength(1);
    const line = doc.entities[0] as DxfLineEntity;
    expect(line.kind).toBe('line');
    expect(line.layer).toBe('walls');
    expect(line.x1).toBeCloseTo(1.5);
    expect(line.y1).toBeCloseTo(-2.25);
    expect(line.x2).toBeCloseTo(10);
    expect(line.y2).toBeCloseTo(20);
  });

  it('round-trips a closed polyline (classic POLYLINE/VERTEX/SEQEND, not LWPOLYLINE)', () => {
    const w = new DxfWriter();
    const layer = w.layer('slab', '#333333');
    w.addPolyline(
      [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
      layer,
      true,
    );
    const dxf = w.toString();
    expect(dxf).toContain('0\nPOLYLINE\n');
    expect(dxf).toContain('0\nVERTEX\n');
    expect(dxf).toContain('0\nSEQEND\n');
    expect(dxf).not.toContain('LWPOLYLINE');
    const doc = parseDxf(dxf);
    expect(doc.entities).toHaveLength(1);
    const poly = doc.entities[0] as DxfPolylineEntity;
    expect(poly.kind).toBe('polyline');
    expect(poly.closed).toBe(true);
    expect(poly.vertices).toHaveLength(4);
    expect(poly.vertices[2].x).toBeCloseTo(5);
    expect(poly.vertices[2].y).toBeCloseTo(5);
  });

  it('round-trips an open polyline unclosed', () => {
    const w = new DxfWriter();
    const layer = w.layer('path', '#000000');
    w.addPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }], layer, false);
    const doc = parseDxf(w.toString());
    const poly = doc.entities[0] as DxfPolylineEntity;
    expect(poly.closed).toBe(false);
    expect(poly.vertices).toHaveLength(3);
  });

  it('round-trips a TEXT entity with rotation', () => {
    const w = new DxfWriter();
    const layer = w.layer('anno', '#000000');
    w.addText({ x: 3, y: 4 }, 'Room 101', 0.25, layer, { rotationDeg: 90 });
    const doc = parseDxf(w.toString());
    expect(doc.entities).toHaveLength(1);
    const text = doc.entities[0] as DxfTextEntity;
    expect(text.kind).toBe('text');
    expect(text.text).toBe('Room 101');
    expect(text.height).toBeCloseTo(0.25);
    expect(text.rotationDeg).toBeCloseTo(90);
    expect(text.x).toBeCloseTo(3);
    expect(text.y).toBeCloseTo(4);
  });

  it('per-entity colour override survives the round trip via the LAYER-BYLAYER default', () => {
    // The entity's own ACI (group 62) always wins over the layer's colour in a
    // real CAD reader; this package's parser models that with `colorNumber`.
    const w = new DxfWriter();
    const layer = w.layer('mixed', '#000000');
    w.addLine({ x: 0, y: 0 }, { x: 1, y: 0 }, layer, '#ff0000');
    const doc = parseDxf(w.toString());
    const line = doc.entities[0] as DxfLineEntity;
    expect(line.colorNumber).toBe(cssToAci('#ff0000'));
  });

  it('skips degenerate geometry (single-point polyline, empty/whitespace text)', () => {
    const w = new DxfWriter();
    const layer = w.layer('x', '#000000');
    w.addPolyline([{ x: 0, y: 0 }], layer, false);
    w.addText({ x: 0, y: 0 }, '   ', 0.2, layer);
    w.addText({ x: 0, y: 0 }, 'ok', 0, layer); // zero height also dropped
    const doc = parseDxf(w.toString());
    expect(doc.entities).toHaveLength(0);
  });
});

describe('cssToAci / aciToCss', () => {
  it('maps primary hues to their classic ACI index', () => {
    expect(cssToAci('#ff0000')).toBe(1); // red
    expect(cssToAci('#ffff00')).toBe(2); // yellow
    expect(cssToAci('#00ff00')).toBe(3); // green
    expect(cssToAci('#0000ff')).toBe(5); // blue
  });

  it('round-trips aciToCss -> cssToAci for the classic entries', () => {
    for (const aci of [1, 2, 3, 4, 5, 6]) {
      expect(cssToAci(aciToCss(aci))).toBe(aci);
    }
  });

  it('falls back to black (ACI 7) for unparseable colour strings', () => {
    expect(cssToAci('not-a-color')).toBe(7);
  });
});
