/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { federationFrameInfo, totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { captureModelLoaded, snapshotFromGeometry } from '../../utils/loadTelemetry.js';
import { createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import { toast } from '../../components/ui/toast.js';
import { useViewerStore } from '../../store/index.js';
import { parseLandXmlViewerModelAsync, type LandXmlViewerModel } from './landXmlViewerModel.js';
import type { LandXmlSourceBuffer } from './landXmlIngest.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';
import { MAX_RENDER_FRAME_ORIGIN_METRES, meshFitsRenderFrame, meshRenderFrameBounds } from './landXmlRenderFrame.js';

interface LandXmlLoadOptions {
  buffer: LandXmlSourceBuffer;
  fileSizeMB: number;
  targetKind: 'primary' | 'federated';
  totalStartTime: number;
  wasHidden: boolean;
  isCurrent(): boolean;
  setProgress(progress: { phase: string; percent: number }): void;
  setGeometryStreamingActive(active: boolean): void;
  setLoading(loading: boolean): void;
  onPrimary(result: LandXmlViewerModel): void;
  finalize(
    dataStore: IfcDataStore,
    geometry: GeometryResult,
    schemaVersion: 'IFC4',
    patch: { loadPath: 'landxml'; landXmlDocument?: LandXmlTinDocument; sourceSchema?: 'LandXML-1.2' },
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
  try {
    const result = await parseLandXmlViewerModelAsync(options.buffer, options.isCurrent);
    // The browser worker is terminated within the cancellation polling bound;
    // this guard also prevents a racing stale reply from mutating model state.
    if (!options.isCurrent()) return;
    const frame = options.targetKind === 'federated'
      ? federationFrameInfo(useViewerStore.getState().models.values())
      : null;
    if (frame && result.geometryResult.meshes.length > 0) result.warnings.push(...reframeLandXmlGeometry(result.geometryResult, result.semanticDocument, frame));
    if (options.targetKind === 'primary') options.onPrimary(result);
    await options.finalize(result.dataStore, result.geometryResult, result.schemaVersion, {
      loadPath: 'landxml', landXmlDocument: result.semanticDocument, sourceSchema: result.semanticDocument.schema,
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
    if (!options.isCurrent()) return;
    console.error('[useIfc] LandXML parsing failed:', error);
    const message = error instanceof Error ? error.message : String(error);
    options.onError(message);
    options.setLoading(false);
  }
}
