/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { appearanceAssets } from '../model-assets';
import { PdfAppearanceSource } from '../pdf/source-document';
import { controlledPdf } from '../pdf/fixtures';
import { registerPdfDocument, removePdfDocument, findPdfDocument } from '../pdf/documents';
import type { PdfWorkerClient } from '../pdf/worker-client';
import type { PdfRasterRecipe } from '../pdf/types';
import type { AppearanceSourceOption } from '../draft-types';
import type { PlaneCalibrationRequest } from '../plane-calibration';
import { captureReferencePdfLineage } from './pdf-lineage';
import { parseReferences } from './persistence';
import { restoreReferenceSource } from './edit';
import type { RegisteredAppearanceReference } from './types';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
const owner = { kind: 'source' as const, id: 'pdf-lineage-test' };
const calibration: PlaneCalibrationRequest = { rasterToSource: [72, 0, 0, -72, 0, 72], rasterSize: [1, 1],
  sourcePoints: [[0, 0], [72, 0]], distanceMetres: 1, worldAnchor: [0, 0, 0], worldDirection: [1, 0, 0], planeNormal: [0, 0, 1] };
function recipe(): PdfRasterRecipe {
  return { page: { pageNumber: 1, viewBox: [0, 0, 72, 72], userUnit: 1, intrinsicRotation: 0,
    widthPoints: 72, heightPoints: 72, pdfToPage: [1, 0, 0, -1, 0, 72] }, rotation: 0,
    cropPoints: [0, 0, 72, 72], requestedDpi: 1, effectiveDpi: 1, pixelWidth: 1, pixelHeight: 1,
    paperSizeMetres: [0.0254, 0.0254], pixelToPdf: [72, 0, 0, -72, 0, 72] };
}
const keys: string[] = [];
afterEach(() => {
  for (const source of useViewerStore.getState().appearanceSources) useViewerStore.getState().removeAppearanceSource(source.id);
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], appearanceSources: [] });
  for (const key of keys.splice(0)) removePdfDocument(key);
  appearanceAssets.releaseOwner(owner);
});
async function fixture(bytes = controlledPdf()) {
  let disposals = 0;
  // Substitute worker transport only; original-byte ownership, hashing, reference history and persistence are real.
  const client: PdfWorkerClient = { async run(_bytes, job) {
    if (job.kind !== 'inspect') throw new Error('Unexpected raster/vector job in lifetime test.');
    return { kind: 'inspect', pageCount: 2, page: { ...recipe().page, pageNumber: job.pageNumber ?? 1 } };
  }, cancel() {}, dispose() { disposals++; } };
  const document = await PdfAppearanceSource.open(new File([bytes], 'two-pages.pdf'), appearanceAssets, { worker: client });
  const key = registerPdfDocument(document); keys.push(key);
  const asset = await appearanceAssets.add(png, { owner });
  const source: AppearanceSourceOption = { id: key, assetId: asset.id, name: 'PDF page', width: 1, height: 1,
    pdf: { documentKey: key, recipe: recipe() } };
  const reference: RegisteredAppearanceReference = { id: 'drawing', sourceId: key, assetId: asset.id,
    cornersIfcWorld: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]], frameKey: placementFrameKey(useViewerStore.getState()),
    visible: true, locked: false, opacity: 1, calibration, pdf: captureReferencePdfLineage(source, calibration) };
  return { document, key, source, reference, disposals: () => disposals };
}
test('PDF page lineage survives mutable source replacement, image editing and registration export/restore (#4406)', async () => {
  const { source, reference, document } = await fixture();
  useViewerStore.getState().addAppearanceSource(source);
  useViewerStore.getState().addAppearanceReference(reference);
  const changed = { ...source, pdf: { ...source.pdf!, recipe: { ...recipe(), page: { ...recipe().page, pageNumber: 2 } } } };
  useViewerStore.getState().updateAppearanceSource(changed);
  const committed = useViewerStore.getState().appearanceReferences.get(reference.id)!;
  assert.equal(committed.pdf?.recipe.page.pageNumber, 1, 'equal raster bytes do not substitute a later PDF page');
  const restoredSource = restoreReferenceSource(committed);
  assert.equal(captureReferencePdfLineage(restoredSource, calibration)?.recipe.page.pageNumber, 1);
  assert.equal(captureReferencePdfLineage(restoredSource, calibration)?.documentSha256, document.id);
  const manifest = useViewerStore.getState().exportAppearanceReferences();
  const restored = parseReferences(manifest, reference.frameKey).get(reference.id)!;
  assert.equal(restored.pdf?.recipe.page.pageNumber, 1);
  assert.ok(Object.isFrozen(restored.pdf?.recipe.page));
  const malformed = JSON.parse(manifest); malformed.references[0].pdf.recipe.pixelToPdf[0] = 73;
  assert.throws(() => useViewerStore.getState().importAppearanceReferences(JSON.stringify(malformed)), /calibration/);
  assert.equal(useViewerStore.getState().appearanceReferences.get(reference.id), committed, 'invalid restore publishes nothing');
});
test('removing the PDF catalog source preserves its original until reference/history owners release it (#4406)', async () => {
  const { source, reference, document, disposals } = await fixture();
  useViewerStore.getState().addAppearanceSource(source);
  useViewerStore.getState().addAppearanceReference(reference);
  useViewerStore.getState().removeAppearanceSource(source.id);
  assert.equal((await document.page(1)).pageNumber, 1);
  useViewerStore.getState().removeAppearanceReference(reference.id);
  assert.equal(disposals(), 0, 'Undo still owns the original PDF');
  useViewerStore.getState().replayAppearanceReference('undo');
  assert.equal(findPdfDocument(document.id)?.document, document);
  useViewerStore.getState().replayAppearanceReference('redo');
  useViewerStore.setState({ referenceUndo: [], referenceRedo: [] });
  assert.equal(disposals(), 1);
  await assert.rejects(document.page(1), /removed/);
});
test('an old image-only registration is never promoted from its mutable PDF catalog slot (#4406)', async () => {
  const { source, reference } = await fixture();
  useViewerStore.getState().addAppearanceSource(source);
  const imageOnly = { ...reference, pdf: undefined };
  useViewerStore.getState().addAppearanceReference(imageOnly);
  const restored = restoreReferenceSource(useViewerStore.getState().appearanceReferences.get(reference.id)!);
  assert.equal(captureReferencePdfLineage(restored, calibration), undefined);
  assert.equal(restored.assetId, reference.assetId);
});

