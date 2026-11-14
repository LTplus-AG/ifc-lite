/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dimension writers for SVG, DXF and PDF. Expected coordinates are worked
 * out by hand from the paper sizes (extension gap 1 mm, overshoot 2 mm, tick
 * 2.5 mm at 45°, text 2.5 mm with a 1 mm gap) so a change to the shared
 * geometry or to a writer's frame shows up here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import { exportToDXF, parseDxf, DEFAULT_SECTION_CONFIG, type Drawing2D, type DxfEntity } from '@ifc-lite/drawing-2d';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import { axisFlipForSection, type SectionAxis } from '@/hooks/pdfSectionLayout';
import { formatDimensionValue } from '@/lib/drawing2d-markup/dimension-graphics';
import {
  DIMENSION_DXF_LAYER,
  boundsWithDimensions,
  dimensionGraphicsList,
  dimensionsToSvg,
  drawDimensionsPdf,
  placeDimensionText,
  type DimensionMapPoint,
} from './dimension-export';

/** 4 m along x at y = 2, dimension line 0.5 m to the left of a→b (+y). */
const horizontal: Dimension2D = { id: 'h', a: { x: 1, y: 2 }, b: { x: 5, y: 2 }, offset: 0.5, orientation: 'aligned' };
const vertical: Dimension2D = { id: 'v', a: { x: 0, y: 0 }, b: { x: 0, y: 3 }, offset: -1, orientation: 'aligned' };

const format = (m: number) => formatDimensionValue(m);
const graphics = (dims: Dimension2D[], paperScale: number, axis: SectionAxis = 'down') =>
  dimensionGraphicsList(dims, { paperScale, format, flip: axisFlipForSection(axis) });
const flipMap = (axis: SectionAxis): DimensionMapPoint => {
  const { flipX, flipY } = axisFlipForSection(axis);
  return (x, y) => ({ x: flipX ? -x : x, y: flipY ? -y : y });
};

