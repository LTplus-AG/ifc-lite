/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG exporter: DXF underlay compositing (issue #1782, PR #1794).
 */

import { describe, expect, it, vi } from 'vitest';
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
// `padding` option (SVGExportOptions.padding, "Padding around drawing in mm")
//
// `computeTransform` derived `availableWidth`/`availableHeight` from padding
// but never read them anywhere — `padding` was a documented no-op since the
// exporter's original commit. Fix: treat padding as a minimum-margin
// guarantee. It never re-scales a drawing that already fits inside the
// padded area (the requested `scale` is otherwise exact, un-refit), but if
// the drawing at the requested scale would leave less than `padding` mm of
// margin — or overflow the paper — the effective scale is shrunk just
// enough to respect the margin. Centring is unaffected (padding is uniform
// on all sides, so the padded area shares the paper's center).
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
  const elements = svg.match(/<line [^]*?\/>/g) ?? [];
  const entityLine = elements.find((el) => el.includes('data-entity-id'));
  if (!entityLine) throw new Error(`No entity <line> element found in SVG:\n${svg}`);
  const match = entityLine.match(/x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/);
  if (!match) throw new Error(`Entity <line> element missing coordinates:\n${entityLine}`);
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
};

describe('SVGExporter padding option', () => {
  it('padding: 0 and omitted padding produce byte-identical SVG (compatibility guarantee)', () => {
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    const base = { paperSize: PAPER_SIZES.A3_LANDSCAPE, scale: scaleByFactor(100) };
    const svgOmitted = exportToSVG(drawing, base);
    const svgZero = exportToSVG(drawing, { ...base, padding: 0 });
    expect(svgZero).toBe(svgOmitted);
  });

  it('has zero effect from padding when the drawing already fits inside the padded area', () => {
    // 4m x 6m box at 1:100 => 40mm x 60mm footprint. A3 landscape is
    // 420x297mm, so even a very generous padding still leaves room: this
    // must NOT change the output (padding is a minimum-margin guarantee,
    // not a forced re-fit).
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    const base = { paperSize: PAPER_SIZES.A3_LANDSCAPE, scale: scaleByFactor(100) };
    const svgNoPadding = exportToSVG(drawing, { ...base, padding: 0 });
    const svgSmallPadding = exportToSVG(drawing, { ...base, padding: 20 });
    expect(extractLineCoords(svgSmallPadding)).toEqual(extractLineCoords(svgNoPadding));
  });

  it('shrinks the effective scale to keep the drawing within the padded area, and shifts coordinates inward', () => {
    // A4 landscape is 297x210mm. bounds are 4m x 6m => at 1:100 the
    // requested footprint is 40x60mm, well within 297x210. Force an
    // overflow by requesting a very tight paper padding relative to a large
    // bounds box: 250m x 100m box at 1:100 => 2500mm x 1000mm, vastly
    // larger than the 297x210mm sheet. With padding=20 the available area
    // is 257x170mm, so the effective scale must shrink below 1:100 to fit,
    // and the emitted coordinates (which depend on that scale) must differ
    // from the unpadded, unclamped run.
    const bounds = { min: { x: 0, y: 0 }, max: { x: 250, y: 100 } };
    const drawing = drawingWithLine(bounds, { x: 0, y: 0 }, { x: 125, y: 50 });
    const base = { paperSize: PAPER_SIZES.A4_LANDSCAPE, scale: scaleByFactor(100) };

    const svgNoPadding = exportToSVG(drawing, { ...base, padding: 0 });
    const svgPadded = exportToSVG(drawing, { ...base, padding: 20 });

    const noPaddingCoords = extractLineCoords(svgNoPadding);
    const paddedCoords = extractLineCoords(svgPadded);
    expect(paddedCoords).not.toEqual(noPaddingCoords);

    // Effective scale: min(1000/100, availableWidth/250, availableHeight/100)
    // = min(10, 257/250, 170/100) = min(10, 1.028, 1.7) = 257/250 = 1.028.
    const worldToMm = (257) / 250;
    const center = { x: 125, y: 50 };
    const expectedOffsetX = PAPER_SIZES.A4_LANDSCAPE.width / 2 - center.x * worldToMm;
    const expectedOffsetY = PAPER_SIZES.A4_LANDSCAPE.height / 2 + center.y * worldToMm;
    expect(paddedCoords.x2).toBeCloseTo(125 * worldToMm + expectedOffsetX, 3);
    expect(paddedCoords.y2).toBeCloseTo(-50 * worldToMm + expectedOffsetY, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Title block "Scale:" label (PR #2131 review)
//
// `computeTransform` clamps `worldToMm` to honour the padding guarantee, but
// the title block used to print the *requested* `scale.name` unconditionally.
// A sheet clamped from 1:100 to (effectively) ~1:973 still read "Scale: 1:100"
// — a confidently wrong document, since scaling a dimension off the printout
// is the entire reason a scale label exists. Fix: derive the label from the
// actual, effective `worldToMm`, falling back to the exact requested name
// only when the drawing was not clamped (no floating-point re-derivation on
// the common, unclamped path).
// ═══════════════════════════════════════════════════════════════════════════

/** Pull the "Scale: ..." text out of the rendered title block. */
const extractScaleLabel = (svg: string): string => {
  const match = svg.match(/Scale: ([^<]+)</);
  if (!match) throw new Error(`No "Scale:" label found in SVG:\n${svg}`);
  return match[1];
};

describe('SVGExporter title block scale label', () => {
  it('prints the exact requested scale name when the drawing is not clamped', () => {
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    const svg = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      scale: scaleByFactor(100),
      padding: 20,
      showTitleBlock: true,
    });
    // Exact match: no floating-point noise like "1:100.0000001".
    expect(extractScaleLabel(svg)).toBe('1:100');
  });

  it('prints the effective (clamped) scale, matching the actually rendered geometry', () => {
    // Same overflow scenario as the padding-clamp test above: 250m x 100m
    // bounds requested at 1:100 on an A4 landscape sheet (297x210mm) with
    // padding=20 forces the effective scale to shrink well past 1:100.
    const bounds = { min: { x: 0, y: 0 }, max: { x: 250, y: 100 } };
    const drawing = drawingWithLine(bounds, { x: 0, y: 0 }, { x: 125, y: 50 });
    const svg = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A4_LANDSCAPE,
      scale: scaleByFactor(100),
      padding: 20,
      showTitleBlock: true,
    });

    // Derive the *actually rendered* scale independently, from the emitted
    // line coordinates (line runs world (0,0)->(125,50), so x2-x1 = 125 *
    // worldToMm; the offset cancels out).
    const { x1, x2 } = extractLineCoords(svg);
    const actualWorldToMm = (x2 - x1) / 125;
    const actualScaleFactor = 1000 / actualWorldToMm;

    const label = extractScaleLabel(svg);
    expect(label).not.toBe('1:100'); // must not lie about the requested scale
    expect(label).toMatch(/^1:[\d.]+$/);
    const printedFactor = Number(label.slice(2));
    // The printed label must match the actually rendered scale (not merely
    // some other clamped-looking number).
    expect(printedFactor).toBeCloseTo(actualScaleFactor, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Impossible padding (PR #2131 review)
//
// `availableWidth > 0` / `availableHeight > 0` guarded the clamp so that a
// `padding` large enough to consume the whole sheet (padding*2 >= paperSize
// width/height) skipped clamping *entirely*, silently falling back to
// rendering at the full requested scale — which is exactly the "no padding
// at all" fallback this PR exists to remove, just triggered from the other
// direction. Fix: clamp `padding` itself to the largest value the paper can
// still hold (with a minimum sliver of usable area) and warn, so the
// minimum-margin guarantee keeps holding instead of silently lapsing.
// ═══════════════════════════════════════════════════════════════════════════

describe('SVGExporter impossible padding', () => {
  it('clamps an oversized padding instead of silently skipping the clamp, and warns', () => {
    // A4 landscape is 297x210mm. padding=200 => padding*2=400, which is
    // >= both 297 and 210: an impossible margin on both axes.
    const bounds = { min: { x: 0, y: 0 }, max: { x: 250, y: 100 } };
    const drawing = drawingWithLine(bounds, { x: 0, y: 0 }, { x: 125, y: 50 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const svg = exportToSVG(drawing, {
        paperSize: PAPER_SIZES.A4_LANDSCAPE,
        scale: scaleByFactor(100),
        padding: 200,
      });

      const { x1, x2 } = extractLineCoords(svg);
      const actualWorldToMm = (x2 - x1) / 125;
      const requestedWorldToMm = 1000 / 100; // 10 mm per world unit at 1:100

      // Before the fix: the guard skipped clamping entirely, so the drawing
      // rendered at the full, unclamped requested scale (worldToMm === 10)
      // despite the impossible padding — the guarantee silently lapsed.
      expect(actualWorldToMm).toBeLessThan(requestedWorldToMm);
      expect(warnSpy).toHaveBeenCalled();
      const warned = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(warned).toMatch(/padding/i);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