test('restored PDF provenance binds only an exact reimported original and acquires its own lease (#4406)', async () => {
  const first = await fixture();
  useViewerStore.getState().addAppearanceReference(first.reference);
  const manifest = useViewerStore.getState().exportAppearanceReferences();
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [] });
  removePdfDocument(first.key);
  assert.equal(first.disposals(), 1);
  useViewerStore.getState().importAppearanceReferences(manifest);
  const other = await fixture(controlledPdf('0 0 1 rg 1 2 3 4 re f\n'));
  useViewerStore.getState().addAppearanceSource(other.source);
  assert.equal(findPdfDocument(first.document.id), undefined, 'a different PDF with identical raster bytes is not the saved original');
  useViewerStore.getState().removeAppearanceSource(other.source.id);
  assert.equal(other.disposals(), 1);
  const exact = await fixture();
  useViewerStore.getState().addAppearanceSource(exact.source);
  useViewerStore.getState().removeAppearanceSource(exact.source.id);
  assert.equal((await exact.document.page(1)).pageNumber, 1, 'source-catalog publication acquired the restored reference lease');
  assert.equal(exact.disposals(), 0);
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [] });
  assert.equal(exact.disposals(), 1);
});

test('an explicit registered-page editing source owns the PDF after reference history is discarded (#4406)', async () => {
  const { source, reference, document, disposals } = await fixture();
  useViewerStore.getState().addAppearanceSource(source);
  useViewerStore.getState().addAppearanceReference(reference);
  const snapshot = restoreReferenceSource(useViewerStore.getState().appearanceReferences.get(reference.id)!);
  useViewerStore.getState().removeAppearanceSource(source.id);
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [] });
  assert.equal((await document.page(1)).pageNumber, 1, 'the editable snapshot has an independent original-PDF lease');
  useViewerStore.getState().removeAppearanceSource(snapshot.id);
  assert.equal(disposals(), 1);
});