const close = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} ≠ ${expected}`);

/** `<line>` endpoints and widths, `<text>` attributes, parsed from the writer's output. */
function parseSvg(svg: string) {
  const lines = [...svg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" stroke-width="([^"]+)"\/>/g)]
    .map((m) => m.slice(1, 6).map(Number));
  const texts = [...svg.matchAll(/<text x="([^"]+)" y="([^"]+)" transform="rotate\(([^ ]+) [^)]+\)"[^>]*font-size="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), angle: Number(m[3]), size: Number(m[4]), value: m[5] }));
  return { lines, texts };
}

describe('dimension SVG export', () => {
  it('writes the lines, 45° ticks and value of a plan dimension at 1:100 in drawing metres', () => {
    const { lines, texts } = parseSvg(dimensionsToSvg(graphics([horizontal], 100), flipMap('down'), (mm) => mm / 10));
    const t = 0.125 * Math.SQRT1_2; // half a 2.5 mm tick at 1:100, per axis
    assert.deepEqual(lines.map((l) => l.map((v) => Number(v.toFixed(4)))), [
      [1, 2.5, 5, 2.5, 0.018], // dimension line
      [1, 2.1, 1, 2.7, 0.018], // extension lines: 1 mm gap, 2 mm overshoot
      [5, 2.1, 5, 2.7, 0.018],
      // Plan (no flip, y down on paper): ticks run lower-left to upper-right as seen.
      [Number((1 - t).toFixed(4)), Number((2.5 + t).toFixed(4)), Number((1 + t).toFixed(4)), Number((2.5 - t).toFixed(4)), 0.035],
      [Number((5 - t).toFixed(4)), Number((2.5 + t).toFixed(4)), Number((5 + t).toFixed(4)), Number((2.5 - t).toFixed(4)), 0.035],
    ]);
    // Centre 1 mm + half the text height above the line on paper (smaller y).
    assert.deepEqual(texts, [{ x: 3, y: 2.275, angle: 0, size: 0.25, value: '4000' }]);
  });

  it('keeps 2.5 mm text and 1 mm gaps on paper at 1:50 in sheet millimetres', () => {
    // Sheet frame: 20 mm per metre at 1:50, translated by (10, 10).
    const sheetMap: DimensionMapPoint = (x, y) => ({ x: x * 20 + 10, y: y * 20 + 10 });
    const { lines, texts } = parseSvg(dimensionsToSvg(graphics([horizontal], 50), sheetMap, (mm) => mm));
    assert.deepEqual(lines[0], [30, 60, 110, 60, 0.18]);
    assert.deepEqual(lines[1], [30, 51, 30, 62, 0.18], 'gap 1 mm, overshoot 2 mm on paper');
    const tick = Math.hypot(lines[3][2] - lines[3][0], lines[3][3] - lines[3][1]);
    assert.ok(Math.abs(tick - 2.5) < 1e-3, `tick length on paper (to the SVG's 4 decimals): ${tick}`);
    assert.deepEqual(texts, [{ x: 70, y: 57.75, angle: 0, size: 2.5, value: '4000' }]);
  });

  it('turns text upright and keeps it above the line on a flipped elevation and a mirrored side section', () => {
    for (const axis of ['front', 'side'] as const) {
      const map = flipMap(axis);
      const { lines, texts } = parseSvg(dimensionsToSvg(graphics([horizontal], 100, axis), map, (mm) => mm / 10));
      const lineY = lines[0][1];
      assert.equal(texts[0].angle, 0, `${axis}: text reads left to right`);
      close(lineY - texts[0].y, 0.225, `${axis}: text sits above the dimension line on paper`);
    }
  });

  it('reads a vertical dimension bottom to top', () => {
    const { texts } = parseSvg(dimensionsToSvg(graphics([vertical], 100), flipMap('down'), (mm) => mm / 10));
    assert.equal(texts[0].angle, -90);
    assert.equal(texts[0].value, '3000');
  });

  it('escapes a text override and writes nothing without dimensions', () => {
    const svg = dimensionsToSvg(graphics([{ ...horizontal, text: 'a<b & "<>"' }], 100), flipMap('down'), (mm) => mm);
    assert.match(svg, />a&lt;b &amp; &quot;4000&quot;<\/text>/);
    assert.equal(dimensionsToSvg([], flipMap('down'), (mm) => mm), '');
  });
});

const emptyDrawing: Drawing2D = {
  config: { ...DEFAULT_SECTION_CONFIG, plane: { axis: 'y', position: 0, flipped: false }, scale: 100 },
  lines: [], cutPolygons: [], projectionPolygons: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  stats: {
    cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0,
    polygonCount: 0, totalTriangles: 0, processingTimeMs: 0,
  },
};

function dxfEntities(dims: Dimension2D[], paperScale: number, axis: SectionAxis, coordinateTransform?: (p: { x: number; y: number }) => { x: number; y: number }): DxfEntity[] {
  return parseDxf(exportToDXF(emptyDrawing, { dimensions: graphics(dims, paperScale, axis), coordinateTransform })).entities;
}

