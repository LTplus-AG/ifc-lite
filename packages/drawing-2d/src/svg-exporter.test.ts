/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG exporter: DXF underlay compositing (issue #1782, PR #1794).
 */

import { describe, expect, it } from 'vitest';
import { exportToSVG } from './svg-exporter.js';
import { DEFAULT_SECTION_CONFIG, type Drawing2D, type DrawingLine } from './types.js';
import type { DxfUnderlay } from './dxf/types.js';
import { PAPER_SIZES, COMMON_SCALES } from './styles.js';

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
        {
          position: { x: 5, y: 5 },
          text: 'Label',
          height: 2,
          dirX: 1,
          dirY: 0,
          align: 'left',
          valign: 'baseline',
        },
      ],
    },
  ],
});

describe('SVGExporter underlays', () => {
  it('scales underlay text height by the placement scale (PR #1794 review)', () => {
    // 1:100 → 10 mm per metre. height 2 m × scale 0.5 → 10 mm font.
    const svg = exportToSVG(emptyDrawing(), {
      underlays: [{ underlay: underlay(), placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 0.5 } }],
    });
    expect(svg).toContain('font-size="10.000"');
    expect(svg).toContain('stroke="#112233"');
  });

  it('honours per-layer visibility overrides', () => {
    const svg = exportToSVG(emptyDrawing(), {
      underlays: [{ underlay: underlay(), layerVisibility: { ANNO: false } }],
    });
    expect(svg).not.toContain('Label');
    expect(svg).not.toContain('#112233');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeTransform() characterisation (drift risk flagged on PR #2119: this
// is one of four "world metres -> paper millimetres at scale N" transforms
// in the codebase, see also sheet-types.test.ts and pdf-scale.test.ts).
//
// This transform: centers the drawing on a FIXED, caller-chosen paper size
// (no re-fit/clamp — always the exact requested scale), flips Y, and bakes
// the result directly into every emitted SVG point. `padding` is accepted
// but — as pinned below — has NO effect on the output; `computeTransform`
// computes `availableWidth`/`availableHeight` from it and never uses them.
// ═══════════════════════════════════════════════════════════════════════════

const cutLine = (start: { x: number; y: number }, end: { x: number; y: number }): DrawingLine => ({
  line: { start, end },
  category: 'cut',
  visibility: 'visible',
  entityId: 1,
  ifcType: 'IfcWall',
  modelIndex: 0,
  depth: 0,
});

const drawingWithLine = (
  bounds: { min: { x: number; y: number }; max: { x: number; y: number } },
  start: { x: number; y: number },
  end: { x: number; y: number }
): Drawing2D => ({
  config: { ...DEFAULT_SECTION_CONFIG, scale: 100 },
  lines: [cutLine(start, end)],
  cutPolygons: [],
  projectionPolygons: [],
  bounds,
  stats: {
    cutLineCount: 1,
    projectionLineCount: 0,
    hiddenLineCount: 0,
    silhouetteLineCount: 0,
    polygonCount: 0,
    totalTriangles: 0,
    processingTimeMs: 0,
  },
});

const scaleByFactor = (factor: number) => COMMON_SCALES.find((s) => s.factor === factor)!;

/** Pull `x1/y1/x2/y2` off the single `<line .../>` element the fixture emits. */
const extractLineCoords = (svg: string): { x1: number; y1: number; x2: number; y2: number } => {
  // Grab each individual self-closed `<line .../>` element (stopping at its
  // OWN `/>`, so this can't span into a later element), then pick the one
  // element carrying `data-entity-id` — the real drawing line, as opposed to
  // the `<line>` elements inside the hatch-pattern `<defs>`, which have none.
  const elements = svg.match(/<line [^]*?\/>/g) ?? [];
  const entityLine = elements.find((el) => el.includes('data-entity-id'));
  if (!entityLine) throw new Error(`No entity <line> element found in SVG:\n${svg}`);
  const match = entityLine.match(/x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/);
  if (!match) throw new Error(`Entity <line> element missing coordinates:\n${entityLine}`);
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
};

describe('SVGExporter.computeTransform (characterisation, via exportToSVG)', () => {
  it('centers the drawing on the paper at exact scale 1:100, flipping Y (A3 landscape, 420x297mm)', () => {
    // bounds: 4m x 6m box, center (2, 3). worldToMm = 1000/100 = 10.
    // offsetX = 420/2 - 2*10 = 190; offsetY = 297/2 + 3*10 = 178.5.
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    const svg = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      scale: scaleByFactor(100),
      padding: 20,
    });
    const { x1, y1, x2, y2 } = extractLineCoords(svg);
    expect(x1).toBeCloseTo(190, 3);
    expect(y1).toBeCloseTo(178.5, 3);
    expect(x2).toBeCloseTo(210, 3); // 2*10 + 190
    expect(y2).toBeCloseTo(148.5, 3); // -3*10 + 178.5 (Y flipped)
  });

  it('scales linearly with the chosen scale factor (1:50 doubles mm-per-metre vs 1:100)', () => {
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    const svg = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      scale: scaleByFactor(50),
      padding: 20,
    });
    const { x1, y1, x2, y2 } = extractLineCoords(svg);
    // worldToMm = 1000/50 = 20. offsetX = 210 - 2*20 = 170; offsetY = 148.5 + 3*20 = 208.5.
    expect(x1).toBeCloseTo(170, 3);
    expect(y1).toBeCloseTo(208.5, 3);
    expect(x2).toBeCloseTo(210, 3); // 2*20 + 170
    expect(y2).toBeCloseTo(148.5, 3); // -3*20 + 208.5
  });

  it('has zero effect from `padding` on emitted coordinates (documents current dead-parameter behaviour)', () => {
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    const svgNoPadding = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      scale: scaleByFactor(100),
      padding: 0,
    });
    const svgBigPadding = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      scale: scaleByFactor(100),
      padding: 100,
    });
    expect(extractLineCoords(svgBigPadding)).toEqual(extractLineCoords(svgNoPadding));
  });
});
