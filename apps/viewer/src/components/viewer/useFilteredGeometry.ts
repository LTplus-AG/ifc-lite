/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { perfTally } from '@ifc-lite/load-trace';
import type { TypeVisibility, StructuralViewMode } from '@/store/types';
import type { RetypedClasses } from '@/store/typeVisibilityFilter';
import { meshClassIsPlaced, meshIsNonOccurrence, type TypeViewMode } from '@/lib/type-view-visibility';
import { sameMeshUpload } from './mesh-upload-identity.js';
import { TypeHiddenIndex, type TypeHiddenIds } from './type-hidden-index.js';
import { acknowledgeSnapshotTypeIndex, snapshotTypeIndex, subscribeSnapshotTypeIndex } from './snapshot-type-index.js';

/** The scene's mesh list and what type visibility hides of it. */
export interface SceneGeometry {
  hasTypeGeometry: boolean;
  hasOccurrenceGeometry: boolean;
  /** Every merged mesh, uploaded once whatever the type toggles say. */
  sceneGeometry: MeshData[] | null;
  geometryVersion: number;
  geometryReplacementVersion: number;
  /** Entity ids the type toggles, the Model/Types switch and the structural mode hide. */
  typeHidden: TypeHiddenIds;
}

/**
 * The viewport's scene geometry and type/view-mode visibility over the merged
 * geometry, moved out of `ViewportContainer` (#7021). Every scan here is
 * incremental over a same-array append and restarts only when the source
 * array changes identity or shrinks, so per-append cost depends on the source
 * keeping its identity across appends (`useFederatedGeometry`).
 * `viewer.filterScan` counts the meshes visited, so a source that changes
 * identity on every append shows up as quadratic visits under `?perfTrace=1`.
 */