describe('dimension DXF export', () => {
  it('writes dimension segments and a centred TEXT on one layer, through the plan transform', () => {
    // The plan export's world transform: y up, shifted.
    const entities = dxfEntities([horizontal], 100, 'down', (p) => ({ x: p.x + 100, y: 50 - p.y }));
    const polys = entities.filter((e): e is Extract<DxfEntity, { kind: 'line' }> => e.kind === 'line');
    const texts = entities.filter((e): e is Extract<DxfEntity, { kind: 'text' }> => e.kind === 'text');
    assert.equal(polys.length, 5, 'dimension line, two extension lines, two ticks');
    assert.ok(polys.every((p) => p.layer === DIMENSION_DXF_LAYER));
    assert.deepEqual([[polys[0].x1, polys[0].y1], [polys[0].x2, polys[0].y2]], [[101, 47.5], [105, 47.5]]);
    assert.deepEqual([[polys[1].x1, polys[1].y1], [polys[1].x2, polys[1].y2]], [[101, 47.9], [101, 47.3]]);
    assert.equal(texts.length, 1);
    const [text] = texts;
    assert.equal(text.layer, DIMENSION_DXF_LAYER);
    assert.equal(text.text, '4000');
    assert.deepEqual([text.hAlign, text.vAlign], ['center', 'middle']);
    close(text.x, 103, 'text x');
    close(text.y, 50 - 2.275, 'text y: above the line in y-up world');
    close(text.height, 0.25, '2.5 mm at 1:100');
    close(text.rotationDeg, 0, 'upright');
  });

  it('scales text with the drawing scale and keeps it upright through a mirrored export frame', () => {
    const [text50] = dxfEntities([horizontal], 50, 'down').filter((e): e is Extract<DxfEntity, { kind: 'text' }> => e.kind === 'text');
    close(text50.height, 0.125, '2.5 mm at 1:50');
    // A flipped plan exports x mirrored (buildDxfExportTransform): still upright.
    const [mirrored] = dxfEntities([horizontal], 100, 'down', (p) => ({ x: -p.x, y: -p.y }))
      .filter((e): e is Extract<DxfEntity, { kind: 'text' }> => e.kind === 'text');
    close(mirrored.rotationDeg, 0, 'mirrored frame');
    const [verticalText] = dxfEntities([vertical], 100, 'down', (p) => ({ x: p.x, y: -p.y }))
      .filter((e): e is Extract<DxfEntity, { kind: 'text' }> => e.kind === 'text');
    close(verticalText.rotationDeg, 90, 'vertical text reads bottom to top');
  });

  it('adds no layers without dimensions', () => {
    assert.equal(dxfEntities([], 100, 'down').length, 0);
  });
});

describe('dimension PDF export', () => {
  /** Records the jsPDF calls the writer makes, in page millimetres. */
  function recordingDoc() {
    const calls: { line: number[][]; widths: number[]; text: { value: string; x: number; y: number; angle: number }[]; fontPt: number[] } =
      { line: [], widths: [], text: [], fontPt: [] };
    const doc = {
      saveGraphicsState: () => doc, restoreGraphicsState: () => doc,
      setDrawColor: () => doc, setTextColor: () => doc, setLineDashPattern: () => doc, setLineCap: () => doc,
      setLineWidth: (w: number) => { calls.widths.push(w); return doc; },
      setFontSize: (pt: number) => { calls.fontPt.push(pt); return doc; },
      line: (x1: number, y1: number, x2: number, y2: number) => { calls.line.push([x1, y1, x2, y2]); return doc; },
      // A 2 mm wide value, whatever the font size.
      getTextWidth: () => 2,
      text: (value: string, x: number, y: number, o: { angle: number }) => {
        calls.text.push({ value, x, y, angle: o.angle });
        return doc;
      },
    };
    return { doc: doc as unknown as jsPDF, calls };
  }

  it('draws the shared geometry on the page at 1:100 with 2.5 mm text', () => {
    const { doc, calls } = recordingDoc();
    // Page frame at 1:100: 10 mm per metre, plan (no flip), offset by 20 mm.
    drawDimensionsPdf(doc, graphics([horizontal], 100), (x, y) => ({ x: x * 10 + 20, y: y * 10 + 20 }));
    assert.deepEqual(calls.line.slice(0, 3).map((l) => l.map((v) => Number(v.toFixed(6)))), [[30, 45, 70, 45], [30, 41, 30, 47], [70, 41, 70, 47]]);
    assert.equal(calls.line.length, 5);
    assert.deepEqual(calls.widths, [0.18, 0.35]);
    assert.equal(calls.text.length, 1);
    const [t] = calls.text;
    assert.equal(t.value, '4000');
    // Centre (50, 42.75): the baseline starts half the width back and half a cap height (0.718 em) lower.
    close(t.x, 50 - 1, 'text x'); close(t.y, 42.75 + 0.718 * 2.5 / 2, 'text y'); close(t.angle, 0, 'angle');
    close(calls.fontPt[0], 2.5 * 72 / 25.4, '2.5 mm in points');
  });

  it('turns a vertical value counter-clockwise (jsPDF angles) so it reads bottom to top', () => {
    const { doc, calls } = recordingDoc();
    const [g] = graphics([vertical], 50);
    drawDimensionsPdf(doc, [g], (x, y) => ({ x: x * 20, y: y * 20 }));
    close(calls.text[0].angle, 90, 'jsPDF angle');
    // Reading upwards: the start lies half the width below the centre and half a cap height to its right.
    close(calls.text[0].x, g.text.at.x * 20 + 0.718 * 2.5 / 2, 'start x');
    close(calls.text[0].y, g.text.at.y * 20 + 1, 'start y');
    close(calls.fontPt[0], 2.5 * 72 / 25.4, '2.5 mm at 1:50 too');
  });

  it('emits real vector text and strokes in a jsPDF document', () => {
    const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
    drawDimensionsPdf(doc, graphics([horizontal], 100), (x, y) => ({ x: x * 10, y: y * 10 }));
    const pdf = doc.output();
    assert.match(pdf, /\(4000\) Tj/);
    assert.doesNotMatch(pdf, /\/Subtype \/Image/);
  });
});

