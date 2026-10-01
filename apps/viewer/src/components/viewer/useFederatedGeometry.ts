/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef } from 'react';
import type { MeshData, CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store';
import { cpuMeshReleaseVersion, releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { carryReleasedMesh } from '@/lib/released-mesh-provenance';

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
  const mergedIndicesRef = useRef(new Map<string, number>());
  const mergedResultsRef = useRef(new Map<string, GeometryResult | null>());
  const mergedReleaseVersionsRef = useRef(new Map<string, number>());
  const mergedWrappersRef = useRef(new Map<string, MeshData[]>());

  // Stamp one stable owner index per mesh, incrementally for any model count.
  return useMemo(() => {
    const releasedModels = new Set<string>();
    // Check the previously cached sources before replacement or teardown can
    // discard them. A release batched with recolor, peer replacement or clear
    // must also empty wrappers still held by filtered consumers (#6537).
    for (const [modelId, source] of mergedSourcesRef.current) {
      if (!source || (mergedReleaseVersionsRef.current.get(modelId) ?? 0) === cpuMeshReleaseVersion(source)) continue;
      releaseCpuMeshBuffers(mergedWrappersRef.current.get(modelId)!);
      releasedModels.add(modelId);
    }
    if (storeModels.size > 0) {
      const singleModel = storeModels.size === 1 ? storeModels.values().next().value : undefined;
      const geometryFor = (model: FederatedModel) => model.geometryResult ?? (singleModel ? geometryResult : null);
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
        const modelGeometry = geometryFor(model);
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
          // Rebuild for other same-length result replacements. CPU-only
          // release refreshes retained wrappers in place below (#6537).
          (mergedResultsRef.current.get(modelId) !== modelGeometry
            && mergedLengthsRef.current.get(modelId) === meshCount && !releasedModels.has(modelId)) ||
          mergedIndicesRef.current.get(modelId) !== (modelIdToIndex.get(modelId) ?? 0) ||
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
        mergedIndicesRef.current = new Map();
        mergedResultsRef.current = new Map();
        mergedReleaseVersionsRef.current = new Map();
        mergedWrappersRef.current = new Map();
        for (const [modelId, model] of storeModels) {
          const modelGeometry = geometryFor(model);
          mergedVisibilityRef.current.set(modelId, model.visible);
          mergedSourcesRef.current.set(modelId, modelGeometry?.meshes);
          mergedResultsRef.current.set(modelId, modelGeometry);
          mergedReleaseVersionsRef.current.set(modelId, cpuMeshReleaseVersion(modelGeometry?.meshes));
          const modelIndex = modelIdToIndex.get(modelId) ?? 0;
          mergedIndicesRef.current.set(modelId, modelIndex);
          const wrappers: MeshData[] = [];
          mergedWrappersRef.current.set(modelId, wrappers);
          if (!model.visible || !modelGeometry?.meshes) {
            mergedLengthsRef.current.set(modelId, 0);
            continue;
          }
          for (const mesh of modelGeometry.meshes) {
            const wrapper = carryReleasedMesh(mesh, { ...mesh, modelIndex });
            wrappers.push(wrapper);
            rebuilt.push(wrapper);
          }
          mergedLengthsRef.current.set(modelId, modelGeometry.meshes.length);
        }
        mergedCacheRef.current = rebuilt;
      } else {
        for (const [modelId, model] of storeModels) {
          const modelGeometry = geometryFor(model);
          const modelIndex = modelIdToIndex.get(modelId) ?? 0;
          const previousLength = mergedLengthsRef.current.get(modelId) ?? 0;
          const nextMeshes = model.visible ? (modelGeometry?.meshes ?? []) : [];
          const wrappers = mergedWrappersRef.current.get(modelId)!;
          for (let i = previousLength; i < nextMeshes.length; i++) {
            const mesh = nextMeshes[i];
            const wrapper = carryReleasedMesh(mesh, { ...mesh, modelIndex });
            wrappers.push(wrapper);
            mergedCacheRef.current.push(wrapper);
          }
          mergedLengthsRef.current.set(modelId, nextMeshes.length);
          mergedVisibilityRef.current.set(modelId, model.visible);
          mergedSourcesRef.current.set(modelId, modelGeometry?.meshes);
          mergedResultsRef.current.set(modelId, modelGeometry);
          mergedReleaseVersionsRef.current.set(modelId, cpuMeshReleaseVersion(modelGeometry?.meshes));
        }
      }

      // Keep the same cached mesh suffix for one model and federations (#6537).
      // Retain the single-model metadata and point-cloud ownership contract.
      if (singleModel?.visible) {
        const singleGeometry = geometryFor(singleModel);
        const modelIndex = modelIdToIndex.get(singleModel.id) ?? 0;
        return singleGeometry ? { ...singleGeometry, meshes: mergedCacheRef.current,
          pointClouds: singleGeometry.pointClouds?.map(asset => ({ ...asset, modelIndex })) } : null;
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

    // Release cached model references when the federation is cleared.
    mergedCacheRef.current = [];
    mergedLengthsRef.current.clear();
    mergedVisibilityRef.current.clear();
    mergedSourcesRef.current.clear();
    mergedIndicesRef.current.clear();
    mergedResultsRef.current.clear();
    mergedReleaseVersionsRef.current.clear();
    mergedWrappersRef.current.clear();
    mergedContentVersionRef.current = geometryContentVersion;
    // Legacy mode (no federation): use original geometryResult
    return geometryResult;
  }, [storeModels, geometryResult, modelIdToIndex, geometryContentVersion]);

}
