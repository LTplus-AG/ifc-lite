/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pdfLineStyleFor` was extracted verbatim from the section PDF writer
 * (`useDrawingExport.ts`) so the to-scale 3D-view PDF (#2042) shares one line
 * hierarchy instead of hand-rolling a second switch that drifts.
 *
 * DEFECT CLASS: an "identical" refactor that quietly changes output. These
 * numbers ARE the shipped section-PDF weights, so they are pinned exactly —
 * if this file has to change, the section PDF's appearance changed with it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pdfLineStyleFor } from './pdf-line-style.js';

describe('pdfLineStyleFor', () => {
  it('pins the visible weight of every category, in mm on paper', () => {
    assert.deepEqual(pdfLineStyleFor('cut', 'visible'), { lineWidthMm: 0.5, dash: [] });
    assert.deepEqual(pdfLineStyleFor('silhouette', 'visible'), { lineWidthMm: 0.35, dash: [] });
    assert.deepEqual(pdfLineStyleFor('boundary', 'visible'), { lineWidthMm: 0.25, dash: [] });
    assert.deepEqual(pdfLineStyleFor('projection', 'visible'), { lineWidthMm: 0.25, dash: [] });
    assert.deepEqual(pdfLineStyleFor('crease', 'visible'), { lineWidthMm: 0.18, dash: [] });
    assert.deepEqual(pdfLineStyleFor('annotation', 'visible'), { lineWidthMm: 0.13, dash: [] });
  });

  it('dashes the hidden CATEGORY even when the segment itself is visible', () => {
    assert.deepEqual(pdfLineStyleFor('hidden', 'visible'), { lineWidthMm: 0.18, dash: [1, 0.6] });
  });

  it('thins an occluded segment to 70% and dashes it, on top of its category weight', () => {
    const occludedSilhouette = pdfLineStyleFor('silhouette', 'hidden');
    assert.deepEqual(occludedSilhouette.dash, [1, 0.6]);
    assert.equal(occludedSilhouette.lineWidthMm, 0.35 * 0.7);

    // The hierarchy survives occlusion: a hidden silhouette still outweighs a
    // hidden crease.
    assert.ok(occludedSilhouette.lineWidthMm > pdfLineStyleFor('crease', 'hidden').lineWidthMm);
  });

  it("leaves 'partial' visibility on the solid, full-weight path", () => {
    assert.deepEqual(pdfLineStyleFor('cut', 'partial'), { lineWidthMm: 0.5, dash: [] });
  });

  it('hands out a fresh dash array each call (jsPDF keeps the array it is given)', () => {
    const first = pdfLineStyleFor('hidden', 'visible');
    first.dash.push(99);

    assert.deepEqual(pdfLineStyleFor('hidden', 'visible').dash, [1, 0.6]);
  });
});
