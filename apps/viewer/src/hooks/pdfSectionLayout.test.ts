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
import type { Bounds2D } from '@ifc-lite/drawing-2d';
import { computePdfSectionLayout, makeSectionMapPoint, type SectionAxis } from './pdfSectionLayout.js';

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
});
