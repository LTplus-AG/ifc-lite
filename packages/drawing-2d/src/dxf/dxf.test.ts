/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF import tests (issue #1782). Fixtures are inline group-code streams,
 * matching this package's self-contained test style.
 */

import { describe, expect, it } from 'vitest';
import { importDxf, parseDxf, applyDxfPlacement, stripMtextFormatting, decodeDxfText } from './index.js';
import type { DxfUnderlay, DxfUnderlayLayer } from './types.js';

/** Assemble a group-code stream from (code, value) tuples. */
function pairsToText(...pairs: Array<[number | string, number | string]>): string {
  return pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n';
}

function entitiesSection(...pairs: Array<[number | string, number | string]>): string {
  return pairsToText(
    [0, 'SECTION'],
    [2, 'ENTITIES'],
    ...pairs,
    [0, 'ENDSEC'],
    [0, 'EOF'],
  );
}

function layerByName(underlay: DxfUnderlay, name: string): DxfUnderlayLayer {
  const layer = underlay.layers.find((l) => l.name === name);
  expect(layer, `layer ${name} should exist`).toBeDefined();
  return layer!;
}

const HEADER_MM: Array<[number | string, number | string]> = [
  [0, 'SECTION'],
  [2, 'HEADER'],
  [9, '$INSUNITS'],
  [70, 4],
  [0, 'ENDSEC'],
];

describe('DXF parser', () => {
  it('parses LINE with millimetre units into metres and flips Y', () => {
    const text =
      pairsToText(...HEADER_MM) +
      entitiesSection(
        [0, 'LINE'],
        [8, 'walls'],
        [10, 0],
        [20, 0],
        [11, 1000],
        [21, 2000],
      );
    const underlay = importDxf(text, 'test.dxf');
    expect(underlay.unitScale).toBe(0.001);
    const layer = layerByName(underlay, 'walls');
    expect(layer.paths).toHaveLength(1);
    const [a, b] = layer.paths[0].points;
    expect(a.x).toBeCloseTo(0);
    expect(a.y).toBeCloseTo(0);
    expect(b.x).toBeCloseTo(1);
    expect(b.y).toBeCloseTo(2); // world plan coordinates: +Y = north
  });

  it('reads the LAYER table: colours, off and frozen flags', () => {
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'TABLES'],
        [0, 'TABLE'],
        [2, 'LAYER'],
        [0, 'LAYER'],
        [2, 'visible-red'],
        [62, 1],
        [70, 0],
        [0, 'LAYER'],
        [2, 'switched-off'],
        [62, -3],
        [70, 0],
        [0, 'LAYER'],
        [2, 'frozen'],
        [62, 5],
        [70, 1],
        [0, 'ENDTAB'],
        [0, 'ENDSEC'],
      ) +
      entitiesSection(
        [0, 'LINE'], [8, 'visible-red'], [10, 0], [20, 0], [11, 1], [21, 0],
        [0, 'LINE'], [8, 'switched-off'], [10, 0], [20, 0], [11, 1], [21, 0],
        [0, 'LINE'], [8, 'frozen'], [10, 0], [20, 0], [11, 1], [21, 0],
      );
    const underlay = importDxf(text);
    expect(layerByName(underlay, 'visible-red').visible).toBe(true);
    expect(layerByName(underlay, 'visible-red').color).toBe('#ff0000');
    expect(layerByName(underlay, 'switched-off').visible).toBe(false);
    expect(layerByName(underlay, 'frozen').visible).toBe(false);
    expect(layerByName(underlay, 'frozen').color).toBe('#0000ff');
  });

  it('tessellates a closed LWPOLYLINE with a semicircular bulge', () => {
    // Two vertices, bulge 1 on both = full circle of radius 0.5 around (0.5, 0).
    const text = entitiesSection(
      [0, 'LWPOLYLINE'],
      [8, '0'],
      [90, 2],
      [70, 1],
      [10, 0], [20, 0], [42, 1],
      [10, 1], [20, 0], [42, 1],
    );
    const underlay = importDxf(text);
    const path = layerByName(underlay, '0').paths[0];
    expect(path.closed).toBe(true);
    expect(path.points.length).toBeGreaterThan(10);
    for (const p of path.points) {
      // Every point sits on the circle |p - (0.5, 0)| = 0.5 (y flipped is symmetric).
      expect(Math.hypot(p.x - 0.5, p.y)).toBeCloseTo(0.5, 6);
    }
  });

  it('tessellates CIRCLE and ARC', () => {
    const text = entitiesSection(
      [0, 'CIRCLE'], [8, '0'], [10, 10], [20, 5], [40, 2],
      [0, 'ARC'], [8, '0'], [10, 0], [20, 0], [40, 1], [50, 0], [51, 90],
    );
    const underlay = importDxf(text);
    const [circle, arc] = layerByName(underlay, '0').paths;
    expect(circle.closed).toBe(true);
    for (const p of circle.points) {
      expect(Math.hypot(p.x - 10, p.y - 5)).toBeCloseTo(2, 6);
    }
    expect(arc.closed).toBe(false);
    const first = arc.points[0];
    const last = arc.points[arc.points.length - 1];
    expect(first.x).toBeCloseTo(1); // angle 0
    expect(first.y).toBeCloseTo(0);
    expect(last.x).toBeCloseTo(0, 6); // angle 90 → (0, 1) in world space
    expect(last.y).toBeCloseTo(1, 6);
  });

  it('decodes TEXT content, alignment, and height scaling', () => {
    const text =
      pairsToText(...HEADER_MM) +
      entitiesSection(
        [0, 'TEXT'],
        [8, 'notes'],
        [10, 500], [20, 500],
        [40, 250],
        [1, '45%%d angle'],
        [72, 1],
        [11, 1000], [21, 1000],
      );
    const underlay = importDxf(text);
    const t = layerByName(underlay, 'notes').texts[0];
    expect(t.text).toBe('45° angle');
    expect(t.align).toBe('center');
    expect(t.position.x).toBeCloseTo(1); // alignment point wins for non-default justification
    expect(t.position.y).toBeCloseTo(1);
    expect(t.height).toBeCloseTo(0.25);
  });

  it('parses MTEXT chunks and strips inline formatting', () => {
    const text = entitiesSection(
      [0, 'MTEXT'],
      [8, 'notes'],
      [10, 0], [20, 0],
      [40, 0.2],
      [3, '{\\fArial|b0|i0;First line'],
      [1, '\\PSecond~line}'],
    );
    const underlay = importDxf(text);
    const t = layerByName(underlay, 'notes').texts[0];
    expect(t.text).toBe('First line\nSecond~line');
  });

  it('expands INSERT with base point, scale, and rotation', () => {
    // Block "unit" holds a line (0,0)→(1,0) with base point (0,0).
    // Insert at (10, 0), scaled 2×, rotated 90° CCW → line (10,0)→(10,2) in world space.
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'BLOCKS'],
        [0, 'BLOCK'],
        [2, 'unit'],
        [10, 0], [20, 0],
        [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0],
        [0, 'ENDBLK'],
        [0, 'ENDSEC'],
      ) +
      entitiesSection(
        [0, 'INSERT'],
        [8, 'furniture'],
        [2, 'unit'],
        [10, 10], [20, 0],
        [41, 2], [42, 2],
        [50, 90],
      );
    const underlay = importDxf(text);
    // Block entity on layer "0" inherits the INSERT's layer.
    const layer = layerByName(underlay, 'furniture');
    const [a, b] = layer.paths[0].points;
    expect(a.x).toBeCloseTo(10);
    expect(a.y).toBeCloseTo(0);
    expect(b.x).toBeCloseTo(10, 6);
    expect(b.y).toBeCloseTo(2, 6);
  });

  it('guards against recursive block references', () => {
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'BLOCKS'],
        [0, 'BLOCK'],
        [2, 'loop'],
        [10, 0], [20, 0],
        [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0],
        [0, 'INSERT'], [2, 'loop'], [10, 1], [20, 0],
        [0, 'ENDBLK'],
        [0, 'ENDSEC'],
      ) +
      entitiesSection([0, 'INSERT'], [8, '0'], [2, 'loop'], [10, 0], [20, 0]);
    const underlay = importDxf(text);
    expect(layerByName(underlay, '0').paths).toHaveLength(1);
    expect(underlay.warnings.some((w) => w.includes('Recursive block'))).toBe(true);
  });

  it('renders DIMENSION via its anonymous block and counts missing blocks', () => {
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'BLOCKS'],
        [0, 'BLOCK'],
        [2, '*D1'],
        [10, 0], [20, 0],
        [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 5], [21, 0],
        [0, 'TEXT'], [8, '0'], [10, 2.5], [20, 0.2], [40, 0.2], [1, '5.00'],
        [0, 'ENDBLK'],
        [0, 'ENDSEC'],
      ) +
      entitiesSection(
        [0, 'DIMENSION'], [8, 'dims'], [2, '*D1'],
        [0, 'DIMENSION'], [8, 'dims'], [2, '*MISSING'],
      );
    const underlay = importDxf(text);
    const layer = layerByName(underlay, 'dims');
    expect(layer.paths).toHaveLength(1);
    expect(layer.texts).toHaveLength(1);
    expect(layer.texts[0].text).toBe('5.00');
    expect(underlay.skipped['DIMENSION']).toBe(1);
  });

  it('converts a solid HATCH polyline boundary with a hole', () => {
    const text = entitiesSection(
      [0, 'HATCH'],
      [8, 'fills'],
      [2, 'SOLID'],
      [70, 1],
      [91, 2],
      // Outer 10×10 square
      [92, 2], [72, 0], [73, 1], [93, 4],
      [10, 0], [20, 0],
      [10, 10], [20, 0],
      [10, 10], [20, 10],
      [10, 0], [20, 10],
      // Inner 2×2 hole
      [92, 2], [72, 0], [73, 1], [93, 4],
      [10, 4], [20, 4],
      [10, 6], [20, 4],
      [10, 6], [20, 6],
      [10, 4], [20, 6],
    );
    const underlay = importDxf(text);
    const fill = layerByName(underlay, 'fills').fills[0];
    expect(fill.pattern).toBe(false);
    expect(fill.polygon.outer).toHaveLength(4);
    expect(fill.polygon.holes).toHaveLength(1);
    expect(fill.polygon.holes[0]).toHaveLength(4);
    // Outer ring is the larger one regardless of order in the file.
    const outerWidth = Math.max(...fill.polygon.outer.map((p) => p.x)) - Math.min(...fill.polygon.outer.map((p) => p.x));
    expect(outerWidth).toBeCloseTo(10);
  });

  it('resolves entity colours: explicit ACI, true colour, and BYLAYER', () => {
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'TABLES'],
        [0, 'TABLE'],
        [2, 'LAYER'],
        [0, 'LAYER'], [2, 'L'], [62, 3], [70, 0],
        [0, 'ENDTAB'],
        [0, 'ENDSEC'],
      ) +
      entitiesSection(
        [0, 'LINE'], [8, 'L'], [10, 0], [20, 0], [11, 1], [21, 0], // BYLAYER
        [0, 'LINE'], [8, 'L'], [62, 1], [10, 0], [20, 1], [11, 1], [21, 1], // red
        [0, 'LINE'], [8, 'L'], [420, 1193046], [10, 0], [20, 2], [11, 1], [21, 2], // #123456
      );
    const underlay = importDxf(text);
    const layer = layerByName(underlay, 'L');
    expect(layer.color).toBe('#00ff00');
    expect(layer.paths[0].color).toBeUndefined(); // layer default
    expect(layer.paths[1].color).toBe('#ff0000');
    expect(layer.paths[2].color).toBe('#123456');
  });

  it('counts unsupported entity types and unknown units', () => {
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'HEADER'],
        [9, '$INSUNITS'],
        [70, 99],
        [0, 'ENDSEC'],
      ) +
      entitiesSection(
        [0, 'WIPEOUT'], [8, '0'], [10, 0], [20, 0],
        [0, 'WIPEOUT'], [8, '0'], [10, 1], [20, 1],
        [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 1], [21, 0],
      );
    const underlay = importDxf(text);
    expect(underlay.skipped['WIPEOUT']).toBe(2);
    expect(underlay.unitScale).toBe(1);
    expect(underlay.warnings.some((w) => w.includes('Unknown $INSUNITS'))).toBe(true);
    expect(layerByName(underlay, '0').paths).toHaveLength(1);
  });

  it('rejects binary DXF and malformed group codes with clear errors', () => {
    expect(() => parseDxf('AutoCAD Binary DXF\r\n rubbish')).toThrow(/Binary DXF/);
    expect(() => parseDxf('0\nSECTION\nnot-a-code\nvalue\n')).toThrow(/group code/);
  });

  it('parses classic POLYLINE/VERTEX/SEQEND chains', () => {
    const text = entitiesSection(
      [0, 'POLYLINE'], [8, 'topo'], [70, 0],
      [0, 'VERTEX'], [8, 'topo'], [10, 0], [20, 0],
      [0, 'VERTEX'], [8, 'topo'], [10, 5], [20, 0],
      [0, 'VERTEX'], [8, 'topo'], [10, 5], [20, 5],
      [0, 'SEQEND'],
      [0, 'LINE'], [8, 'topo'], [10, 0], [20, 0], [11, 1], [21, 1],
    );
    const underlay = importDxf(text);
    const layer = layerByName(underlay, 'topo');
    expect(layer.paths).toHaveLength(2);
    expect(layer.paths[0].points).toHaveLength(3);
    expect(layer.paths[0].points[2].x).toBeCloseTo(5);
    expect(layer.paths[0].points[2].y).toBeCloseTo(5);
  });

  it('computes bounds across all emitted geometry', () => {
    const text = entitiesSection(
      [0, 'LINE'], [8, '0'], [10, -3], [20, -2], [11, 7], [21, 4],
    );
    const underlay = importDxf(text);
    expect(underlay.bounds.min.x).toBeCloseTo(-3);
    expect(underlay.bounds.max.x).toBeCloseTo(7);
    expect(underlay.bounds.min.y).toBeCloseTo(-2);
    expect(underlay.bounds.max.y).toBeCloseTo(4);
  });
});

