/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { PdfAppearanceSource } from '@/lib/appearance/pdf/source-document.js';
import { registerPdfDocument } from '@/lib/appearance/pdf/documents.js';
import { publishPdfRaster } from '@/lib/appearance/pdf/publish-source.js';
import { controlledPdf } from '@/lib/appearance/pdf/fixtures.js';
import type { PdfWorkerClient } from '@/lib/appearance/pdf/worker-client.js';
import { PdfAppearanceError, type PdfRasterRecipe, type PdfRasterRequest } from '@/lib/appearance/pdf/types.js';
import { usePdfAppearanceSource } from './usePdfAppearanceSource.js';
import { useAppearancePanel } from './useAppearancePanel.js';
import { AppearancePanelView } from './AppearancePanelView.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
const baseRecipe: PdfRasterRecipe = {
  page: { pageNumber: 1, viewBox: [0, 0, 72, 72], userUnit: 1, intrinsicRotation: 0,
    widthPoints: 72, heightPoints: 72, pdfToPage: [1, 0, 0, -1, 0, 72] },
  rotation: 0, cropPoints: [0, 0, 72, 72], requestedDpi: 144, effectiveDpi: 1,
  pixelWidth: 1, pixelHeight: 1, paperSizeMetres: [0.0254, 0.0254], pixelToPdf: [72, 0, 0, -72, 0, 72],
};
afterEach(() => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState({ appearanceDraft: null });
  for (const source of useViewerStore.getState().appearanceSources) useViewerStore.getState().removeAppearanceSource(source.id);
});
async function fixture(recipe: PdfRasterRecipe = baseRecipe, panel = false) {
  useViewerStore.setState({ appearanceDraft: null });
  let waitForRaster: Promise<void> | undefined;
  const requests: PdfRasterRequest[] = [];
  let disposed = false;
  const worker: PdfWorkerClient = {
    async run(_bytes, job) {
      if (disposed) throw new Error('Document worker disposed');
      if (job.kind === 'inspect') return { kind: 'inspect', pageCount: 3, page: recipe.page };
      requests.push(job.request);
      await waitForRaster;
      return { kind: 'raster', png, recipe: { ...recipe, page: { ...recipe.page, pageNumber: job.request.pageNumber },
        rotation: job.request.rotation ?? 0, requestedDpi: job.request.dpi ?? 144, cropPoints: job.request.cropPoints ?? recipe.cropPoints } };
    }, cancel() {}, dispose() { disposed = true; },
  };
  const document = await PdfAppearanceSource.open(new File([controlledPdf()], 'drawing.pdf', { type: 'application/pdf' }), appearanceAssets, { worker });
  const key = registerPdfDocument(document);
  publishPdfRaster(key, await document.rasterize({ pageNumber: 1, dpi: 144, rotation: recipe.rotation }));
  let current: ReturnType<typeof usePdfAppearanceSource> | undefined;
  let panelCurrent: ReturnType<typeof useAppearancePanel> | undefined;
  const errors: unknown[] = [];
  function PanelProbe() { panelCurrent = useAppearancePanel(); return <AppearancePanelView {...panelCurrent} />; }
  function Probe() {
    const source = useViewerStore(state => state.appearanceSources.find(item => item.id === key));
    current = usePdfAppearanceSource(source, () => {}, error => errors.push(error));
    return null;
  }
  const ui = render(panel ? <PanelProbe /> : <Probe />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  requests.length = 0;
  return { requests, errors, key, discard() {
      const button = [...ui.querySelectorAll('button')].find(item => item.textContent === 'Discard');
      assert.ok(button instanceof HTMLButtonElement);
      assert.equal(button.disabled, false, 'the actual footer must allow cancellation without a model preview');
      click(button);
    }, holdRaster(promise: Promise<void>) { waitForRaster = promise; },
    get panel() { assert.ok(panelCurrent); return panelCurrent; }, get current() { assert.ok(current); return current; } };
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


test('Discard cancels pending PDF controls without removing the retained source (#4260)', async () => {
  const f = await fixture(baseRecipe, true);
  const before = useViewerStore.getState().appearanceSources.find(item => item.id === f.key)!;
  act(() => f.panel.pdf!.onPageChange(3));
  act(() => f.panel.pdf!.onDpiChange(300));
  f.discard();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(f.requests.length, 0);
  assert.equal(f.panel.pdf!.pageNumber, 1);
  assert.equal(f.panel.pdf!.requestedDpi, 144);
  assert.equal(f.panel.sourceBusy, false);
  assert.equal(useViewerStore.getState().appearanceDraft!.previewEnabled, false);
  assert.equal(useViewerStore.getState().appearanceSources.find(item => item.id === f.key), before);
  assert.ok(appearanceAssets.get(before.assetId!));
});

test('Discard rejects a late PDF raster without resurrecting the appearance preview (#4260)', async () => {
  const f = await fixture(baseRecipe, true);
  const before = useViewerStore.getState().appearanceSources.find(item => item.id === f.key)!;
  let complete!: () => void;
  f.holdRaster(new Promise<void>(resolve => { complete = resolve; }));
  act(() => f.panel.pdf!.onDpiChange(300));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  assert.equal(f.requests.length, 1, 'raster really started before cancellation');
  f.discard();
  await act(async () => { complete(); await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(useViewerStore.getState().appearanceSources.find(item => item.id === f.key), before);
  assert.equal(useViewerStore.getState().appearanceDraft!.previewEnabled, false);
  assert.equal(f.panel.sourceBusy, false);
  assert.ok(appearanceAssets.get(before.assetId!));
});

test('Discard closes a PDF password prompt and preserves the existing source (#4260)', async () => {
  const f = await fixture(baseRecipe, true);
  const before = useViewerStore.getState().appearanceSources.find(item => item.id === f.key)!;
  mock.method(PdfAppearanceSource, 'open', async () => {
    throw new PdfAppearanceError('password-required', 'Password required');
  });
  await act(async () => { f.panel.onUpload(new File([controlledPdf()], 'protected.pdf', { type: 'application/pdf' })); });
  assert.ok(f.panel.pdfPassword);
  f.discard();
  assert.equal(f.panel.pdfPassword, undefined);
  assert.equal(f.panel.sourceBusy, false);
  assert.equal(useViewerStore.getState().appearanceSources.find(item => item.id === f.key), before);
  assert.ok(appearanceAssets.get(before.assetId!));
});
