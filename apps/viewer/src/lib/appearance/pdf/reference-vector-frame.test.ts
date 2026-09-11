/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlledPdf } from './fixtures';
import { rasterRecipe } from './raster-recipe';
import { pdfCalibrationFrame } from './calibration';
import { referenceVectorFrame } from './reference-vector-frame';
import { rasterLandmarkAt } from '../raster-calibration';
import type { RegisteredAppearanceReference } from '../references/types';

test('real rotated CropBox/UserUnit PDF maps every raster corner into its registered IFC plane once (#4406)', async () => {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdf.getDocument({ data: controlledPdf(), disableFontFace: true, useSystemFonts: false });
  const document = await task.promise;
  try {
    const page = await document.getPage(1);
    for (const rotation of [0, 90, 180, 270] as const) {
      const recipe = rasterRecipe(page, { pageNumber: 1, rotation, dpi: 144 });
      const calibration = { ...pdfCalibrationFrame(recipe),
        sourcePoints: [[10, 20], [110, 20]] as [[number, number], [number, number]], distanceMetres: 4,
        worldAnchor: [10, 20, 30] as [number, number, number], worldDirection: [0, 1, 0] as [number, number, number], planeNormal: [1, 0, 0] as [number, number, number] };
      const reference: RegisteredAppearanceReference = { id: 'r', sourceId: 'pdf', assetId: 'image', frameKey: 'frame',
        visible: true, locked: false, opacity: 1, calibration, pdf: { documentSha256: 'a'.repeat(64), recipe },
        cornersIfcWorld: [[10, 20, 33], [10, 24, 33], [10, 24, 30], [10, 20, 30]] };
      const { frame, modelMetresFromPdf: m } = referenceVectorFrame(reference);
      const fractions = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
      for (const [index, fraction] of fractions.entries()) {
        const [x, y] = rasterLandmarkAt(calibration, fraction);
        const u = m[0] * x + m[2] * y + m[4], v = m[1] * x + m[3] * y + m[5];
        const world = frame.origin.map((value, axis) => value + frame.axisU[axis] * u + frame.axisV[axis] * v);
        world.forEach((value, axis) => assert.ok(Math.abs(value - reference.cornersIfcWorld[index][axis]) < 1e-10,
          `rotation ${rotation}, corner ${index}, axis ${axis}`));
      }
      const cropped = { ...reference, pdf: { ...reference.pdf!, recipe: { ...recipe, cropPoints: [1, 0, recipe.page.widthPoints - 1, recipe.page.heightPoints] as [number, number, number, number] } } };
      assert.throws(() => referenceVectorFrame(cropped), /whole PDF page/);
      assert.throws(() => referenceVectorFrame({ ...reference, pdf: undefined }), /original PDF/);
    }
  } finally { await task.destroy(); }
});