describe('consolidated additions (SPLINE, SOLID, lineweight, valign, unit heuristic)', () => {
  it('samples SPLINE control nets and falls back to fit points', () => {
    const text = entitiesSection(
      // Degree-2 clamped B-spline through 3 control points.
      [0, 'SPLINE'], [8, 'curves'], [71, 2], [70, 0],
      [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1],
      [10, 0], [20, 0],
      [10, 1], [20, 2],
      [10, 2], [20, 0],
      // Fit-point spline: fit points win.
      [0, 'SPLINE'], [8, 'curves'],
      [11, 5], [21, 5],
      [11, 6], [21, 7],
    );
    const underlay = importDxf(text);
    const [ctrl, fit] = layerByName(underlay, 'curves').paths;
    expect(ctrl.points.length).toBeGreaterThan(5);
    expect(ctrl.points[0].x).toBeCloseTo(0); // clamped: starts at first control point
    expect(ctrl.points[ctrl.points.length - 1].x).toBeCloseTo(2);
    // Curve midpoint of this parabola-like spline is at (1, 1).
    const mid = ctrl.points[Math.floor(ctrl.points.length / 2)];
    expect(mid.x).toBeCloseTo(1, 1);
    expect(mid.y).toBeCloseTo(1, 1);
    expect(fit.points).toHaveLength(2);
    expect(fit.points[1].y).toBeCloseTo(7);
  });

  it('converts SOLID with Z-order corners into a fill in draw order', () => {
    // Unit square: DXF order p1(0,0) p2(1,0) p3(0,1)@12 p4(1,1)@13.
    const text = entitiesSection(
      [0, 'SOLID'], [8, 'fills'],
      [10, 0], [20, 0],
      [11, 1], [21, 0],
      [12, 0], [22, 1],
      [13, 1], [23, 1],
    );
    const underlay = importDxf(text);
    const fill = layerByName(underlay, 'fills').fills[0];
    expect(fill.pattern).toBe(false);
    expect(fill.polygon.outer).toHaveLength(4);
    // Draw order 1,2,4,3 yields a convex quad, not a bow-tie: consecutive
    // cross products share a sign.
    const ring = fill.polygon.outer;
    const cross = (i: number) => {
      const a = ring[i], b = ring[(i + 1) % 4], c = ring[(i + 2) % 4];
      return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    };
    const signs = [0, 1, 2, 3].map((i) => Math.sign(cross(i)));
    expect(new Set(signs).size).toBe(1);
  });

  it('resolves lineweights: entity group 370 wins over the layer default', () => {
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'TABLES'],
        [0, 'TABLE'],
        [2, 'LAYER'],
        [0, 'LAYER'], [2, 'weighted'], [62, 7], [70, 0], [370, 50],
        [0, 'ENDTAB'],
        [0, 'ENDSEC'],
      ) +
      entitiesSection(
        [0, 'LINE'], [8, 'weighted'], [10, 0], [20, 0], [11, 1], [21, 0],
        [0, 'LINE'], [8, 'weighted'], [370, 100], [10, 0], [20, 1], [11, 1], [21, 1],
      );
    const underlay = importDxf(text);
    const [byLayer, explicit] = layerByName(underlay, 'weighted').paths;
    expect(byLayer.widthMm).toBeCloseTo(0.5);
    expect(explicit.widthMm).toBeCloseTo(1.0);
  });

  it('maps TEXT and MTEXT vertical justification', () => {
    const text = entitiesSection(
      [0, 'TEXT'], [8, 'notes'], [10, 0], [20, 0], [40, 1], [1, 'top-right'],
      [72, 2], [73, 3], [11, 0], [21, 0],
      [0, 'MTEXT'], [8, 'notes'], [10, 0], [20, 0], [40, 1], [1, 'bottom-center'], [71, 8],
    );
    const underlay = importDxf(text);
    const [t1, t2] = layerByName(underlay, 'notes').texts;
    expect(t1.align).toBe('right');
    expect(t1.valign).toBe('top');
    expect(t2.align).toBe('center');
    expect(t2.valign).toBe('bottom');
  });

  it('prefers a layer true colour (420) over its ACI colour for BYLAYER entities', () => {
    const text =
      pairsToText(
        [0, 'SECTION'],
        [2, 'TABLES'],
        [0, 'TABLE'],
        [2, 'LAYER'],
        [0, 'LAYER'], [2, 'branded'], [62, 3], [420, 1193046], [70, 0], // #123456 wins over green
        [0, 'ENDTAB'],
        [0, 'ENDSEC'],
      ) +
      entitiesSection(
        [0, 'LINE'], [8, 'branded'], [10, 0], [20, 0], [11, 1], [21, 0],
      );
    const underlay = importDxf(text);
    const layer = layerByName(underlay, 'branded');
    expect(layer.color).toBe('#123456');
    expect(layer.paths[0].color).toBeUndefined(); // BYLAYER inherits it
  });

  it('honours the clockwise flag on elliptical HATCH edges', () => {
    // Ellipse edge from 0° to 90°, clockwise (73 = 0): the boundary must be
    // the 270° complement mirrored across X, not the CCW quarter sweep.
    const buildHatch = (ccw: number) => entitiesSection(
      [0, 'HATCH'], [8, 'fills'], [2, 'SOLID'], [70, 1], [91, 1],
      [92, 0], [93, 1],
      [72, 3],
      [10, 0], [20, 0],
      [11, 10], [21, 0],
      [40, 0.5],
      [50, 0], [51, 90],
      [73, ccw],
    );
    const ccwFill = importDxf(buildHatch(1)).layers[0].fills[0];
    const cwFill = importDxf(buildHatch(0)).layers[0].fills[0];
    // CCW quarter sweep stays in the +x/+y quadrant (world y >= 0).
    expect(ccwFill.polygon.outer.every((p) => p.y >= -1e-9)).toBe(true);
    // CW gets the mirrored sweep: it must dip into negative world y.
    expect(cwFill.polygon.outer.some((p) => p.y < -1e-6)).toBe(true);
  });

  it('assumes millimetres for unitless files with large extents', () => {
    const big = entitiesSection(
      [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 25000], [21, 12000],
    );
    const underlay = importDxf(big);
    expect(underlay.unitScale).toBe(0.001);
    expect(underlay.bounds.max.x).toBeCloseTo(25);
    expect(underlay.warnings.some((w) => w.includes('assumed millimetres'))).toBe(true);

    const small = entitiesSection(
      [0, 'LINE'], [8, '0'], [10, 0], [20, 0], [11, 40], [21, 20],
    );
    const smallUnderlay = importDxf(small);
    expect(smallUnderlay.unitScale).toBe(1);
    expect(smallUnderlay.bounds.max.x).toBeCloseTo(40);
  });
});

describe('applyDxfPlacement', () => {
  it('applies scale, CCW plan rotation, and offset', () => {
    // Drawing-space point (1, 0) rotated 90° CCW on a plan (y-down screen)
    // lands at (0, -1) before offset.
    const p = applyDxfPlacement({ x: 1, y: 0 }, { offsetX: 10, offsetY: 20, rotationDeg: 90, scale: 2 });
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(18);
  });

  it('is identity with the default placement', () => {
    const p = applyDxfPlacement({ x: 3.5, y: -1.25 }, { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 1 });
    expect(p.x).toBeCloseTo(3.5);
    expect(p.y).toBeCloseTo(-1.25);
  });
});

describe('text decoding', () => {
  it('decodes %% special sequences and unicode escapes', () => {
    expect(decodeDxfText('45%%d %%p0.5 %%c20 \\U+00E9')).toBe('45° ±0.5 Ø20 é');
  });

  it('strips MTEXT formatting while preserving escaped backslashes', () => {
    expect(stripMtextFormatting('{\\fArial|b1;Bold} \\\\server\\share \\Pnext')).toBe('Bold \\server\\share \nnext');
  });
});