export function useFilteredGeometry(
  mergedGeometryResult: GeometryResult | null,
  geometryContentVersion: number,
  typeVisibility: TypeVisibility,
  typeViewMode: TypeViewMode,
  structuralViewMode: StructuralViewMode = 'both',
  retypedClasses?: RetypedClasses,
): SceneGeometry {
  // Does the rendered geometry carry any type-library geometry? geometryClass
  // 1 = orphan type, 2 = instanced type; class 0 = placed occurrence. The
  // Model/Types switch is only meaningful — and "Types" only renders anything —
  // when class 1/2 meshes exist, so we surface this to gate the toolbar control
  // (#957 follow-up). Scanned incrementally (O(batch)) and short-circuited once
  // any type mesh is seen, so the common occurrence-only model costs at most a
  // single linear pass that stops early.
  const typeGeoSourceRef = useRef<MeshData[] | null>(null);
  const typeGeoScanLenRef = useRef(0);
  const sawTypeGeometryRef = useRef(false);
  const hasTypeGeometry = useMemo(() => {
    const meshes = mergedGeometryResult?.meshes;
    if (!meshes || meshes.length === 0) {
      typeGeoSourceRef.current = meshes ?? null;
      typeGeoScanLenRef.current = meshes?.length ?? 0;
      sawTypeGeometryRef.current = false;
      return false;
    }
    // New source array, or it shrank (new file / replace) → rescan from scratch.
    if (typeGeoSourceRef.current !== meshes || meshes.length < typeGeoScanLenRef.current) {
      typeGeoSourceRef.current = meshes;
      typeGeoScanLenRef.current = 0;
      sawTypeGeometryRef.current = false;
    }
    if (!sawTypeGeometryRef.current) {
      for (let i = typeGeoScanLenRef.current; i < meshes.length; i++) {
        if (meshIsNonOccurrence(meshes[i])) { sawTypeGeometryRef.current = true; break; }
      }
    }
    typeGeoScanLenRef.current = meshes.length;
    return sawTypeGeometryRef.current;
    // geometryContentVersion bumps per streaming batch — picks up type geometry
    // that arrives in a later batch even when the meshes array is mutated in place.
  }, [mergedGeometryResult, geometryContentVersion]);

  // Does the model carry any PLACED occurrence (class 0)? Used to decide whether
  // orphan type-library geometry (class 1) is clutter to hide in Model view or
  // the only geometry that must stay visible (pure type-library files). Same
  // incremental-scan pattern as hasTypeGeometry. (#1353)
  const occGeoSourceRef = useRef<MeshData[] | null>(null);
  const occGeoScanLenRef = useRef(0);
  const sawOccurrenceRef = useRef(false);
  const hasOccurrenceGeometry = useMemo(() => {
    const meshes = mergedGeometryResult?.meshes;
    if (!meshes || meshes.length === 0) {
      occGeoSourceRef.current = meshes ?? null;
      occGeoScanLenRef.current = meshes?.length ?? 0;
      sawOccurrenceRef.current = false;
      return false;
    }
    if (occGeoSourceRef.current !== meshes || meshes.length < occGeoScanLenRef.current) {
      occGeoSourceRef.current = meshes;
      occGeoScanLenRef.current = 0;
      sawOccurrenceRef.current = false;
    }
    if (!sawOccurrenceRef.current) {
      for (let i = occGeoScanLenRef.current; i < meshes.length; i++) {
        if (meshClassIsPlaced(meshes[i].geometryClass ?? 0)) { sawOccurrenceRef.current = true; break; }
      }
    }
    occGeoScanLenRef.current = meshes.length;
    return sawOccurrenceRef.current;
  }, [mergedGeometryResult, geometryContentVersion]);

  // An adopted scene snapshot draws before its meshes decode: its stored type
  // index answers until they are published (snapshot-type-index.ts).
  const snapshotIndex = useSyncExternalStore(subscribeSnapshotTypeIndex, snapshotTypeIndex, snapshotTypeIndex);
  const hasType = hasTypeGeometry || (snapshotIndex?.holds('nonOccurrence') ?? false);
  const hasPlaced = hasOccurrenceGeometry || (snapshotIndex?.holds('placed') ?? false);

  // Persisted view mode may be 'types' from a prior model; fall back to 'model'
  // when the current geometry has no type library so "Types" never renders an
  // empty scene (and the now-hidden switch can't be used to recover).
  const effectiveViewMode = hasType ? typeViewMode : 'model';

  // Every mesh goes to the scene once; type visibility is a set of hidden
  // entity ids the viewport hides on the GPU (`type-hidden-index.ts`), so a
  // toggle never re-uploads (#10264). The mirror below keeps one array
  // identity across appends, which the streaming hook relies on: it pushes
  // only new meshes, O(batch), and on a new source array compares the
  // existing uploads to bump the replacement version only when one changed.
  const sceneCacheRef = useRef<MeshData[]>([]);
  const sceneSourceLenRef = useRef(0);
  const sceneSourceRef = useRef<MeshData[] | null>(null);
  const sceneVersionRef = useRef(0);
  const replacementVersionRef = useRef(0);

  const sceneGeometry = useMemo(() => {
    if (!mergedGeometryResult?.meshes) {
      sceneCacheRef.current = [];
      sceneSourceLenRef.current = 0;
      sceneSourceRef.current = null;
      sceneVersionRef.current = 0;
      return null;
    }
    const allMeshes = mergedGeometryResult.meshes;
    const cache = sceneCacheRef.current;
    const prevCacheLen = cache.length;
    const sourceChanged = sceneSourceRef.current !== allMeshes;
    const rebuilding = sourceChanged || allMeshes.length < sceneSourceLenRef.current;
    if (rebuilding) {
      sceneSourceLenRef.current = 0;
      sceneSourceRef.current = allMeshes;
    }
    let writeIndex = rebuilding ? 0 : cache.length;
    let replaced = false;
    const scanFrom = sceneSourceLenRef.current;
    for (let i = scanFrom; i < allMeshes.length; i++) {
      const mesh = allMeshes[i];
      // Compare only during a rebuild; appends never revisit the prefix (#7047).
      if (rebuilding && writeIndex < prevCacheLen && !sameMeshUpload(cache[writeIndex], mesh)) replaced = true;
      cache[writeIndex++] = mesh;
    }
    cache.length = writeIndex;
    if (replaced || writeIndex < prevCacheLen) replacementVersionRef.current++;
    perfTally('viewer.filterScan', allMeshes.length - scanFrom, 'meshes');
    sceneSourceLenRef.current = allMeshes.length;
    if (cache.length !== prevCacheLen || sourceChanged) sceneVersionRef.current++;
    return cache;
  }, [mergedGeometryResult]);

  const typeHiddenIndexRef = useRef<TypeHiddenIndex | null>(null);
  const unionRef = useRef<{ parts: readonly TypeHiddenIds[]; result: TypeHiddenIds } | null>(null);
  const typeHidden = useMemo(() => {
    typeHiddenIndexRef.current ??= new TypeHiddenIndex();
    const settings = { typeVisibility, viewMode: effectiveViewMode, hasOccurrenceGeometry: hasPlaced, structuralViewMode, retyped: retypedClasses };
    const meshes = typeHiddenIndexRef.current.update(mergedGeometryResult?.meshes, settings);
    if (!snapshotIndex) return meshes;
    const stored = snapshotIndex.hiddenFor(settings);
    const previous = unionRef.current;
    if (previous && previous.parts[0] === meshes && previous.parts[1] === stored) return previous.result;
    const ids = new Set(stored.ids);
    for (const id of meshes.ids) ids.add(id);
    const result = { ids, version: (previous?.result.version ?? 0) + meshes.version + stored.version + 1 };
    unionRef.current = { parts: [meshes, stored], result };
    return result;
    // geometryContentVersion: a batch can land in a list mutated in place.
  }, [mergedGeometryResult, geometryContentVersion, typeVisibility, structuralViewMode, retypedClasses, effectiveViewMode, hasPlaced, snapshotIndex]);
  // Adoption paints once the viewport below has committed these ids.
  useEffect(() => { acknowledgeSnapshotTypeIndex(snapshotIndex); }, [snapshotIndex, typeHidden]);

  // Version counter that changes every batch — triggers useGeometryStreaming
  // without requiring a new geometry array reference.
  const geometryVersion = sceneVersionRef.current;

  return { hasTypeGeometry: hasType, hasOccurrenceGeometry: hasPlaced, sceneGeometry, geometryVersion,
    geometryReplacementVersion: replacementVersionRef.current, typeHidden };
}
