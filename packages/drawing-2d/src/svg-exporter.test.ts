/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG exporter: DXF underlay compositing (issue #1782, PR #1794).
 */

import { describe, expect, it, vi } from 'vitest';
import { exportToSVG } from './svg-exporter.js';
import {
  DEFAULT_SECTION_CONFIG,
  type Drawing2D,
  type DrawingLine,
  type SectionPlaneConfig,
} from './types.js';
import type { DxfUnderlay } from './dxf/types.js';
import { PAPER_SIZES, COMMON_SCALES } from './styles.js';

/** `DEFAULT_SECTION_CONFIG` omits `plane`; a horizontal plan cut stands in for it. */
const PLAN_PLANE: SectionPlaneConfig = { axis: 'z', position: 0, flipped: false };

const emptyDrawing = (): Drawing2D => ({
  config: { ...DEFAULT_SECTION_CONFIG, plane: PLAN_PLANE, scale: 100 },
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
// This transform centers the drawing on a FIXED, caller-chosen paper size
// (no re-fit/clamp — always the exact requested scale) and flips Y.
//
// `padding` option (SVGExportOptions.padding, "Padding around drawing in mm")
//
// `computeTransform` derived `availableWidth`/`availableHeight` from padding
// but never read them anywhere — `padding` was a documented no-op since the
// exporter's original commit (see git history for the now-removed
// characterisation test that pinned that no-op). Fix: treat padding as a
// minimum-margin guarantee. It never re-scales a drawing that already fits
// inside the padded area (the requested `scale` is otherwise exact,
// un-refit), but if the drawing at the requested scale would leave less than
// `padding` mm of margin — or overflow the paper — the effective scale is
// shrunk just enough to respect the margin. Centring is unaffected (padding
// is uniform on all sides, so the padded area shares the paper's center).
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
  config: { ...DEFAULT_SECTION_CONFIG, plane: PLAN_PLANE, scale: 100 },
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
});

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

  it('honours a custom scale not present in COMMON_SCALES, instead of silently substituting a preset', () => {
    // `drawing.config.scale` is a plain `number` (see types.ts) — the
    // generator accepts ANY positive scale, not just the ten presets in
    // COMMON_SCALES. The default `scale` option in `export()` used to do
    // `COMMON_SCALES.find(s => s.factor === drawing.config.scale) ||
    // COMMON_SCALES[5]`: a `.find()` miss (a legitimate custom scale, e.g.
    // 1:75) is indistinguishable from "no scale option was passed at all",
    // and both fell through to the SAME hardcoded 1:50 default — silently
    // rendering the drawing at the wrong scale with no error, no warning,
    // and (per the test above) a title-block label that claims the
    // requested scale was honoured when it names 1:50 either way.
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    drawing.config.scale = 75; // not in COMMON_SCALES
    // No `scale` option passed: exportSVG(drawing) callers (drawing-generator.ts,
    // the SDK's exportToSVG) rely on the default deriving it from
    // `drawing.config.scale`.
    const svg = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      padding: 20,
      showTitleBlock: true,
    });
    expect(extractScaleLabel(svg)).toBe('1:75');

    // And the geometry itself must actually be drawn at 1:75 (worldToMm =
    // 1000/75), not just the label — the label and the drawn scale must
    // never disagree (PR #2131 review, same rule as the clamped test below).
    const { x1, x2 } = extractLineCoords(svg);
    const actualWorldToMm = (x2 - x1) / 2; // line runs (0,0)->(2,3), dx=2
    // Coordinates are serialised via `svgNum` at 3 decimal places, so allow
    // for that rounding rather than exact floating-point equality.
    expect(actualWorldToMm).toBeCloseTo(1000 / 75, 2);
  });

  it('still falls back to the 1:50 default for an invalid (non-finite/non-positive) scale', () => {
    // The legitimate-default control: a genuinely absent/invalid scale
    // (0, negative, NaN) must still fall back to COMMON_SCALES[5]. Fixing
    // the custom-scale bug above must not remove this default.
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: 0, y: 0 },
      { x: 2, y: 3 }
    );
    drawing.config.scale = 0;
    const svg = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      padding: 20,
      showTitleBlock: true,
    });
    expect(extractScaleLabel(svg)).toBe('1:50');
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

