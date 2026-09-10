/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef } from 'react';
import type { MeshData, CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store';
import { geometryWithModelIndex } from '@/lib/model-placement/model-indices';

const ZERO_VEC3 = { x: 0, y: 0, z: 0 };
const DEFAULT_COORDINATE_INFO: CoordinateInfo = {
  originShift: ZERO_VEC3,
  originalBounds: { min: ZERO_VEC3, max: ZERO_VEC3 },
  shiftedBounds: { min: ZERO_VEC3, max: ZERO_VEC3 },
  hasLargeCoordinates: false,
};

type Vec3Bounds = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/** True for a real (non-placeholder, non-degenerate) bounds box. */
function isUsableBounds(b: Vec3Bounds | undefined): b is Vec3Bounds {
  if (!b) return false;
  return (
    b.max.x > b.min.x || b.max.y > b.min.y || b.max.z > b.min.z
  );
}

/** Axis-aligned union of two bounds boxes (either may be undefined). */
function unionBounds(acc: Vec3Bounds | undefined, b: Vec3Bounds | undefined): Vec3Bounds | undefined {
  if (!isUsableBounds(b)) return acc;
  if (!acc) return { min: { ...b.min }, max: { ...b.max } };
  return {
    min: { x: Math.min(acc.min.x, b.min.x), y: Math.min(acc.min.y, b.min.y), z: Math.min(acc.min.z, b.min.z) },
    max: { x: Math.max(acc.max.x, b.max.x), y: Math.max(acc.max.y, b.max.y), z: Math.max(acc.max.z, b.max.z) },
  };
}

/** Cache only same-array streaming appends; immutable replacement may alter any owner (#4451). */
export function useFederatedGeometry(storeModels: ReadonlyMap<string, FederatedModel>,
  geometryResult: GeometryResult | null, modelIdToIndex: ReadonlyMap<string, number>, geometryContentVersion: number) {
  const mergedContentVersionRef = useRef(geometryContentVersion);
  const mergedCacheRef = useRef<MeshData[]>([]);
  const mergedLengthsRef = useRef<Map<string, number>>(new Map());
  const mergedVisibilityRef = useRef<Map<string, boolean>>(new Map());

  const mergedSourcesRef = useRef(new Map<string, MeshData[] | undefined>());

  // Multi-model: merge geometries from all visible models
  return useMemo(() => {
    if (storeModels.size === 1) {
      const firstModel = storeModels.values().next().value;
      if (!firstModel?.visible) {
        return {
          meshes: [],
          totalVertices: 0,
          totalTriangles: 0,
          coordinateInfo: DEFAULT_COORDINATE_INFO,
        } satisfies GeometryResult;
      }
      return geometryWithModelIndex(firstModel.geometryResult ?? geometryResult, modelIdToIndex.get(firstModel.id) ?? 0);
    }

    if (storeModels.size > 1) {
      let totalVertices = 0;
      let totalTriangles = 0;
      // The merged coordinateInfo must cover ALL visible models, not just the
      // first one — the renderer fits the camera to `shiftedBounds`, so a
      // first-wins box left every model after the first off-screen (it only
      // showed its 2D grid overlay). Union the bounds across visible models;
      // keep the first model's frame metadata (originShift / RTC) since
      // federated models share a coordinate frame.
      let baseCoordInfo: CoordinateInfo | undefined;
      let unionedShifted: Vec3Bounds | undefined;
      let unionedOriginal: Vec3Bounds | undefined;
      let anyLargeCoords = false;
      let shouldRebuild = false;

      if (mergedLengthsRef.current.size !== storeModels.size) {
        shouldRebuild = true;
      }

      // An external content version bump (e.g. realignFederation re-baked
      // vertices in place) requires a full cache rebuild — length/visibility
      // triggers above can't detect in-place mutation. Compare against the
      // last version we honoured; rebuild when it bumps.
      if (mergedContentVersionRef.current !== geometryContentVersion) {
        shouldRebuild = true;
        mergedContentVersionRef.current = geometryContentVersion;
      }

      for (const [modelId, model] of storeModels) {
        const modelGeometry = model.geometryResult;
        const meshCount = model.visible ? (modelGeometry?.meshes.length ?? 0) : 0;
        totalVertices += model.visible ? (modelGeometry?.totalVertices ?? 0) : 0;
        totalTriangles += model.visible ? (modelGeometry?.totalTriangles ?? 0) : 0;
        if (model.visible && modelGeometry?.coordinateInfo) {
          const ci = modelGeometry.coordinateInfo;
          if (!baseCoordInfo) baseCoordInfo = ci;
          anyLargeCoords = anyLargeCoords || !!ci.hasLargeCoordinates;
          unionedShifted = unionBounds(unionedShifted, ci.shiftedBounds);
          unionedOriginal = unionBounds(unionedOriginal, ci.originalBounds);
        }

        if (
          mergedSourcesRef.current.get(modelId) !== modelGeometry?.meshes ||
          mergedVisibilityRef.current.get(modelId) !== model.visible ||
          (mergedLengthsRef.current.get(modelId) ?? 0) > meshCount
        ) {
          shouldRebuild = true;
        }
      }

      if (shouldRebuild) {
        const rebuilt: MeshData[] = [];
        mergedLengthsRef.current = new Map();
        mergedVisibilityRef.current = new Map();
        mergedSourcesRef.current = new Map();
        for (const [modelId, model] of storeModels) {
          const modelGeometry = model.geometryResult;
          mergedVisibilityRef.current.set(modelId, model.visible);
          mergedSourcesRef.current.set(modelId, modelGeometry?.meshes);
          const modelIndex = modelIdToIndex.get(modelId) ?? 0;
          if (!model.visible || !modelGeometry?.meshes) {
            mergedLengthsRef.current.set(modelId, 0);
            continue;
          }
          for (const mesh of modelGeometry.meshes) {
            rebuilt.push({ ...mesh, modelIndex });
          }
          mergedLengthsRef.current.set(modelId, modelGeometry.meshes.length);
        }
        mergedCacheRef.current = rebuilt;
      } else {
        for (const [modelId, model] of storeModels) {
          const modelGeometry = model.geometryResult;
          const modelIndex = modelIdToIndex.get(modelId) ?? 0;
          const previousLength = mergedLengthsRef.current.get(modelId) ?? 0;
          const nextMeshes = model.visible ? (modelGeometry?.meshes ?? []) : [];
          for (let i = previousLength; i < nextMeshes.length; i++) {
            const mesh = nextMeshes[i];
            mergedCacheRef.current.push({ ...mesh, modelIndex });
          }
          mergedLengthsRef.current.set(modelId, nextMeshes.length);
          mergedVisibilityRef.current.set(modelId, model.visible);
          mergedSourcesRef.current.set(modelId, modelGeometry?.meshes);
        }
      }

      const mergedCoordinateInfo: CoordinateInfo | undefined = baseCoordInfo
        ? {
            ...baseCoordInfo,
            originalBounds: unionedOriginal ?? baseCoordInfo.originalBounds,
            shiftedBounds: unionedShifted ?? baseCoordInfo.shiftedBounds,
            hasLargeCoordinates: anyLargeCoords,
          }
        : undefined;

      return {
        meshes: mergedCacheRef.current,
        totalVertices,
        totalTriangles,
        coordinateInfo: mergedCoordinateInfo ?? DEFAULT_COORDINATE_INFO,
      } satisfies GeometryResult;
    }

    // Legacy mode (no federation): use original geometryResult
    return geometryResult;
  }, [storeModels, geometryResult, modelIdToIndex, geometryContentVersion]);

}
