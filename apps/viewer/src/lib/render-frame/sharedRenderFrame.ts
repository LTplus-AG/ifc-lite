// SPDX-License-Identifier: MPL-2.0
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { federationFrameInfo } from '@ifc-lite/geometry/world-frame';
import type { FederatedModel } from '@/store/types';

/** Captures have placeholder geometry but never define the scene's IFC frame. */
export function frameCandidateModels(models: Iterable<FederatedModel>): FederatedModel[] {
  return [...models].filter(model => !model.gaussianSplat);
}

/** One frame for IFC geometry, point clouds, scene tools, and capture placement. */
export function sharedRenderFrame(
  models: Iterable<FederatedModel>,
  geometryResult?: { coordinateInfo?: CoordinateInfo | null } | null,
) {
  return federationFrameInfo(frameCandidateModels(models), geometryResult);
}