// ═══════════════════════════════════════════════════════════════════════════
// Non-finite coordinates must never reach the SVG text.
//
// `NaN`, `Infinity` and `-Infinity` are not SVG `<number>` tokens — the SVG
// grammar admits only an optional sign, digits, a decimal point and an
// exponent — so an attribute reading `x1="NaN"` is in error and a conforming
// renderer must not draw the element. Every coordinate here went through a
// bare `.toFixed(3)`, which stringifies all three verbatim, while the DXF
// writer sitting beside it in this package has guarded the same values at its
// single `fmt()` since it was written. Two writers of the same drawing that
// disagree about the same input is the defect; the fix is one shared emitter,
// not a guard sprinkled over thirteen interpolations.
//
// The three values are asserted separately: `Infinity` reaches the text as
// `"Infinity"` while `NaN` reaches it as `"NaN"`, and a guard keyed on only
// one of them (`isNaN`, say) would let the other two through.
// ═══════════════════════════════════════════════════════════════════════════

describe('SVG exporter: non-finite coordinates', () => {
  const NONFINITE: Array<[string, number]> = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ];

  it.each(NONFINITE)('writes no %s token anywhere in the document', (label, poison) => {
    const drawing = drawingWithLine(
      { min: { x: 0, y: 0 }, max: { x: 4, y: 6 } },
      { x: poison, y: 0 },
      { x: 2, y: 3 }
    );
    const svg = exportToSVG(drawing, {
      paperSize: PAPER_SIZES.A3_LANDSCAPE,
      scale: scaleByFactor(100),
      padding: 20,
    });
    // Anti-vacuity: the drawing line really is in the document.
    expect(svg).toContain('data-entity-id="1"');
    expect(svg, `[${label}] emitted NaN`).not.toContain('NaN');
    expect(svg, `[${label}] emitted Infinity`).not.toContain('Infinity');
  });

  it.each(NONFINITE)(
    'a non-finite bound (%s) does not poison the other coordinates',
    (label, poison) => {
      const drawing = drawingWithLine(
        { min: { x: poison, y: 0 }, max: { x: 4, y: 6 } },
        { x: 0, y: 0 },
        { x: 2, y: 3 }
      );
      const svg = exportToSVG(drawing, {
        paperSize: PAPER_SIZES.A3_LANDSCAPE,
        scale: scaleByFactor(100),
        padding: 20,
      });
      // Not merely finite: the finite line must land EXACTLY where it does when
      // the bounds are clean (the 190/178.5/210/148.5 of the characterisation
      // test above). A guard that emitted "0" for everything would pass a
      // finiteness-only assertion while still having lost the drawing.
      const { x1, y1, x2, y2 } = extractLineCoords(svg);
      expect(x1, `[${label}] x1`).toBeCloseTo(190, 3);
      expect(y1, `[${label}] y1`).toBeCloseTo(178.5, 3);
      expect(x2, `[${label}] x2`).toBeCloseTo(210, 3);
      expect(y2, `[${label}] y2`).toBeCloseTo(148.5, 3);
    }
  );

  it('still writes exact coordinates for an all-finite drawing', () => {
    // Both directions: a guard that emitted "0" for everything would satisfy
    // every assertion above. Same fixture as the characterisation test at the
    // top of the file, asserted to the same precision.
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
    expect(svg).toContain('x1="190.000"');
    expect(svg).toContain('y1="178.500"');
    expect(svg).toContain('x2="210.000"');
    expect(svg).toContain('y2="148.500"');
  });
});
