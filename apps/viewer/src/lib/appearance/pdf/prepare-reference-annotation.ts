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
import type { PdfFidelityReport, PdfVectorPage, PreparedPdfVectorPage } from './vector-types';

/** Fidelity verdict for a registered page, before any IFC target is touched.
 * Holds the original document lease and the decoded page until disposed. */
export interface PdfReferenceVectorCheck {
  readonly page: PdfVectorPage;
  readonly prepared: PreparedPdfVectorPage;
  readonly report: PdfFidelityReport;
  /** Throws when the drawing, its calibration or the original document changed since the check. */
  validate(): void;
  dispose(): void;
  /** Plan the preview for review; a partial page needs `acceptPartial` — the
   * canonical planner refuses otherwise. No IFC rows or main-scene owner exist yet. */
  prepare(modelId: string, containerId: number, options: { Name: string; acceptPartial: boolean; signal?: AbortSignal }): Promise<PreparedPdfReferenceAnnotation>;
}
export interface PreparedPdfReferenceAnnotation {
  meshes: ReturnType<typeof authoredProductMesh>[];
  initialPlane: { up: [number, number, number]; normal: [number, number, number] };
  regions: number;
  toleranceMetres: number;
  fidelity: PdfFidelityReport;
  validate(): void;
  create(renderer: Renderer, commitOptions?: AppearanceCommitOptions): Promise<{ expressId: number; globalId: number }>;
}
/** Decode the registered original page and obtain its canonical fidelity report.
 * `options.signal` cancels the check itself; each later `prepare` carries its own signal. */
export async function checkPdfReferenceVectors(referenceId: string,
  options: { toleranceMetres: number; signal?: AbortSignal; planner?: AppearancePlanner }): Promise<PdfReferenceVectorCheck> {
  const reference = useViewerStore.getState().appearanceReferences.get(referenceId);
  if (!reference?.pdf) throw new Error('Register the drawing from its original PDF to use PDF vectors.');
  const found = findPdfDocument(reference.pdf.documentSha256);
  if (!found) throw new Error('Upload the original PDF again before preparing PDF vectors. Its saved document identity must match.');
  const owner = `pdf-annotation:${crypto.randomUUID()}`;
  retainPdfDocument(reference.pdf.documentSha256, owner);
  const planner = options.planner ?? createAppearancePlanner();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true; releasePdfDocument(reference.pdf!.documentSha256, owner);
    if (!options.planner) planner.dispose();
  };
  const check = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const state = useViewerStore.getState();
    if (disposed || state.appearanceReferences.get(referenceId) !== reference || referenceFrameStatus(reference, state) !== 'ready'
      || findPdfDocument(reference.pdf!.documentSha256)?.document !== found.document) {
      throw new Error('The drawing or its original PDF changed. Check the page again.');
    }
  };
  try {
    check(options.signal);
    const { frame, modelMetresFromPdf } = referenceVectorFrame(reference);
    const calibrationSha256 = await computeFullSourceHash(new TextEncoder().encode(JSON.stringify({
      pdf: reference.pdf, calibration: reference.calibration, corners: reference.cornersIfcWorld })));
    if (!calibrationSha256) throw new Error('This browser could not verify the saved PDF calibration.');
    const calibrationKey = `pdf-registration-sha256:${calibrationSha256}`;
    check(options.signal);
    const page = await found.document.vectors({ pageNumber: reference.pdf.recipe.page.pageNumber,
      modelMetresFromPdf, calibrationKey, toleranceMetres: options.toleranceMetres }, { signal: options.signal });
    check(options.signal);
    const originalPage = reference.pdf.recipe.page;
    if (page.userUnit !== originalPage.userUnit || page.intrinsicRotation !== originalPage.intrinsicRotation
      || page.viewBox.some((value, index) => value !== originalPage.viewBox[index])) {
      throw new Error('The original PDF page geometry does not match this registration. Re-register it before creating vectors.');
    }
    const prepared = await planner.pdfFidelity(page, { signal: options.signal });
    check(options.signal);
    if (prepared.pdfSha256 !== reference.pdf.documentSha256 || prepared.pageNumber !== originalPage.pageNumber
      || prepared.calibrationKey !== calibrationKey || prepared.toleranceMetres !== options.toleranceMetres) {
      throw new Error('The fidelity report does not match its frozen PDF page and calibration.');
    }
    const report = prepared.fidelity;
    return {
      page, prepared, report, dispose,
      validate: () => check(),
      async prepare(modelId, containerId, request) {
        const signal = request.signal;
        check(signal);
        if (report.rasterOnly) throw new Error('This page has no vector drawing content. Keep it as a raster reference.');
        if (!report.exact && !request.acceptPartial) throw new Error('Accept the fidelity report above before preparing a partial conversion.');
        if (report.convertiblePaths === 0) throw new Error('This page has no convertible vector paths.');
        const target = await prepareAuthoredProduct(modelId, signal, () => check(signal));
        const sourceIfcSha256 = await computeFullSourceHash(target.bytes);
        if (!sourceIfcSha256) throw new Error('This browser could not verify the target IFC snapshot.');
        target.validate();
        const placed = { ...frame, origin: frame.origin.map((value, index) => value - target.translation[index]) as [number, number, number] };
        const result = await planner.pdfFillPlan(target.bytes, { schema: target.schema, sourceRevision: target.sourceRevision,
          nextExpressId: target.nextExpressId, containerId, GlobalId: generateIfcGuid(), containmentGlobalId: generateIfcGuid(),
          propertySetGlobalId: generateIfcGuid(), propertyRelationGlobalId: generateIfcGuid(),
          Name: request.Name.trim() || 'PDF vector annotation', frame: placed, page, acceptedFidelitySha256: report.sha256 }, { signal });
        check(signal); target.validate();
        if (result.sourceIfcSha256 !== sourceIfcSha256 || result.sourcePdfSha256 !== reference.pdf!.documentSha256
          || result.pageNumber !== originalPage.pageNumber || result.calibrationKey !== calibrationKey
          || result.toleranceMetres !== options.toleranceMetres || result.fidelity.sha256 !== report.sha256
          || result.fidelity.exact !== report.exact) throw new Error('The vector plan does not match its frozen PDF, IFC and fidelity sources.');
        if (!result.meshes.length || result.meshes.length > 256
          || result.meshes.reduce((count, mesh) => count + mesh.positions.length / 3, 0) > 65_536
          || result.meshes.reduce((count, mesh) => count + mesh.indices.length / 3, 0) > 131_072) {
          throw new Error('The PDF annotation exceeds the bounded vector preview budget. Use Image for this drawing.');
        }
        const native = { ...result, objectId: result.annotationId };
        const meshes = native.meshes.map(mesh => authoredProductMesh(useViewerStore.getState(), modelId, native, mesh));
        const u = placed.axisU, v = placed.axisV;
        const initialPlane = { up: toRenderTranslation(v), normal: toRenderTranslation([
          u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]) };
        return { meshes, initialPlane, regions: result.regions.length, toleranceMetres: result.toleranceMetres, fidelity: result.fidelity,
          validate: target.validate,
          async create(renderer: Renderer, commitOptions: AppearanceCommitOptions = {}) {
            check(); target.validate();
            return commitAuthoredProduct(modelId, [], native, containerId, renderer, target.source, commitOptions);
          } };
      },
    };
  } catch (error) { dispose(); throw error; }
}
