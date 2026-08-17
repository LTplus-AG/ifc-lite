/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "as displayed" scale is the one number on this export an engineer
 * measures against (#2042), so every claim here is pinned as an exact figure,
 * not a range.
 *
 * Two defect classes:
 *  - devicePixelRatio double-counting. A CSS pixel is 1/96 inch by definition;
 *    a canvas' backing store is `cssPx * devicePixelRatio`. Reading device
 *    pixels — or "correcting" a CSS measurement by the ratio — reports a scale
 *    wrong by exactly that ratio (1:151 printed on a sheet labelled 1:76 on a
 *    2x display). The tests move the global and assert the answer does not.
 *  - A page named as fitting a sheet it actually runs off the edge of. The
 *    chosen ISO size must CONTAIN the page, and be the smallest that does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAPER_SIZE_REGISTRY } from '@ifc-lite/drawing-2d';
import {
  MAX_PDF_PAGE_DIMENSION_MM,
  describePage,
  deriveDisplayedScaleFactor,
  viewHalfHeightMetres,
  type DisplayedScaleInput,
} from './view-pdf-scale.js';

const EPS = 1e-9;

function orthoView(overrides: Partial<DisplayedScaleInput> = {}): DisplayedScaleInput {
  return {
    projectionMode: 'orthographic',
    orthoSize: 5,
    distance: 10,
    fovRadians: Math.PI / 3,
    canvasCssHeightPx: 500,
    ...overrides,
  };
}

describe('deriveDisplayedScaleFactor', () => {
  it('pins the orthographic case: orthoSize 5 m over 500 CSS px is 1:75.590551…', () => {
    const factor = deriveDisplayedScaleFactor(orthoView());

    assert.ok(factor !== null);
    // 10 m of world over 500/96 in = 132.291666…mm of screen.
    assert.ok(Math.abs(factor - 75.59055118110237) < EPS, `got ${factor}`);
  });

  it('means the print is physically the size of the screen image', () => {
    // The independent statement of the same claim: at the derived factor, the
    // 10 m the viewport shows occupies exactly the 132.29 mm of physical screen
    // it is displayed on (96 CSS px = 1 inch).
    const factor = deriveDisplayedScaleFactor(orthoView());
    assert.ok(factor !== null);

    const worldHeightOnPaperMm = (2 * 5 * 1000) / factor;
    assert.ok(Math.abs(worldHeightOnPaperMm - 132.29166666666666) < 1e-9, `${worldHeightOnPaperMm}`);
  });

  it('halves when the same world height is displayed over twice the CSS height', () => {
    const at500 = deriveDisplayedScaleFactor(orthoView());
    const at1000 = deriveDisplayedScaleFactor(orthoView({ canvasCssHeightPx: 1000 }));

    assert.ok(at500 !== null && at1000 !== null);
    assert.ok(Math.abs(at1000 - at500 / 2) < EPS);
  });

  it('reads the perspective half-height as distance * tan(fov/2) at the target', () => {
    const half = viewHalfHeightMetres(orthoView({ projectionMode: 'perspective' }));
    assert.ok(half !== null);
    assert.ok(Math.abs(half - 5.773502691896257) < EPS, `got ${half}`);

    const factor = deriveDisplayedScaleFactor(orthoView({ projectionMode: 'perspective' }));
    assert.ok(factor !== null);
    assert.ok(Math.abs(factor - 87.28445014520327) < EPS, `got ${factor}`);
  });

  it('gives a perspective view the same factor as the ortho view it converts to', () => {
    // `Camera.setProjectionMode('orthographic')` derives orthoSize with exactly
    // this expression, so "as displayed" must not jump when the user switches.
    const perspective = deriveDisplayedScaleFactor(orthoView({ projectionMode: 'perspective' }));
    const equivalent = deriveDisplayedScaleFactor(
      orthoView({ orthoSize: 10 * Math.tan(Math.PI / 3 / 2) }),
    );

    assert.ok(perspective !== null && equivalent !== null);
    assert.ok(Math.abs(perspective - equivalent) < EPS);
  });

  it('ignores devicePixelRatio entirely (the double-count defect)', () => {
    const original = Reflect.get(globalThis, 'devicePixelRatio');
    try {
      Reflect.set(globalThis, 'devicePixelRatio', 1);
      const atDpr1 = deriveDisplayedScaleFactor(orthoView());
      Reflect.set(globalThis, 'devicePixelRatio', 3);
      const atDpr3 = deriveDisplayedScaleFactor(orthoView());

      assert.ok(atDpr1 !== null && atDpr3 !== null);
      assert.equal(atDpr1, atDpr3);
      assert.ok(Math.abs(atDpr3 - 75.59055118110237) < EPS);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'devicePixelRatio');
      else Reflect.set(globalThis, 'devicePixelRatio', original);
    }
  });

  it('returns null rather than a NaN scale for a degenerate view or canvas', () => {
    assert.equal(deriveDisplayedScaleFactor(orthoView({ orthoSize: 0 })), null);
    assert.equal(deriveDisplayedScaleFactor(orthoView({ orthoSize: Number.NaN })), null);
    assert.equal(deriveDisplayedScaleFactor(orthoView({ canvasCssHeightPx: 0 })), null);
    assert.equal(deriveDisplayedScaleFactor(orthoView({ canvasCssHeightPx: -500 })), null);
    assert.equal(
      deriveDisplayedScaleFactor(orthoView({ projectionMode: 'perspective', distance: 0 })),
      null,
    );
  });
});

