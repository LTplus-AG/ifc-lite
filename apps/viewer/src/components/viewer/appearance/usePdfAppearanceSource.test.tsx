/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { PdfAppearanceSource } from '@/lib/appearance/pdf/source-document.js';
import { registerPdfDocument } from '@/lib/appearance/pdf/documents.js';
import { publishPdfRaster } from '@/lib/appearance/pdf/publish-source.js';
import { controlledPdf } from '@/lib/appearance/pdf/fixtures.js';
import type { PdfWorkerClient } from '@/lib/appearance/pdf/worker-client.js';
import type { PdfRasterRecipe, PdfRasterRequest } from '@/lib/appearance/pdf/types.js';
import { usePdfAppearanceSource } from './usePdfAppearanceSource.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
const baseRecipe: PdfRasterRecipe = {
  page: { pageNumber: 1, viewBox: [0, 0, 72, 72], userUnit: 1, intrinsicRotation: 0,
    widthPoints: 72, heightPoints: 72, pdfToPage: [1, 0, 0, -1, 0, 72] },
  rotation: 0, cropPoints: [0, 0, 72, 72], requestedDpi: 144, effectiveDpi: 1,
  pixelWidth: 1, pixelHeight: 1, paperSizeMetres: [0.0254, 0.0254], pixelToPdf: [72, 0, 0, -72, 0, 72],
};
afterEach(() => {
  cleanup();
  for (const source of useViewerStore.getState().appearanceSources) useViewerStore.getState().removeAppearanceSource(source.id);
});
async function fixture(recipe: PdfRasterRecipe = baseRecipe) {
  const requests: PdfRasterRequest[] = [];
  let disposed = false;
  const worker: PdfWorkerClient = {
    async run(_bytes, job) {
      if (disposed) throw new Error('Document worker disposed');
      if (job.kind === 'inspect') return { kind: 'inspect', pageCount: 3, page: recipe.page };
      requests.push(job.request);
      return { kind: 'raster', png, recipe: { ...recipe, page: { ...recipe.page, pageNumber: job.request.pageNumber },
        rotation: job.request.rotation ?? 0, requestedDpi: job.request.dpi ?? 144, cropPoints: job.request.cropPoints ?? recipe.cropPoints } };
    }, cancel() {}, dispose() { disposed = true; },
  };
  const document = await PdfAppearanceSource.open(new File([controlledPdf()], 'drawing.pdf', { type: 'application/pdf' }), appearanceAssets, { worker });
  const key = registerPdfDocument(document);
  publishPdfRaster(key, await document.rasterize({ pageNumber: 1, dpi: 144, rotation: recipe.rotation }));
  let current: ReturnType<typeof usePdfAppearanceSource> | undefined;
  const errors: unknown[] = [];
  function Probe() {
    const source = useViewerStore(state => state.appearanceSources.find(item => item.id === key));
    current = usePdfAppearanceSource(source, () => {}, error => errors.push(error));
    return null;
  }
  render(<Probe />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  requests.length = 0;
  return { requests, errors, key, get current() { assert.ok(current); return current; } };
}

test('rapid page and quality changes preserve both user choices in the published raster (#4260)', async () => {
  const f = await fixture();
  act(() => f.current.controls!.onPageChange(2));
  act(() => f.current.controls!.onDpiChange(300));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  const source = useViewerStore.getState().appearanceSources.find(item => item.id === f.key)!;
  assert.equal(source.pdf!.recipe.page.pageNumber, 2, 'quality must not revert the pending page choice');
  assert.equal(source.pdf!.recipe.requestedDpi, 300);
  assert.deepEqual(f.errors, []);
});

test('closing the dock cancels a debounced page change and preserves the catalog raster (#4260)', async () => {
  const f = await fixture();
  const before = useViewerStore.getState().appearanceSources.find(item => item.id === f.key)!;
  act(() => f.current.controls!.onPageChange(3));
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(f.requests.length, 0, 'no delayed worker request after unmount');
  assert.equal(useViewerStore.getState().appearanceSources.find(item => item.id === f.key), before);
  assert.ok(appearanceAssets.get(before.assetId!), 'source retains its raster while the dock is closed');
  assert.deepEqual(f.errors, []);
});

// The worker contract already rotates page.widthPoints/heightPoints. Applying
// the quarter turn twice sent real HABS crops outside the raster bounds.
test('resolved non-square rotated pages keep the worker extent for crop controls (#4260)', async () => {
  const f = await fixture({ ...baseRecipe, rotation: 90,
    page: { ...baseRecipe.page, widthPoints: 36, heightPoints: 72 }, cropPoints: [0, 0, 36, 72] });
  assert.deepEqual(f.current.controls!.pageSizePoints, [36, 72]);
  act(() => f.current.controls!.onCropChange([0, 0, ...f.current.controls!.pageSizePoints]));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  const source = useViewerStore.getState().appearanceSources.find(item => item.id === f.key)!;
  assert.deepEqual(source.pdf!.recipe.cropPoints, [0, 0, 36, 72]);
  assert.deepEqual(f.errors, []);
});
