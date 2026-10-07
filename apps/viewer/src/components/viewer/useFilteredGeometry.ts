/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useRef } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { perfTally } from '@ifc-lite/load-trace';
import type { TypeVisibility } from '@/store/types';
import { isTypeVisible } from '@/store/typeVisibilityFilter';
import { isMeshVisibleInViewMode, meshClassIsPlaced, meshIsNonOccurrence, type TypeViewMode } from '@/lib/type-view-visibility';

/**
 * The viewport's type/view-mode filter over the merged geometry, moved out of
 * `ViewportContainer` (#7021). Every scan here is incremental over a
 * same-array append and restarts only when the source array changes identity
 * or shrinks, so per-append cost depends on the source keeping its identity
 * across appends (`useFederatedGeometry`). `viewer.filterScan` counts the
 * meshes the filter visits, so a source that changes identity on every append
 * shows up as quadratic visits under `?perfTrace=1`.
 */
export function useFilteredGeometry(
  mergedGeometryResult: GeometryResult | null,
  geometryContentVersion: number,
  typeVisibility: TypeVisibility,
  typeViewMode: TypeViewMode,
): { hasTypeGeometry: boolean; hasOccurrenceGeometry: boolean; filteredGeometry: MeshData[] | null; geometryVersion: number } {
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

  // Persisted view mode may be 'types' from a prior model; fall back to 'model'
  // when the current geometry has no type library so "Types" never renders an
  // empty scene (and the now-hidden switch can't be used to recover).
  const effectiveViewMode = hasTypeGeometry ? typeViewMode : 'model';

  // PERF: Incremental geometry filtering using refs.
  // Instead of creating a new 200K+ element array every batch (~200ms),
  // we push ONLY new meshes into a cached array — O(batch_size) not O(total).
  // A version counter triggers downstream re-renders via the Viewport prop.
  const filteredCacheRef = useRef<MeshData[]>([]);
  const filteredSourceLenRef = useRef(0);
  const filteredSourceRef = useRef<MeshData[] | null>(null);
  const filteredTypeVisRef = useRef(typeVisibility);
  const filteredTypeModeRef = useRef(effectiveViewMode);
  const filteredHasOccRef = useRef(hasOccurrenceGeometry);
  const filteredVersionRef = useRef(0);

  const filteredGeometry = useMemo(() => {
    if (!mergedGeometryResult?.meshes) {
      filteredCacheRef.current = [];
      filteredSourceLenRef.current = 0;
      filteredSourceRef.current = null;
      filteredVersionRef.current = 0;
      return null;
    }

    const allMeshes = mergedGeometryResult.meshes;
    const cache = filteredCacheRef.current;

    // Full rebuild if: type visibility changed, view mode changed, source shrunk
    // (new file), or empty cache
    const prevVis = filteredTypeVisRef.current;
    const typeVisChanged =
      prevVis.spaces !== typeVisibility.spaces ||
      prevVis.spatialZones !== typeVisibility.spatialZones ||
      prevVis.openings !== typeVisibility.openings ||
      prevVis.virtualElements !== typeVisibility.virtualElements ||
      prevVis.site !== typeVisibility.site ||
      prevVis.ifcAnnotations !== typeVisibility.ifcAnnotations ||
      filteredTypeModeRef.current !== effectiveViewMode ||
      // Occurrence-presence flipping (e.g. occurrences stream in after orphan
      // types) changes whether class-1 orphans render in Model view (#1353).
      filteredHasOccRef.current !== hasOccurrenceGeometry;
    const sourceChanged = filteredSourceRef.current !== allMeshes;
    if (typeVisChanged || sourceChanged || allMeshes.length < filteredSourceLenRef.current) {
      cache.length = 0;
      filteredSourceLenRef.current = 0;
      filteredSourceRef.current = allMeshes;
      filteredTypeVisRef.current = typeVisibility;
      filteredTypeModeRef.current = effectiveViewMode;
      filteredHasOccRef.current = hasOccurrenceGeometry;
    }

    const needsFilter = !typeVisibility.spaces || !typeVisibility.spatialZones || !typeVisibility.openings || !typeVisibility.virtualElements || !typeVisibility.site || !typeVisibility.ifcAnnotations;
    const prevCacheLen = cache.length;

    // Only process NEW meshes since last run — O(batch_size) not O(total)
    const scanFrom = filteredSourceLenRef.current;
    for (let i = scanFrom; i < allMeshes.length; i++) {
      const mesh = allMeshes[i];
      const ifcType = mesh.ifcType;

      // Model/Types view switch (#957, #1353). geometryClass: 0 = occurrence,
      // 1 = orphan type, 2 = instanced type-library shape, 3 = material-layer
      // slice (treated like an occurrence — it's part of the real build-up).
      // An orphan type (class 1) renders in Model view ONLY when the model has
      // no placed occurrences (pure type-library file); otherwise it's unplaced
      // library clutter and belongs in the Types view. See helper for the table.
      const geometryClass = mesh.geometryClass ?? 0;
      if (!isMeshVisibleInViewMode(geometryClass, effectiveViewMode, hasOccurrenceGeometry)) {
        continue;
      }

      // Type-visibility gate — shared mapping in `typeVisibilityFilter.ts`
      // keeps the viewport, Cesium, basket and GLB export in lockstep. The
      // `site` toggle also hides `IfcGeographicElement` terrain (issue #1480);
      // `ifcAnnotations` also hides annotation 3D solid geometry / "Model Text"
      // breps on top of the 2D curve overlay (issues #1354, #1480).
      if (needsFilter && !isTypeVisible(ifcType, typeVisibility)) continue;

      // Mesh alpha flows through unchanged. The previous code re-multiplied
      // IfcSpace / IfcOpeningElement alpha down to <= 0.3 here, which stomped
      // lens / Pset colour rules even when the user explicitly chose alpha 1.0.
      // Defaults still come from styling.rs / default-materials.ts; the
      // renderer promotes overridden entities to the opaque pipeline, the
      // only draws its colour table paints (#6076). See issue #677.
      cache.push(mesh);
    }

    perfTally('viewer.filterScan', allMeshes.length - scanFrom, 'meshes');
    filteredSourceLenRef.current = allMeshes.length;

    // Only bump version when cache content actually changed — avoids
    // unnecessary downstream re-renders when memo runs with same data.
    if (cache.length !== prevCacheLen || typeVisChanged || sourceChanged) {
      filteredVersionRef.current++;
    }

    // Return the same array reference — downstream change detection uses
    // geometryVersion (which increments each batch) instead of array identity.
    return cache;
  }, [mergedGeometryResult, typeVisibility, effectiveViewMode, hasOccurrenceGeometry]);

  // Version counter that changes every batch — triggers useGeometryStreaming
  // without requiring a new geometry array reference.
  const geometryVersion = filteredVersionRef.current;

  return { hasTypeGeometry, hasOccurrenceGeometry, filteredGeometry, geometryVersion };
}
