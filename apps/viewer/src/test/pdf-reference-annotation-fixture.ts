/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { fixtureModel } from './store-fixture';
import { texturedProductSource } from './textured-product-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { calibrateAppearancePlane } from '@/lib/appearance/plane-calibration';
import { placementFrameKey } from '@/lib/model-placement/persistence';
import { PdfAppearanceSource } from '@/lib/appearance/pdf/source-document';
import { runPdfJob, type PdfEngineBackend } from '@/lib/appearance/pdf/engine';
import { controlledPdf } from '@/lib/appearance/pdf/fixtures';
import { rasterRecipe } from '@/lib/appearance/pdf/raster-recipe';
import { pdfCalibrationFrame } from '@/lib/appearance/pdf/calibration';
import { registerPdfDocument, removePdfDocument } from '@/lib/appearance/pdf/documents';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import type { PdfWorkerClient } from '@/lib/appearance/pdf/worker-client';
import { serializeReferences } from '@/lib/appearance/references/persistence';
import type { RegisteredAppearanceReference } from '@/lib/appearance/references/types';

/** Real PDF decoder, source owner, IFC store and reference state; raster pixels are not needed for vector preparation. */
export async function pdfReferenceAnnotationFixture() {
  federationRegistry.clear();
  const data = await new IfcParser().parseColumnar(texturedProductSource.slice().buffer);
  const view = new MutablePropertyView(data.properties, 'pdf-target'), editor = new StoreEditor(data, view);
  const idOffset = federationRegistry.registerModel('pdf-target', 53);
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const model = { ...fixtureModel('pdf-target'), idOffset, maxExpressId: 53, loadedAt: 123, schemaVersion: 'IFC4' as const,
    ifcDataStore: data, geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } } };
  useViewerStore.setState({ models: new Map([['pdf-target', model]]), activeModelId: 'pdf-target', geometryResult: model.geometryResult,
    mutationViews: new Map([['pdf-target', view]]), storeEditors: new Map([['pdf-target', editor]]), mutationVersion: 0,
    undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set(), collabRoomId: null, modelPlacement: emptyPlacementState(),
    appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [] });
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const backend: PdfEngineBackend = { getDocument: pdf.getDocument, vectorDecoder: { version: pdf.version, ops: pdf.OPS },
    options: { disableFontFace: true, useSystemFonts: false }, surface() { throw new Error('Vector preparation cannot create a raster surface'); } };
  const worker: PdfWorkerClient = { run: (bytes, job, options) => runPdfJob(backend, bytes, job, options), cancel() {}, dispose() {} };
  const bytes = controlledPdf();
  const document = await PdfAppearanceSource.open(new File([bytes], 'original.pdf'), appearanceAssets, { worker });
  const key = registerPdfDocument(document);
  const loading = pdf.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false });
  const decoded = await loading.promise;
  let recipe;
  try { recipe = rasterRecipe(await decoded.getPage(1), { pageNumber: 1, dpi: 144 }); }
  finally { await loading.destroy(); }
  const calibration = { ...pdfCalibrationFrame(recipe), sourcePoints: [[10, 20], [110, 20]] as [[number, number], [number, number]],
    distanceMetres: 4, worldAnchor: [0, 0, 0] as [number, number, number], worldDirection: [1, 0, 0] as [number, number, number], planeNormal: [0, 0, 1] as [number, number, number] };
  const calibrated = await calibrateAppearancePlane(calibration);
  const [tl, tr, br, bl] = calibrated.rasterCorners;
  const reference: RegisteredAppearanceReference = { id: 'pdf-reference', sourceId: key, assetId: '0'.repeat(64),
    frameKey: placementFrameKey(useViewerStore.getState()), visible: true, locked: false, opacity: 1, calibration,
    pdf: { documentSha256: document.id, recipe }, cornersIfcWorld: [tl, tr, br, bl] };
  useViewerStore.getState().importAppearanceReferences(serializeReferences(new Map([[reference.id, reference]]), reference.frameKey));
  return { document, key, view, data, reference: useViewerStore.getState().appearanceReferences.get(reference.id)!,
    dispose() {
      useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], models: new Map(),
        mutationViews: new Map(), storeEditors: new Map(), activeModelId: null, undoStacks: new Map(), redoStacks: new Map() });
      removePdfDocument(key); federationRegistry.clear();
    } };
}
