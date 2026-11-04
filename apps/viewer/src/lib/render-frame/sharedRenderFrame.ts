// SPDX-License-Identifier: MPL-2.0
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { federationFrameInfo } from '@ifc-lite/geometry/world-frame';
import type { FederatedModel } from '@/store/types';

/** Captures and scan-only models never define the scene's IFC frame. */
export function frameCandidateModels(models: Iterable<FederatedModel>): FederatedModel[] {
  return [...models].filter(model => !model.gaussianSplat
    // Standalone scans carry synthetic zero coordinateInfo for their GPU asset.
    && !(model.geometryResult?.pointClouds?.length && model.geometryResult.meshes.length === 0));
}

/** One frame for IFC geometry, point clouds, scene tools, and capture placement. */
export function sharedRenderFrame(
  models: Iterable<FederatedModel>,
  geometryResult?: { coordinateInfo?: CoordinateInfo | null } | null,
): CoordinateInfo | null {
  return federationFrameInfo(frameCandidateModels(models), geometryResult);
}