/** Every ISO sheet that would fully contain `page`, smallest area first. */
function containingIsoAreas(page: { widthMm: number; heightMm: number }): number[] {
  return Object.values(PAPER_SIZE_REGISTRY)
    .filter(
      (p) => p.category === 'ISO' && p.widthMm >= page.widthMm && p.heightMm >= page.heightMm,
    )
    .map((p) => p.widthMm * p.heightMm)
    .sort((a, b) => a - b);
}

describe('describePage', () => {
  it('names A3 landscape for a page that is exactly A3 landscape', () => {
    const { paper, oversize } = describePage({ widthMm: 420, heightMm: 297 });

    assert.equal(oversize, false);
    assert.equal(paper?.id, 'A3_LANDSCAPE');
  });

  it('never names a sheet the page does not fit inside', () => {
    for (const page of [
      { widthMm: 420, heightMm: 297 },
      { widthMm: 421, heightMm: 297 },
      { widthMm: 200, heightMm: 300 },
      { widthMm: 641, heightMm: 428 },
      { widthMm: 33.7, heightMm: 1000 },
    ]) {
      const { paper } = describePage(page);
      assert.ok(paper !== null, `expected an ISO sheet for ${page.widthMm}x${page.heightMm}`);
      assert.ok(
        paper.widthMm >= page.widthMm && paper.heightMm >= page.heightMm,
        `${paper.id} (${paper.widthMm}x${paper.heightMm}) does not contain ${page.widthMm}x${page.heightMm}`,
      );
      // …and it is the SMALLEST that does.
      assert.equal(paper.widthMm * paper.heightMm, containingIsoAreas(page)[0]);
    }
  });

  it('picks the portrait sheet for a portrait page', () => {
    // 200 x 300 mm is too tall for A4 portrait (210 x 297).
    const { paper } = describePage({ widthMm: 200, heightMm: 300 });
    assert.equal(paper?.id, 'A3_PORTRAIT');
  });

  it('resolves an orientation tie deterministically, toward the page shape', () => {
    // A square-ish page fits A3 portrait and A3 landscape equally well.
    assert.equal(describePage({ widthMm: 250, heightMm: 250 }).paper?.id, 'A3_LANDSCAPE');
    assert.equal(describePage({ widthMm: 250, heightMm: 260 }).paper?.id, 'A3_PORTRAIT');
  });

  it('reports no ISO sheet when the page is bigger than A0', () => {
    const { paper, oversize } = describePage({ widthMm: 1500, heightMm: 1000 });

    assert.equal(paper, null);
    assert.equal(oversize, false); // large, but still a legal PDF page
  });

  it('flags a 6000 mm side as oversize for a PDF page', () => {
    assert.equal(MAX_PDF_PAGE_DIMENSION_MM, 5080);
    assert.equal(describePage({ widthMm: 6000, heightMm: 400 }).oversize, true);
    assert.equal(describePage({ widthMm: 400, heightMm: 6000 }).oversize, true);
    assert.equal(describePage({ widthMm: 5080, heightMm: 5080 }).oversize, false);
  });

  it('treats a non-finite or empty page as unprintable', () => {
    assert.deepEqual(describePage({ widthMm: Number.NaN, heightMm: 100 }), {
      paper: null,
      oversize: true,
    });
    assert.deepEqual(describePage({ widthMm: 0, heightMm: 0 }), { paper: null, oversize: true });
  });
});
