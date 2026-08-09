/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The direct SVG export's world-metres -> paper-mm viewport arithmetic
 * (`useDrawingExport.ts`'s `generateExportSVG`, extracted here per the PR
 * #2119 follow-up: this was the fourth of four "world metres -> paper mm at
 * scale N" transforms, and the only one not yet pinned by a test — it was
 * inline, unexported, inside a hook with `useViewerStore` dependencies).
 *
 * Distinctive contract, unlike the other three: this transform does NOT map
 * points into paper-mm space. Path data is emitted in raw (axis-flipped)
 * WORLD units; the mm-per-world-unit scaling is entirely delegated to the
 * ratio between the SVG's `width`/`height` (mm) and its `viewBox` (world
 * units) — a renderer does the actual scaling when it lays the `viewBox`
 * into the `width`x`height` box.
 *
 * Equivalence with the pre-extraction inline code was established out of
 * band (not committed) by running the OLD formula and `computeSvgExportViewport`
 * side by side over 6 representative inputs (typical bounds at two scales,
 * a degenerate zero-size bounds, a falsy `scale` exercising the `|| 100`
 * default, and all three axes) and asserting `assert.strictEqual` — exact
 * bit-for-bit match, not "close enough" — on every returned field.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeSvgExportViewport, svgExportMmToWorld, type SvgExportBounds } from './svgExportViewport.js';

const bounds: SvgExportBounds = { min: { x: 0, y: 0 }, max: { x: 10, y: 5 } };
// width=10, height=5 -> padding = max(10,5)*0.1 = 1
// viewBoxWidth = 10 + 2 = 12, viewBoxHeight = 5 + 2 = 7

describe('computeSvgExportViewport', () => {
  it('sets width/height mm from the viewBox extent at the given scale (1:100)', () => {
    const v = computeSvgExportViewport(bounds, 100, 'down');
    // widthMm = viewBoxWidth * 1000 / scale = 12 * 1000 / 100 = 120
    assert.strictEqual(v.widthMm, 120);
    // heightMm = 7 * 1000 / 100 = 70
    assert.strictEqual(v.heightMm, 70);
    assert.strictEqual(v.viewBoxWidth, 12);
    assert.strictEqual(v.viewBoxHeight, 7);
    assert.strictEqual(v.effectiveScale, 100);
  });

  it('halves mm dimensions when the scale doubles (1:200) — same world extent', () => {
    const v100 = computeSvgExportViewport(bounds, 100, 'down');
    const v200 = computeSvgExportViewport(bounds, 200, 'down');
    // Same viewBox (world units) at every scale — only the paper mm changes.
    assert.strictEqual(v200.viewBoxWidth, v100.viewBoxWidth);
    assert.strictEqual(v200.viewBoxHeight, v100.viewBoxHeight);
    assert.strictEqual(v200.widthMm, v100.widthMm / 2);
    assert.strictEqual(v200.heightMm, v100.heightMm / 2);
    assert.strictEqual(v200.widthMm, 60);
    assert.strictEqual(v200.heightMm, 35);
  });

  it('falls back to scale 100 for a falsy scale (0), matching the `|| 100` default', () => {
    const v = computeSvgExportViewport(bounds, 0, 'down');
    assert.strictEqual(v.effectiveScale, 100);
    assert.strictEqual(v.widthMm, 120);
  });

  it('does not flip Y or X for the "down" (plan) axis', () => {
    const v = computeSvgExportViewport(bounds, 100, 'down');
    assert.strictEqual(v.flipY, false);
    assert.strictEqual(v.flipX, false);
    // Unflipped: viewBoxMin == bounds.min - padding, no mirroring.
    assert.strictEqual(v.viewBoxMinX, -1);
    assert.strictEqual(v.viewBoxMinY, -1);
  });

  it('flips Y (not X) for the "front" axis', () => {
    const v = computeSvgExportViewport(bounds, 100, 'front');
    assert.strictEqual(v.flipY, true);
    assert.strictEqual(v.flipX, false);
    // viewBoxMinX unflipped: bounds.min.x - padding = -1.
    assert.strictEqual(v.viewBoxMinX, -1);
    // viewBoxMinY flipped: -viewMinY - viewBoxHeight = -(-1) - 7 = -6.
    assert.strictEqual(v.viewBoxMinY, -6);
  });

  it('flips both Y and X for the "side" axis', () => {
    const v = computeSvgExportViewport(bounds, 100, 'side');
    assert.strictEqual(v.flipY, true);
    assert.strictEqual(v.flipX, true);
    // viewBoxMinX flipped: -viewMinX - viewBoxWidth = -(-1) - 12 = -11.
    assert.strictEqual(v.viewBoxMinX, -11);
    // viewBoxMinY flipped: -viewMinY - viewBoxHeight = -(-1) - 7 = -6.
    assert.strictEqual(v.viewBoxMinY, -6);
  });

  it('pads by 10% of max(width, height) of the UNPADDED bounds, in WORLD units', () => {
    // width=10, height=5 -> max=10 -> padding=1 (world units, not mm).
    const v = computeSvgExportViewport(bounds, 100, 'down');
    assert.strictEqual(v.viewBoxWidth, 10 + 2 * 1);
    assert.strictEqual(v.viewBoxHeight, 5 + 2 * 1);

    // A taller-than-wide bounds: padding tracks max(width, height), not width.
    const tall: SvgExportBounds = { min: { x: 0, y: 0 }, max: { x: 4, y: 20 } };
    const vTall = computeSvgExportViewport(tall, 100, 'down');
    const expectedPadding = Math.max(4, 20) * 0.1; // 2
    assert.strictEqual(vTall.viewBoxWidth, 4 + 2 * expectedPadding);
    assert.strictEqual(vTall.viewBoxHeight, 20 + 2 * expectedPadding);

    // Padding is unaffected by scale — it's a world-unit quantity, not mm.
    const vTallScaled = computeSvgExportViewport(tall, 500, 'down');
    assert.strictEqual(vTallScaled.viewBoxWidth, vTall.viewBoxWidth);
    assert.strictEqual(vTallScaled.viewBoxHeight, vTall.viewBoxHeight);
  });
});

describe('svgExportMmToWorld', () => {
  it('converts paper mm to world units via scale/1000 (inverse of the mm-per-world-unit ratio)', () => {
    // At 1:100, 1mm on paper = 0.1 world units (metres).
    assert.strictEqual(svgExportMmToWorld(1, 100), 0.1);
    assert.strictEqual(svgExportMmToWorld(10, 100), 1);
    // At 1:200, 1mm on paper = 0.2 world units.
    assert.strictEqual(svgExportMmToWorld(1, 200), 0.2);
  });
});
