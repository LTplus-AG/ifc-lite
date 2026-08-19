/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Gather everything the to-scale 3D-view PDF export needs from the live viewer
 * — store state, renderer camera, viewport canvas — in one place (#2042).
 *
 * DEFECT CLASS — an export that draws a different model from the screen. Two
 * ways that happens, and both are folded here rather than at the call site:
 *
 *  1. **The instanced half goes missing** (#2558). GPU-instanced occurrences
 *     never appear in `geometryResult.meshes`; the Cesium world view read that
 *     list straight and silently dropped a tower's whole curtain wall. Every
 *     model's meshes therefore go through `withInstancedMeshes`, the one
 *     sanctioned materializer, BEFORE anything filters them.
 *  2. **Only half the isolation is applied.** Storey selection and the class
 *     filter live in `ViewportContainer`'s `computedIsolatedIds` memo, which is
 *     prop-drilled down the viewport tree and cannot be reached from a toolbar
 *     dialog. Reading the store's `isolatedEntities` alone would print every
 *     storey while the screen shows one, so this resolves the full allowlist
 *     through `computeIsolationFilterSet` — the shared derivation, not a
 *     restatement of it.
 *
 * The camera is read once, imperatively, at the moment this is called: it is
 * not store state, so nothing re-renders when the user orbits. Callers refresh
 * it when the dialog opens and whenever a store input changes; a camera moved
 * WHILE the dialog is open is not reflected until then, which is the same
 * contract every other snapshot-style export in the viewer has.
 */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { getGlobalCanvas, getGlobalRenderer } from '@/hooks/useBCF';
import { selectModelMeshes } from '@/lib/type-view-visibility';
import { computeIsolationFilterSet } from '@/store/basketVisibleSet';
import { withInstancedMeshes, type InstancedModelRange } from '@/utils/instancedExport';
import type { useViewerStore } from '@/store';
import type { ViewMeshInput } from './collect-view-meshes';
import type { ViewCameraSnapshot } from './generate-view-pdf';
import type { ViewSectionResolveInput } from './view-section-plane';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

export interface ViewPdfSource {
  /** Mesh set + every visibility channel, ready for `collectViewMeshes`. */
  view: ViewMeshInput;
  /** `null` when no renderer camera exists yet (nothing loaded / no WebGPU). */
  camera: ViewCameraSnapshot | null;
  /** `null` when no section cut is active, or when its bounds are unknown. */
  section: ViewSectionResolveInput | null;
  /** True when the user HAS a cut enabled, even if `section` could not resolve. */
  sectionEnabled: boolean;
  /** Viewport height in CSS pixels, for the "as displayed" scale. `null` when unknown. */
  canvasCssHeightPx: number | null;
}

/** Read the current viewport state into one plain, testable bundle. */
export function readViewPdfSource(state: ViewerState): ViewPdfSource {
  const meshes = gatherDrawnMeshes(state);
  const camera = readCameraSnapshot();
  const canvas = getGlobalCanvas();

  return {
    view: {
      meshes,
      // `withInstancedMeshes` has ALREADY folded the instanced occurrences into
      // the list above. Handing them over a second time here would draw every
      // instanced element twice, so this is empty BY CONSTRUCTION, not by
      // omission — the #2558 guard is satisfied upstream in `gatherDrawnMeshes`.
      instancedMeshes: [],
      hiddenEntities: state.hiddenEntities,
      isolatedEntities: state.isolatedEntities,
      computedIsolatedIds: computeIsolationFilterSet(state),
      typeVisibility: state.typeVisibility,
      // Invisible models contribute no meshes at all (they are dropped in
      // `gatherDrawnMeshes`, mirroring `mergedGeometryResult`), so there is no
      // per-index gate left to apply.
      modelVisibility: null,
    },
    camera,
    section: resolveSectionInput(state),
    sectionEnabled: state.sectionPlane.enabled,
    canvasCssHeightPx: canvas ? canvas.clientHeight : null,
  };
}

/**
 * Every visible model's real-building geometry, instanced occurrences included,
 * in federated global-id space.
 *
 * `selectModelMeshes` drops type-library geometry for the same reason the 2D
 * drawing pipeline does: a printed drawing draws the building, never the type
 * library (#2058).
 */
function gatherDrawnMeshes(state: ViewerState): MeshData[] {
  const results: { geometry: GeometryResult; instancedModelRange: InstancedModelRange | null }[] = [];

  if (state.models.size > 0) {
    for (const model of state.models.values()) {
      if (!model.visible || !model.geometryResult) continue;
      // Every model can carry GPU-instanced occurrences since #2255
      // (2026-08-06) — scope `withInstancedMeshes` to THIS model's bracket so
      // a federation of N models doesn't splice every other model's instanced
      // entities into this one's drawn set (#2865/#2878 follow-up).
      results.push({
        geometry: model.geometryResult,
        instancedModelRange: { idOffset: model.idOffset ?? 0, maxExpressId: model.maxExpressId ?? 0 },
      });
    }
  } else if (state.geometryResult) {
    // The legacy single-model slot is provably the sole model loaded — nothing
    // else to wrongly include, so `null` (no filter) is correct.
    results.push({ geometry: state.geometryResult, instancedModelRange: null });
  }

  const meshes: MeshData[] = [];
  for (const { geometry, instancedModelRange } of results) {
    // Appended one at a time, NOT `push(...meshes)`: the argument count would
    // be one model's whole mesh list, which on a large federated model can
    // exceed the engine's maximum argument count and throw a RangeError. Same
    // failure mode as `clipMeshesToHalfSpace` in packages/drawing-2d.
    for (const mesh of selectModelMeshes(withInstancedMeshes(geometry, instancedModelRange).meshes)) {
      meshes.push(mesh);
    }
  }
  return meshes;
}

/** The live camera pose + projection, or `null` when there is no renderer. */
function readCameraSnapshot(): ViewCameraSnapshot | null {
  const camera = getGlobalRenderer()?.getCamera();
  if (!camera) return null;
  return {
    position: camera.getPosition(),
    target: camera.getTarget(),
    up: camera.getUp(),
    projectionMode: camera.getProjectionMode(),
  };
}

/** `Camera.getOrthoSize()` / `getDistance()` / `getFOV()`, for the displayed scale. */
export interface ViewZoomSnapshot {
  orthoSize: number;
  distance: number;
  fovRadians: number;
}

export function readViewZoom(): ViewZoomSnapshot | null {
  const camera = getGlobalRenderer()?.getCamera();
  if (!camera) return null;
  return {
    orthoSize: camera.getOrthoSize(),
    distance: camera.getDistance(),
    fovRadians: camera.getFOV(),
  };
}

/**
 * The cut to apply, in the terms `resolveKeptHalfSpace` needs.
 *
 * Returns `null` when the user has no cut enabled, or when the renderer has no
 * scene bounds yet — the percentage is meaningless without the range it is a
 * percentage OF, and inventing one would place the cut somewhere the screen
 * never shows.
 */
function resolveSectionInput(state: ViewerState): ViewSectionResolveInput | null {
  const sectionPlane = state.sectionPlane;
  if (!sectionPlane.enabled) return null;

  const sceneBounds = getGlobalRenderer()?.getCamera()?.getSceneBounds() ?? null;
  if (!sceneBounds) return null;

  const coordinateInfo = visibleCoordinateInfo(state);
  const axisKey = sectionPlane.axis === 'side' ? 'x' : sectionPlane.axis === 'down' ? 'y' : 'z';
  const shifted = coordinateInfo?.shiftedBounds;
  const uiRange = shifted
    ? { min: shifted.min[axisKey], max: shifted.max[axisKey] }
    : null;

  return {
    plane: {
      axis: sectionPlane.axis,
      position: sectionPlane.position,
      flipped: sectionPlane.flipped,
      custom: sectionPlane.custom
        ? { normal: sectionPlane.custom.normal, distance: sectionPlane.custom.distance }
        : undefined,
    },
    sceneBounds,
    buildingRotation: coordinateInfo?.buildingRotation,
    uiRange,
  };
}

/**
 * Coordinate info for the section percentage, with `shiftedBounds` UNIONED
 * across every visible model.
 *
 * The first visible model's own bounds are not enough. `ViewportContainer`
 * hands the renderer the union of all visible models' `shiftedBounds`, so the
 * on-screen cut resolves its percentage against that union. Reading only the
 * first model here makes the same 50% land somewhere else entirely on a
 * federated view: with a small model loaded first, 50% could resolve to x=5 in
 * the PDF while the screen resolves it to x=55. The cut has to be derived from
 * the same range the viewport used, or the sheet is not the view.
 *
 * Non-bounds fields (notably `buildingRotation`) stay with the first visible
 * model, matching `ViewportContainer`'s own base-plus-unioned-bounds shape.
 */
function visibleCoordinateInfo(state: ViewerState): GeometryResult['coordinateInfo'] | null {
  let base: GeometryResult['coordinateInfo'] | null = null;
  let unioned: Bounds3D | null = null;

  for (const model of state.models.values()) {
    if (!model.visible || !model.geometryResult) continue;
    const info = model.geometryResult.coordinateInfo;
    base ??= info;
    unioned = unionBounds3D(unioned, info?.shiftedBounds);
  }
  if (!base) return state.geometryResult?.coordinateInfo ?? null;
  return unioned ? { ...base, shiftedBounds: unioned } : base;
}

interface Bounds3D {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** Axis-aligned union, skipping absent or non-finite boxes. */
function unionBounds3D(acc: Bounds3D | null, b: Bounds3D | undefined): Bounds3D | null {
  if (!b) return acc;
  const finite = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);
  if (!finite) return acc;
  if (!acc) return { min: { ...b.min }, max: { ...b.max } };
  return {
    min: {
      x: Math.min(acc.min.x, b.min.x),
      y: Math.min(acc.min.y, b.min.y),
      z: Math.min(acc.min.z, b.min.z),
    },
    max: {
      x: Math.max(acc.max.x, b.max.x),
      y: Math.max(acc.max.y, b.max.y),
      z: Math.max(acc.max.z, b.max.z),
    },
  };
}
