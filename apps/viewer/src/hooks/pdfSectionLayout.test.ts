/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Showstopper found on PR #2119: `front`/`side` PDF section exports render
 * off-page for any model at ordinary (asymmetric-about-zero) world
 * coordinates — see `pdfSectionLayout.ts` module doc for the mechanism.
 *
 * Deliberately uses ASYMMETRIC bounds (not centred on zero) for every axis:
 * a symmetric fixture passes against the bug (the old, buggy offsets happen
 * to be correct when `bounds.min === -bounds.max`), which is the exact trap
 * the original implementation fell into.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { projectTo2D, type Bounds2D } from '@ifc-lite/drawing-2d';
import { computePdfSectionLayout, makeSectionMapPoint, type SectionAxis } from './pdfSectionLayout.js';
import { computeSvgExportViewport } from './svgExportViewport.js';

// A model sitting at ordinary positive world coordinates, e.g. a building
// whose IFC origin is nowhere near (0,0). Width 10m x height 30m: NOT
// symmetric about zero on either axis.
const bounds: Bounds2D = { min: { x: 100, y: 50 }, max: { x: 110, y: 80 } };
const scaleFactor = 100; // 1:100
const marginMm = 10;

const corners = (b: Bounds2D) => [
  { x: b.min.x, y: b.min.y },
  { x: b.min.x, y: b.max.y },
  { x: b.max.x, y: b.min.y },
  { x: b.max.x, y: b.max.y },
];

function assertAllCornersOnPage(axis: SectionAxis) {
  const layout = computePdfSectionLayout(bounds, axis, scaleFactor, marginMm);
  const mapPoint = makeSectionMapPoint(axis, layout);
  for (const corner of corners(bounds)) {
    const p = mapPoint(corner.x, corner.y);
    assert.ok(
      p.x >= -1e-9 && p.x <= layout.page.widthMm + 1e-9,
      `axis=${axis}: mapped x=${p.x} is outside [0, ${layout.page.widthMm}] (corner ${JSON.stringify(corner)})`
    );
    assert.ok(
      p.y >= -1e-9 && p.y <= layout.page.heightMm + 1e-9,
      `axis=${axis}: mapped y=${p.y} is outside [0, ${layout.page.heightMm}] (corner ${JSON.stringify(corner)})`
    );
  }
}

describe('computePdfSectionLayout / makeSectionMapPoint (asymmetric bounds, per axis)', () => {
  it('down (plan, no flip): every corner lands on the page', () => {
    assertAllCornersOnPage('down');
  });

  it('front (flipY): every corner lands on the page', () => {
    assertAllCornersOnPage('front');
  });

  it('side (flipX + flipY): every corner lands on the page', () => {
    assertAllCornersOnPage('side');
  });

  it('higher engineering IFC Z stays above lower Z in Front/Side PDFs (#6615)', () => {
    // The canonical IFC Z-up → viewer Y-up conversion, then the real section
    // projector: this tests a physical height landmark, not the helper's flags.
    const viewerPoint = (ifcZ: number) => ({ x: 105, y: ifcZ, z: -10 });
    for (const flipped of [false,true]) for (const axis of ['front','side'] as const) {
      const project = (z:number) => projectTo2D(viewerPoint(z),axis==='side'?'x':'z',flipped);
      const base = project(50), roof = project(80);
      const extent = {min:{x:Math.min(base.x,roof.x)-1,y:50},max:{x:Math.max(base.x,roof.x)+1,y:80}};
      const map = makeSectionMapPoint(axis,computePdfSectionLayout(extent,axis,100,10));
      assert.ok(map(roof.x,roof.y).y < map(base.x,base.y).y, `${axis}, flipped=${flipped}: roof must be above slab`);
      assert.equal(map(base.x,base.y).y-map(roof.x,roof.y).y,300,'30 metre height prints 300 mm at 1:100');
    }
  });

  it('matches displayed SVG landmark directions and distances for all axes (#6615)', () => {
    for (const axis of ['down','front','side'] as const) {
      const layout = computePdfSectionLayout(bounds,axis,scaleFactor,marginMm);
      const map = makeSectionMapPoint(axis,layout);
      const svg = computeSvgExportViewport(bounds,scaleFactor,axis);
      const svgPaper = (x:number,y:number) => ({
        x:((svg.flipX?-x:x)-svg.viewBoxMinX)*svg.widthMm/svg.viewBoxWidth,
        y:((svg.flipY?-y:y)-svg.viewBoxMinY)*svg.heightMm/svg.viewBoxHeight,
      });
      const anchor = bounds.min, pdfAnchor = map(anchor.x,anchor.y), svgAnchor = svgPaper(anchor.x,anchor.y);
      for (const point of corners(bounds)) {
        const actual = map(point.x,point.y), expected = svgPaper(point.x,point.y);
        assert.ok(Math.abs((actual.x-pdfAnchor.x)-(expected.x-svgAnchor.x))<1e-9,`${axis} horizontal direction/scale`);
        assert.ok(Math.abs((actual.y-pdfAnchor.y)-(expected.y-svgAnchor.y))<1e-9,`${axis} vertical direction/scale`);
      }
    }
  });
});