describe('placeDimensionText', () => {
  it('measures size and direction through the writer map', () => {
    const [g] = graphics([horizontal], 100, 'side');
    // Side sections mirror x on paper: the drawing baseline maps leftwards and is turned.
    const placed = placeDimensionText(g.text, (x, y) => ({ x: -x * 10, y: -y * 10 }));
    close(placed.angleDeg, 0, 'upright');
    close(placed.size, 2.5, 'size in page mm');
  });
});

describe('boundsWithDimensions', () => {
  it('grows the drawing extent to hold a dimension placed beyond the geometry, and keeps it otherwise', () => {
    const bounds = { min: { x: 0, y: 0 }, max: { x: 6, y: 3 } };
    const far = { ...horizontal, offset: 100 };
    const grown = boundsWithDimensions(bounds, graphics([far], 100));
    // Dimension line at y = 102, extension overshoot 2 mm (0.2 m) past it, text above.
    assert.ok(grown.max.y >= 102.2, `max y ${grown.max.y}`);
    assert.deepEqual([grown.min.x, grown.min.y, grown.max.x], [0, 0, 6]);
    assert.equal(boundsWithDimensions(bounds, []), bounds);
    assert.deepEqual(boundsWithDimensions(bounds, graphics([horizontal], 100)), bounds, 'a dimension inside the extent changes nothing');
  });
});

it('applies the DXF preflight rule to SVG, PDF and bounds too (#10020, #10077)', () => {
  const valid = dimensionGraphicsList([{ id: 'valid', a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, offset: 0, orientation: 'aligned' }],
    { paperScale: 100, format: m => `${m} m` })[0];
  const zero = dimensionGraphicsList([{ id: 'zero', a: { x: 50, y: 50 }, b: { x: 50, y: 50 }, offset: 0, orientation: 'aligned' }],
    { paperScale: 100, format: m => `${m} m` })[0];
  const map = (x: number, y: number) => ({ x, y });
  const svg = dimensionsToSvg([zero, valid], map, mm => mm);
  assert.equal((svg.match(/class="dimension"/g) ?? []).length, 1);
  assert.match(svg, />5 m<\/text>/);
  assert.doesNotMatch(svg, />0 m<\/text>/);
  const doc = new jsPDF();
  drawDimensionsPdf(doc, [zero, valid], map);
  const pdf = doc.output();
  assert.match(pdf, /\(5 m\)/);
  assert.doesNotMatch(pdf, /\(0 m\)/);
  const bounds = { min: { x: -1, y: -1 }, max: { x: 10, y: 10 } };
  assert.deepEqual(boundsWithDimensions(bounds, [zero, valid]), bounds);
});
