/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfLandmarkAt, pdfLandmarkFraction } from './calibration.js';
import type { PdfRasterRecipe } from './types.js';

// A rotated page crop whose raster top-left maps to native PDF (30, 40).
const recipe: PdfRasterRecipe = {
  page: { pageNumber: 1, viewBox: [10, 20, 210, 320], userUnit: 2, intrinsicRotation: 90,
    widthPoints: 600, heightPoints: 400, pdfToPage: [0, 2, 2, 0, -40, -20] },
  rotation: 0, cropPoints: [40, 40, 200, 100], requestedDpi: 72, effectiveDpi: 72,
  pixelWidth: 200, pixelHeight: 100, paperSizeMetres: [200 / 72 * 0.0254, 100 / 72 * 0.0254],
  pixelToPdf: [0, 0.5, 0.5, 0, 30, 40],
};

test('PDF landmarks retain native identity across crop and DPI changes (#4260)', () => {
  const point = pdfLandmarkAt(recipe, [0.25, 0.5]);
  assert.deepEqual(point, [55, 65], 'physical native coordinates include rotated axes and crop origin');
  const higherDpi = { ...recipe, pixelWidth: 400, pixelHeight: 200,
    pixelToPdf: [0, 0.25, 0.25, 0, 30, 40] };
  assert.deepEqual(pdfLandmarkAt(higherDpi, [0.25, 0.5]), point);
  const tighterCrop = { ...recipe, pixelWidth: 100, pixelHeight: 50,
    pixelToPdf: [0, 0.5, 0.5, 0, 42.5, 52.5] };
  assert.deepEqual(pdfLandmarkFraction(tighterCrop, point), [0.25, 0.5]);
  assert.deepEqual(pdfLandmarkFraction(recipe, [500, 500]), [4.6, 9.4],
    'out-of-crop landmarks stay outside rather than being silently clamped to a new observation');
});

test('PDF landmark conversion rejects invalid display coordinates and collapsed frames (#4260)', () => {
  assert.throws(() => pdfLandmarkAt(recipe, [NaN, 0]), /inside/);
  assert.throws(() => pdfLandmarkAt(recipe, [-0.1, 0]), /inside/);
  assert.throws(() => pdfLandmarkAt({ ...recipe, pixelToPdf: [0, 0, 0, 0, 0, 0] }, [0, 0]), /collapsed/);
});
