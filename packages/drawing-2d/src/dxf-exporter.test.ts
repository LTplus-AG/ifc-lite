/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF exporter tests (issue #1861). Mirrors `svg-exporter.test.ts`'s fixture
 * style so the two exporters are exercised against comparable input.
 */

import { describe, expect, it } from 'vitest';
import { exportToDXF } from './dxf-exporter.js';
import { parseDxf } from './dxf/parser.js';
import { DEFAULT_SECTION_CONFIG, type Drawing2D, type DrawingLine, type DrawingPolygon } from './types.js';
import type { DxfUnderlay } from './dxf/types.js';
import type { DxfLineEntity, DxfPolylineEntity, DxfTextEntity } from './dxf/types.js';

const emptyDrawing = (): Drawing2D => ({
  config: { ...DEFAULT_SECTION_CONFIG, scale: 100 },
  lines: [],
  cutPolygons: [],
  projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: {
    cutLineCount: 0,
    projectionLineCount: 0,
    hiddenLineCount: 0,
    silhouetteLineCount: 0,
    polygonCount: 0,
    totalTriangles: 0,
    processingTimeMs: 0,
  },
});

function makeLine(overrides: Partial<DrawingLine> = {}): DrawingLine {
  return {
    line: { start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
    category: 'cut',
    visibility: 'visible',
    entityId: 1,
    ifcType: 'IfcWall',
    modelIndex: 0,
    depth: 0,
    ...overrides,
  };
}

function makePolygon(overrides: Partial<DrawingPolygon> = {}): DrawingPolygon {
  return {
    polygon: { outer: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], holes: [] },
    entityId: 2,
    ifcType: 'IfcWall',
    modelIndex: 0,
    isCut: true,
    ...overrides,
  };
}

const underlay = (): DxfUnderlay => ({
  name: 'site.dxf',
  unitScale: 1,
  skipped: {},
  warnings: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  layers: [
    {
      name: 'ANNO',
      color: '#112233',
      visible: true,
      fills: [],
      paths: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }],
      texts: [
        { position: { x: 5, y: 5 }, text: 'Label', height: 2, dirX: 1, dirY: 0, align: 'left', valign: 'baseline' },
      ],
    },
  ],
});

describe('DXFExporter', () => {
  it('produces parseable DXF with metre units for an empty drawing', () => {
    const dxf = exportToDXF(emptyDrawing());
    const doc = parseDxf(dxf);
    expect(doc.insunits).toBe(6);
    expect(doc.entities).toHaveLength(0);
  });

  it('writes each drawing line as a LINE on its category layer', () => {
    const drawing = emptyDrawing();
    drawing.lines = [
      makeLine({ category: 'cut', line: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } }),
      makeLine({ category: 'hidden', visibility: 'hidden', line: { start: { x: 0, y: 1 }, end: { x: 1, y: 1 } } }),
    ];
    const doc = parseDxf(exportToDXF(drawing));
    const lines = doc.entities.filter((e): e is DxfLineEntity => e.kind === 'line');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.layer).sort()).toEqual(['IFC-CUT', 'IFC-HIDDEN']);
  });

  it('omits hidden lines when showHiddenLines is false', () => {
    const drawing = emptyDrawing();
    drawing.lines = [makeLine({ category: 'hidden', visibility: 'hidden' })];
    const doc = parseDxf(exportToDXF(drawing, { showHiddenLines: false }));
    expect(doc.entities).toHaveLength(0);
  });

  it('writes the DASHED linetype for the hidden layer', () => {
    const drawing = emptyDrawing();
    drawing.lines = [makeLine({ category: 'hidden', visibility: 'hidden' })];
    const dxf = exportToDXF(drawing);
    expect(dxf).toContain('2\nIFC-HIDDEN\n70\n0\n62\n');
    expect(dxf).toMatch(/IFC-HIDDEN\n70\n0\n62\n\d+\n6\nDASHED/);
  });

  it('represents cut polygons as closed LWPOLYLINE boundaries (hatch-as-boundary, no HATCH entity)', () => {
    const drawing = emptyDrawing();
    drawing.cutPolygons = [makePolygon()];
    const dxf = exportToDXF(drawing);
    expect(dxf).not.toContain('0\nHATCH');
    const doc = parseDxf(dxf);
    const polys = doc.entities.filter((e): e is DxfPolylineEntity => e.kind === 'polyline');
    expect(polys).toHaveLength(1);
    expect(polys[0].closed).toBe(true);
    expect(polys[0].vertices).toHaveLength(4);
  });

  it('omits hatching when showHatching is false', () => {
    const drawing = emptyDrawing();
    drawing.cutPolygons = [makePolygon()];
    const doc = parseDxf(exportToDXF(drawing, { showHatching: false }));
    expect(doc.entities).toHaveLength(0);
  });

  it('embeds a reference underlay (paths + text), matching SVGExporter\'s underlay contract', () => {
    const dxf = exportToDXF(emptyDrawing(), { underlays: [{ underlay: underlay() }] });
    const doc = parseDxf(dxf);
    const texts = doc.entities.filter((e): e is DxfTextEntity => e.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('Label');
    const polylines = doc.entities.filter((e): e is DxfPolylineEntity => e.kind === 'polyline');
    expect(polylines).toHaveLength(1); // the ANNO layer's open path
    expect(polylines[0].vertices[0].x).toBeCloseTo(0);
    expect(polylines[0].vertices[1].x).toBeCloseTo(10);
  });

  it('honours underlay per-layer visibility overrides', () => {
    const dxf = exportToDXF(emptyDrawing(), {
      underlays: [{ underlay: underlay(), layerVisibility: { ANNO: false } }],
    });
    expect(dxf).not.toContain('Label');
  });

  it('applies coordinateTransform to both drawing and underlay geometry (georeference hook)', () => {
    const drawing = emptyDrawing();
    drawing.lines = [makeLine({ line: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } } })];
    const shift = { x: 1000, y: -500 };
    const dxf = exportToDXF(drawing, {
      underlays: [{ underlay: underlay() }],
      coordinateTransform: (p) => ({ x: p.x + shift.x, y: p.y + shift.y }),
    });
    const doc = parseDxf(dxf);
    const line = doc.entities.find((e): e is DxfLineEntity => e.kind === 'line')!;
    expect(line.x1).toBeCloseTo(1000);
    expect(line.y1).toBeCloseTo(-500);
    const text = doc.entities.find((e): e is DxfTextEntity => e.kind === 'text')!;
    expect(text.x).toBeCloseTo(5 + 1000);
    expect(text.y).toBeCloseTo(5 - 500);
  });
});
