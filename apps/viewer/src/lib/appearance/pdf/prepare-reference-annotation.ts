/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { toRenderTranslation } from '@/lib/model-placement/translation';
import { computeFullSourceHash } from '@/utils/sourceContentHash';
import { prepareAuthoredProduct } from '../prepare-authored-product';
import { referenceFrameStatus } from '../reference-runtime/frame';
import { createAppearancePlanner, type AppearancePlanner } from '../planner-worker-client';
import { commitAuthoredProduct } from '../authored-product-command';
import { authoredProductMesh } from '../authored-product-mesh';
import type { AppearanceCommitOptions } from '../command';
import { findPdfDocument, retainPdfDocument, releasePdfDocument } from './documents';
import { referenceVectorFrame } from './reference-vector-frame';

/** Prepare an exact native plan for review; no IFC rows or main-scene owner exist yet. */
export async function preparePdfReferenceAnnotation(modelId: string, containerId: number, referenceId: string,
  options: { Name: string; toleranceMetres: number; signal?: AbortSignal; planner?: AppearancePlanner }) {
  const reference = useViewerStore.getState().appearanceReferences.get(referenceId);
  if (!reference?.pdf) throw new Error('Register the drawing from its original PDF to use PDF vectors.');
  const found = findPdfDocument(reference.pdf.documentSha256);
  if (!found) throw new Error('Upload the original PDF again before preparing PDF vectors. Its saved document identity must match.');
  const owner = `pdf-annotation:${crypto.randomUUID()}`;
  retainPdfDocument(reference.pdf.documentSha256, owner);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; releasePdfDocument(reference.pdf!.documentSha256, owner); } };
  const validateReference = () => {
    options.signal?.throwIfAborted();
    const state = useViewerStore.getState();
    if (disposed || state.appearanceReferences.get(referenceId) !== reference || referenceFrameStatus(reference, state) !== 'ready'
      || findPdfDocument(reference.pdf!.documentSha256)?.document !== found.document) {
      throw new Error('The drawing or its original PDF changed. Prepare the preview again.');
    }
  };
  let planner: AppearancePlanner | undefined;
  try {
    planner = options.planner ?? createAppearancePlanner();
    validateReference();
    const { frame, modelMetresFromPdf } = referenceVectorFrame(reference);
    const target = await prepareAuthoredProduct(modelId, options.signal, validateReference);
    const sourceIfcSha256 = await computeFullSourceHash(target.bytes);
    if (!sourceIfcSha256) throw new Error('This browser could not verify the target IFC snapshot.');
    target.validate();
    const calibrationSha256 = await computeFullSourceHash(new TextEncoder().encode(JSON.stringify({
      pdf: reference.pdf, calibration: reference.calibration, corners: reference.cornersIfcWorld })));
    if (!calibrationSha256) throw new Error('This browser could not verify the saved PDF calibration.');
    const calibrationKey = `pdf-registration-sha256:${calibrationSha256}`;
    target.validate();
    const page = await found.document.vectors({ pageNumber: reference.pdf.recipe.page.pageNumber,
      modelMetresFromPdf, calibrationKey, toleranceMetres: options.toleranceMetres }, { signal: options.signal });
    target.validate();
    const originalPage = reference.pdf.recipe.page;
    if (page.userUnit !== originalPage.userUnit || page.intrinsicRotation !== originalPage.intrinsicRotation
      || page.viewBox.some((value, index) => value !== originalPage.viewBox[index])) {
      throw new Error('The original PDF page geometry does not match this registration. Re-register it before creating vectors.');
    }
    frame.origin = frame.origin.map((value, index) => value - target.translation[index]) as [number, number, number];
    const result = await planner.pdfFillPlan(target.bytes, { schema: target.schema, sourceRevision: target.sourceRevision,
      nextExpressId: target.nextExpressId, containerId, GlobalId: generateIfcGuid(), containmentGlobalId: generateIfcGuid(),
      Name: options.Name.trim() || 'PDF vector annotation', frame, page }, { signal: options.signal });
    target.validate();
    if (result.sourceIfcSha256 !== sourceIfcSha256 || result.sourcePdfSha256 !== reference.pdf.documentSha256
      || result.pageNumber !== originalPage.pageNumber || result.calibrationKey !== calibrationKey
      || result.toleranceMetres !== options.toleranceMetres) throw new Error('The vector plan does not match its frozen PDF and IFC sources.');
    if (!result.meshes.length || result.meshes.length > 256
      || result.meshes.reduce((count, mesh) => count + mesh.positions.length / 3, 0) > 65_536
      || result.meshes.reduce((count, mesh) => count + mesh.indices.length / 3, 0) > 131_072) {
      throw new Error('The PDF annotation exceeds the bounded vector preview budget. Use Image for this drawing.');
    }
    const native = { ...result, objectId: result.annotationId };
    const meshes = native.meshes.map(mesh => authoredProductMesh(useViewerStore.getState(), modelId, native, mesh));
    const u = frame.axisU, v = frame.axisV;
    const initialPlane = { up: toRenderTranslation(v), normal: toRenderTranslation([
      u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]) };
    return { meshes, initialPlane, regions: result.regions.length, toleranceMetres: result.toleranceMetres,
      validate: target.validate, dispose,
      async create(renderer: Renderer, commitOptions: AppearanceCommitOptions = {}) {
        try { target.validate(); return await commitAuthoredProduct(modelId, [], native, containerId, renderer, target.source, commitOptions); }
        finally { dispose(); }
      } };
  } catch (error) { dispose(); throw error; }
  finally { if (!options.planner) planner?.dispose(); }
}
export type PreparedPdfReferenceAnnotation = Awaited<ReturnType<typeof preparePdfReferenceAnnotation>>;
