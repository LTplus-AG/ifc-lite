/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sheetGeometryKeyOf` is what `useViewControls` diffs to decide the pinned
 * sheet-transform cache went stale, and what `sheetTransformCacheKeyOf`
 * (tested via `resolveSheetTransform` in sheet-transform.test.ts) is built
 * from. Its own module doc is explicit about why each field is in the key:
 * `setPaperSize`, `setFrameStyle`/`updateFrameMargins` and `setDrawingScale`
 * all mutate the SAME `activeSheet.id` in place (sheetSlice.ts), so the key
 * has to change even though `id` alone would not (PR #2853 review).
 *
 * `sheet-transform.test.ts` exercises the key only through sheets that also
 * differ by `id` (`buildSheet('some-other-sheet')`), which cannot tell
 * whether a same-id, scale-only (or paper-only, or viewport-only) change is
 * actually reflected in the key — a dropped field there would still pass
 * every test in that file. This file pins each field directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAPER_SIZE_REGISTRY,
  FRAME_PRESETS,
  TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
  type DrawingSheet,
} from '@ifc-lite/drawing-2d';
import { sheetGeometryKeyOf, sheetTransformCacheKeyOf } from './sheet-geometry-key.js';

/** A real, fully-populated `DrawingSheet`, mirroring what
 *  `sheetSlice.createDefaultSheet` produces (see sheet-transform.test.ts). */
function buildSheet(overrides: Partial<DrawingSheet> = {}): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY.A3_LANDSCAPE;
  const frame = { style: 'professional' as const, ...FRAME_PRESETS.professional };
  const titleBlock = {
    ...TITLE_BLOCK_PRESETS.standard,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };
  return {
    id: 'sheet-under-test',
    name: 'sheet-under-test',
    paper,
    frame,
    titleBlock,
    scaleBar: { ...DEFAULT_SCALE_BAR },
    scale: { name: '1:100', factor: 100, useCase: 'test' },
    northArrow: { ...DEFAULT_NORTH_ARROW },
    viewportBounds: { x: 10, y: 10, width: 200, height: 100 },
    revisions: [],
    ...overrides,
  };
}

describe('sheetGeometryKeyOf', () => {
  it('returns null for a missing sheet', () => {
    assert.equal(sheetGeometryKeyOf(null), null);
    assert.equal(sheetGeometryKeyOf(undefined), null);
  });

  it('changes when the SCALE changes, even though `id` does not (setDrawingScale, PR #2853)', () => {
    const at100 = sheetGeometryKeyOf(buildSheet({ scale: { name: '1:100', factor: 100, useCase: 'test' } }));
    const at50 = sheetGeometryKeyOf(buildSheet({ scale: { name: '1:50', factor: 50, useCase: 'test' } }));
    assert.notEqual(at100, at50, 'a scale-only change on the same sheet id must change the key');
  });

  it('changes when the PAPER size changes, even though `id` does not (setPaperSize, PR #2853)', () => {
    const a3 = sheetGeometryKeyOf(buildSheet({ paper: PAPER_SIZE_REGISTRY.A3_LANDSCAPE }));
    const a4 = sheetGeometryKeyOf(buildSheet({ paper: PAPER_SIZE_REGISTRY.A4_LANDSCAPE }));
    assert.notEqual(a3, a4, 'a paper-only change on the same sheet id must change the key');
  });

  it('changes when the VIEWPORT bounds change, even though `id` does not (frame margin edit, PR #2853)', () => {
    const narrow = sheetGeometryKeyOf(buildSheet({ viewportBounds: { x: 10, y: 10, width: 200, height: 100 } }));
    const wide = sheetGeometryKeyOf(buildSheet({ viewportBounds: { x: 10, y: 10, width: 250, height: 100 } }));
    assert.notEqual(narrow, wide, 'a viewport-only change on the same sheet id must change the key');
  });

  it('changes when the id changes, all else equal (loadTemplate)', () => {
    const a = sheetGeometryKeyOf(buildSheet({ id: 'sheet-a' }));
    const b = sheetGeometryKeyOf(buildSheet({ id: 'sheet-b' }));
    assert.notEqual(a, b);
  });

  it('is stable for an unchanged sheet', () => {
    assert.equal(sheetGeometryKeyOf(buildSheet()), sheetGeometryKeyOf(buildSheet()));
  });
});

describe('sheetTransformCacheKeyOf', () => {
  it('returns null for a missing sheet, independent of axis', () => {
    assert.equal(sheetTransformCacheKeyOf(null, 'down'), null);
  });

  it('folds a scale-only change into the cache key too', () => {
    const at100 = sheetTransformCacheKeyOf(buildSheet({ scale: { name: '1:100', factor: 100, useCase: 'test' } }), 'down');
    const at50 = sheetTransformCacheKeyOf(buildSheet({ scale: { name: '1:50', factor: 50, useCase: 'test' } }), 'down');
    assert.notEqual(at100, at50);
  });
});
