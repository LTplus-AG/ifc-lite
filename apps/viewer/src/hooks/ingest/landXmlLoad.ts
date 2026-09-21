/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, ModelSpatialReference } from '@ifc-lite/geometry';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { captureModelLoaded, snapshotFromGeometry } from '../../utils/loadTelemetry.js';
import { createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { toast } from '../../components/ui/toast.js';
import { parseLandXmlViewerModelFromBlobAsync, type LandXmlViewerModel } from './landXmlViewerModel.js';
import type { LandXmlGeometryPreflight } from './landXmlIngest.js';
import type { LandXmlSchema, LandXmlTinDocument } from './landXmlSemantics.js';
import { MAX_RENDER_FRAME_ORIGIN_METRES, meshFitsRenderFrame, meshRenderFrameBounds } from './landXmlRenderFrame.js';
import { LandXmlProvisionalTransaction } from './landXmlProvisionalTransaction.js';
import { markLandXmlGpuUploaded } from './landXmlGpuOwnership.js';
import { type FederatedLandXmlStreamingFinalization, FederatedLandXmlStreamingPlan } from './federatedLandXmlStreaming.js';

interface LandXmlLoadOptions {
  file: File;
  fileSizeMB: number;
  targetKind: 'primary' | 'federated';
  totalStartTime: number;
  wasHidden: boolean;
  isCurrent(): boolean;
  setProgress(progress: { phase: string; percent: number }): void;
  setGeometryStreamingActive(active: boolean): void;
  setLoading(loading: boolean): void;
  openProvisional?(preflight: LandXmlGeometryPreflight): LandXmlProvisionalTransaction | null;
  openFederatedStreamingPlan?(
    preflight: LandXmlGeometryPreflight,
    sourceCoordinateInfo: CoordinateInfo,
    spatialReference?: ModelSpatialReference,
  ): FederatedLandXmlStreamingPlan | null;
  onPrimary(result: LandXmlViewerModel): void;
  finalize(
    dataStore: IfcDataStore,
    geometry: GeometryResult,
    schemaVersion: 'IFC4',
    patch: {
      loadPath: 'landxml';
      landXmlDocument?: LandXmlTinDocument;
      sourceSchema?: LandXmlSchema;
      spatialReference?: ModelSpatialReference;
      postAlignmentReframe?: boolean;
      federatedLandXmlStreamingPlan?: FederatedLandXmlStreamingFinalization;
    },
  ): Promise<void>;
  onError(message: string): void;
}

function shiftBounds(
  bounds: CoordinateInfo['originalBounds'],
  offset: Readonly<{ x: number; y: number; z: number }>,
): CoordinateInfo['originalBounds'] {
  return {
    min: { x: bounds.min.x - offset.x, y: bounds.min.y - offset.y, z: bounds.min.z - offset.z },
    max: { x: bounds.max.x - offset.x, y: bounds.max.y - offset.y, z: bounds.max.z - offset.z },
  };
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/** Keep source inspection counts honest after federation drops mesh components. */
function recomputeRenderedFaceCounts(document: LandXmlTinDocument): void {
  const renderedBySurface = new Map<string, number>();
  for (const mesh of document.rendering.meshProvenance) {
    renderedBySurface.set(
      mesh.surfaceSourceId,
      (renderedBySurface.get(mesh.surfaceSourceId) ?? 0) + mesh.renderedFaceSourceIds.length,
    );
  }
  for (const counts of document.rendering.surfaceCounts) {
    counts.renderedFaces = renderedBySurface.get(counts.surfaceSourceId) ?? 0;
  }
}

function retainFederatedStreamedProvenance(document: LandXmlTinDocument, meshes: readonly GeometryResult['meshes'][number][]): void {
  const retainedIds = new Set(meshes.map((mesh) => mesh.expressId));
  document.rendering.meshProvenance = document.rendering.meshProvenance
    .filter((provenance) => retainedIds.has(provenance.meshExpressId));
  recomputeRenderedFaceCounts(document);
}

/** Recompute counts and frame metadata from the meshes that survived reframing. */
function updateRetainedGeometry(geometry: GeometryResult, frame: CoordinateInfo): void {
  const bounds = createEmptyBounds();
  let totalVertices = 0;
  let totalTriangles = 0;
  for (const mesh of geometry.meshes) {
    const meshBounds = meshRenderFrameBounds(mesh);
    if (meshBounds === null) throw new Error('LandXML retained a mesh without finite render-frame bounds');
    mergeBounds(bounds, meshBounds);
    totalVertices += mesh.positions.length / 3;
    totalTriangles += mesh.indices.length / 3;
  }
  const targetOffset = totalYupOffset(frame);
  const originShift = frame.originShift ?? { x: 0, y: 0, z: 0 };
  const worldBounds = shiftBounds(bounds, { x: -targetOffset.x, y: -targetOffset.y, z: -targetOffset.z });
  const rtcYup = {
    x: targetOffset.x - originShift.x,
    y: targetOffset.y - originShift.y,
    z: targetOffset.z - originShift.z,
  };
  geometry.totalVertices = totalVertices;
  geometry.totalTriangles = totalTriangles;
  geometry.coordinateInfo = {
    ...geometry.coordinateInfo,
    originShift: { ...originShift },
    originalBounds: shiftBounds(worldBounds, rtcYup),
    shiftedBounds: bounds,
    hasLargeCoordinates: Math.max(
      Math.abs(worldBounds.min.x), Math.abs(worldBounds.min.y), Math.abs(worldBounds.min.z),
      Math.abs(worldBounds.max.x), Math.abs(worldBounds.max.y), Math.abs(worldBounds.max.z),
    ) > 10_000,
    wasmRtcOffset: frame.wasmRtcOffset ? { ...frame.wasmRtcOffset } : undefined,
    wasmRtcFrame: frame.wasmRtcFrame ? { ...frame.wasmRtcFrame } : undefined,
  };
}

/** Move parsed LandXML into the federation's already-published render frame. */
export function reframeLandXmlGeometry(geometry: GeometryResult, document: LandXmlTinDocument, frame: CoordinateInfo): string[] {
  // Geometry-free LandXML still owns visible authored line overlays. Its
  // coordinates remain absolute until the overlay renderer subtracts this
  // frame, so there are no mesh origins to move: adopt the complete frame.
  // This also covers native adapter frames that use `originShift` without a
  // wasm RTC offset.
  if (geometry.meshes.length === 0) {
    geometry.coordinateInfo = structuredClone(frame);
    return [];
  }
  const ownOffset = totalYupOffset(geometry.coordinateInfo);
  const targetOffset = totalYupOffset(frame);
  const delta = {
    x: ownOffset.x - targetOffset.x,
    y: ownOffset.y - targetOffset.y,
    z: ownOffset.z - targetOffset.z,
  };
  for (const mesh of geometry.meshes) {
    const origin = mesh.origin ?? [0, 0, 0];
    mesh.origin = [origin[0] + delta.x, origin[1] + delta.y, origin[2] + delta.z];
  }
  const retained = geometry.meshes.filter(meshFitsRenderFrame);
  const skipped = geometry.meshes.length - retained.length;
  if (skipped > 0) {
    const retainedIds = new Set(retained.map((mesh) => mesh.expressId));
    for (const mesh of document.rendering.meshProvenance) {
      if (retainedIds.has(mesh.meshExpressId)) continue;
      const counts = document.rendering.surfaceCounts.find((count) => count.surfaceSourceId === mesh.surfaceSourceId);
      if (counts) counts.droppedReframeFaces += mesh.renderedFaceSourceIds.length;
    }
    document.rendering.meshProvenance = document.rendering.meshProvenance.filter((mesh) => retainedIds.has(mesh.meshExpressId));
    recomputeRenderedFaceCounts(document);
  }
  if (retained.length === 0) {
    throw new Error(`LandXML model cannot be federated: every surface component's full Y-up bounds exceed the ${MAX_RENDER_FRAME_ORIGIN_METRES / 1000} km shared render-frame limit`);
  }
  geometry.meshes = retained;
  updateRetainedGeometry(geometry, frame);
  return skipped === 0
    ? []
    : [`Skipped ${skipped} LandXML surface component(s) whose full Y-up bounds exceed ${MAX_RENDER_FRAME_ORIGIN_METRES / 1000} km from the shared federation render frame`];
}

/** Own the format-specific branch while `loadFile` retains lifecycle ownership. */
export async function loadLandXmlModel(options: LandXmlLoadOptions): Promise<void> {
  options.setProgress({ phase: 'Parsing LandXML TIN surfaces', percent: 10 });
  options.setGeometryStreamingActive(false);
  // The callbacks run after this stack frame has yielded to the worker. Keep
  // their mutable state in cells so both TypeScript and the error finalizer
  // observe the same live transaction.
  const provisional = { value: null as LandXmlProvisionalTransaction | null };
  const federatedPlan = { value: null as FederatedLandXmlStreamingPlan | null };
  let streamedComponents = 0;
  try {
    const result = await parseLandXmlViewerModelFromBlobAsync(
      options.file,
      options.isCurrent,
      (loadedBytes, totalBytes) => {
        if (!options.isCurrent()) return;
        options.setProgress({
          phase: 'Streaming LandXML TIN surfaces',
          percent: Math.min(90, 10 + Math.round((loadedBytes / totalBytes) * 80)),
        });
      },
      (preflight) => {
        if (!options.isCurrent()) throw new Error('LandXML parsing cancelled');
        provisional.value = options.openProvisional?.(preflight) ?? null;
      },
      (mesh) => {
        if (federatedPlan.value !== null) return federatedPlan.value.publish(mesh);
        if (provisional.value === null) return;
        provisional.value.publish(mesh);
        streamedComponents++;
      },
      (preflight, sourceCoordinateInfo, spatialReference) => {
        federatedPlan.value = options.openFederatedStreamingPlan?.(preflight, sourceCoordinateInfo, spatialReference) ?? null;
      },
      (mesh) => federatedPlan.value?.measure(mesh),
      () => federatedPlan.value?.freeze(),
    );
    // The browser worker is terminated within the cancellation polling bound;
    // this guard also prevents a racing stale reply from mutating model state.
    if (!options.isCurrent()) {
      provisional.value?.rollback();
      federatedPlan.value?.rollback();
      return;
    }
    if (provisional.value !== null) {
      for (const mesh of result.geometryResult.meshes.slice(streamedComponents)) provisional.value.publish(mesh);
      for (const mesh of result.geometryResult.meshes) {
        mesh.expressId += provisional.value.idOffset;
        markLandXmlGpuUploaded(mesh);
      }
      for (const provenance of result.semanticDocument.rendering.meshProvenance) {
        provenance.meshExpressId += provisional.value.idOffset;
      }
      provisional.value.commit();
    }
    if (federatedPlan.value !== null) {
      federatedPlan.value.complete(result.geometryResult);
      retainFederatedStreamedProvenance(result.semanticDocument, result.geometryResult.meshes);
      for (const mesh of result.geometryResult.meshes) markLandXmlGpuUploaded(mesh);
    }
    if (options.targetKind === 'primary') options.onPrimary(result);
    await options.finalize(result.dataStore, result.geometryResult, result.schemaVersion, {
      loadPath: 'landxml',
      landXmlDocument: result.semanticDocument,
      sourceSchema: result.semanticDocument.schema,
      // Reframing has to run after neutral spatial alignment. Doing it here
      // first clips a correctly georeferenced Swiss TIN against an unrelated
      // local IFC render frame before it can be brought into that frame.
      ...(options.targetKind === 'federated' ? { postAlignmentReframe: true } : {}),
      ...(federatedPlan.value ? { federatedLandXmlStreamingPlan: federatedPlan.value } : {}),
      ...(result.spatialReference ? { spatialReference: result.spatialReference } : {}),
    });
    if (!options.isCurrent()) return;
    for (const warning of result.warnings) toast.info(warning);
    options.setProgress({ phase: 'Complete', percent: 100 });
    captureModelLoaded({
      format: 'landxml',
      file_size_mb: Math.round(options.fileSizeMB * 100) / 100,
      load_target: options.targetKind,
      load_path: 'landxml',
      total_elapsed_ms: Math.round(performance.now() - options.totalStartTime),
      was_hidden: options.wasHidden,
    }, snapshotFromGeometry(options.fileSizeMB, result.geometryResult));
    options.setLoading(false);
  } catch (error) {
    provisional.value?.rollback();
    federatedPlan.value?.rollback();
    if (!options.isCurrent()) return;
    console.error('[useIfc] LandXML parsing failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    options.onError(message);
    options.setLoading(false);
  }
}
