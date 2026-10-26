/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { isEntityVisible, DEFAULT_GHOST_ALPHA, DEFAULT_MIN_CAST_ALPHA } from '@ifc-lite/renderer';
import { getGlobalRenderer } from '../../hooks/useBCF.js';
import { withInstancedMeshes } from '../../utils/instancedExport.js';
import { buildMergedGLB } from './cesium-glb.js';
import { bakeGlobeTiles } from './globe-glb.js';
import type { GeoMapping } from './geo-warp.js';
import { displayedTranslation, type PlacementState } from '../model-placement/state';

/** Locks, anchor picks and no-op previews do not alter the world-view GLB. */
export function cesiumPlacementKey(state: PlacementState): string {
  const ids = new Set([...state.placements.keys(), ...(state.preview?.modelIds ?? [])]);
  return JSON.stringify([...ids].sort().flatMap((id) => {
    const delta = displayedTranslation(state, id);
    return delta.some((value) => value !== 0) ? [[id, delta]] : [];
  }));
}

/** Everything the world-view GLB is a function of. */
export interface CesiumModelGLBInput {
  geometryResult: GeometryResult;
  /** Store counter for in-place mesh mutation (a gizmo move rewrites positions
   *  in the SAME arrays, moving no count). */
  geometryContentVersion: number;
  placementKey?: string;
  /** Hide/isolate exactly as the renderer receives them, in federated global
   *  id space — the same space flat and instanced mesh ids use (#1912). */
  hiddenIds: ReadonlySet<number> | null | undefined;
  isolatedIds: ReadonlySet<number> | null | undefined;
  /** Version from a `VisibilityEpochTracker` fed those two sets. Content-based,
   *  so it survives both in-place mutation of a set and a fresh Set with equal
   *  content — neither of which an identity check would catch. */
  visibilityVersion: number;
  /**
   * X-Ray context: when non-null, everything NOT in this set renders ghosted.
   * The inverse sense of `isolatedIds` — isolation hides the rest, ghosting
   * fades it. `null` means no X-Ray is active.
   */
  ghostExceptIds: ReadonlySet<number> | null | undefined;
  /** Selection is exempt from ghosting, exactly as in the renderer. */
  selectedIds: ReadonlySet<number> | null | undefined;
  /** Version from a tracker fed the ghost set, for the same reason as
   *  `visibilityVersion`. */
  ghostVersion: number;
}

/**
 * Cheap identity for the mesh set {@link buildCesiumModelGLBParts} would build from.
 * O(1): the in-place-mutation counter, the flat mesh count, the scene's
 * instanced-entity census, and the visibility epoch.
 *
 * The overlay caches the built GLB and must not rebuild it on every camera or
 * globe-anchor change, but counts alone are not enough of a key. Manual model
 * placement is part of the GLB; its displayed-position key changes on moves. Three changes
 * slip past them:
 *
 *  - A geometry batch whose occurrences are ALL instanced adds no flat meshes,
 *    so `meshes.length` reports "unchanged" for a batch that changed the model.
 *    The instanced-entity census catches that one.
 *  - An in-place edit (a gizmo move rewrites positions in the SAME arrays)
 *    changes no count at all. `geometryContentVersion` catches that one.
 *  - Hiding or isolating changes which meshes belong in the GLB while every
 *    count above holds still. `visibilityVersion` catches that one.
 */
export function cesiumModelGLBKey(input: CesiumModelGLBInput, globe?: CesiumGlobeBake | null): string {
  const instancedEntities = getGlobalRenderer()?.getScene()?.getInstancedEntityCount() ?? 0;
  const key = [
    input.geometryContentVersion,
    input.placementKey ?? '[]',
    input.geometryResult.meshes.length,
    instancedEntities,
    input.visibilityVersion,
    input.ghostVersion,
  ].join(':');
  // An Exact GLB is baked from the georeference, so a georeference change
  // rebuilds it; an Anchor GLB keeps its key and only its matrix moves.
  return globe ? `${key}:${globe.key}` : key;
}

/**
 * Build the GLB the Cesium world view loads: the COMPLETE model, filtered to
 * what the viewport is actually drawing.
 *
 * Two things this has to get right, both of them bugs that shipped:
 *
 *  - **Completeness (#2558).** `geometryResult.meshes` is only part of the
 *    model. GPU-instanced occurrences render from compact shards and are
 *    deliberately absent from that flat list, as `utils/instancedExport.ts`
 *    documents. Handing it straight to `buildMergedGLB` dropped every repeated
 *    occurrence — 9,950 of 18,555 meshes on the model from #2558, a tower's
 *    whole curtain-wall facade, leaving bare floor slabs on the map.
 *  - **Visibility (#2578).** The world view renders through its own glTF
 *    pipeline, so it does not inherit the renderer's per-frame hide/isolate
 *    filtering. It honoured type visibility (the flat list arrives
 *    pre-filtered) but not hide or isolate, so a hidden element stayed on the
 *    map. Both halves are now filtered with `isEntityVisible`, the same rule
 *    the flat and instanced draw paths answer with.
 *
 * `withInstancedMeshes` gets `null` (no per-model filter) because — unlike the
 * per-model exporters that share it — the world view renders the whole merged
 * federation. Its mesh list already spans every loaded model, the scene only
 * holds templates for models still present (a hidden or removed model's are
 * torn down by `removeInstancedTemplatesForModel`, #2258), and shard entity ids
 * are re-homed onto their owning model's id space at upload (#1912) — every
 * model's instanced occurrences belong in this merged view, not just the
 * primary's (GPU instancing stopped being primary-only on 2026-08-06, #2255).
 */
/** A native Cesium Model has one shadow policy for all its primitives. */
export interface CesiumModelGLBPart {
  glb: Uint8Array;
  castsShadows: boolean;
}

/** An Exact-placement bake: the mapping and the plan key that identifies it. */
export interface CesiumGlobeBake {
  mapping: GeoMapping;
  key: string;
}

/**
 * Split by the same MATERIAL-alpha policy as the WebGPU shadow pass (#7562).
 * Classify before ghost styling: X-Ray must not erase opaque wall shadows.
 * Each canonical visible mesh belongs to exactly one part, including instanced
 * occurrences and federated meshes; opaque window frames stay in the caster.
 */
export function buildCesiumModelGLBParts(input: CesiumModelGLBInput, globe?: CesiumGlobeBake | null): {
  parts: CesiumModelGLBPart[];
  key: string;
} {
  const visible = prepareVisibleMeshes(input);
  const casting: MeshData[] = [];
  const receiving: MeshData[] = [];
  for (const mesh of visible) {
    if (!mesh.positions?.length || !mesh.indices?.length) continue;
    ((mesh.color?.[3] ?? 1) >= DEFAULT_MIN_CAST_ALPHA ? casting : receiving).push(mesh);
  }
  const parts: CesiumModelGLBPart[] = [];
  for (const [meshes, castsShadows] of [[casting, true], [receiving, false]] as const) {
    if (!meshes.length) continue;
    const styled = applyGhostAlpha(meshes, input.ghostExceptIds, input.selectedIds);
    if (!globe) {
      parts.push({ glb: buildMergedGLB(styled), castsShadows });
      continue;
    }
    // Exact placement: one GLB per tile, positions in anchor ENU relative to the tile centre.
    const tiles = bakeGlobeTiles(styled, globe.mapping);
    if (!tiles) throw new Error('globe placement: the model could not be projected point by point');
    for (const tile of tiles) parts.push({ glb: buildMergedGLB(tile.meshes, tile.translation), castsShadows });
  }
  return { parts, key: cesiumModelGLBKey(input, globe) };
}

function prepareVisibleMeshes(input: CesiumModelGLBInput): MeshData[] {
  const complete = withInstancedMeshes(input.geometryResult, null);
  return filterVisibleMeshes(complete.meshes, input.hiddenIds, input.isolatedIds);
}

/**
 * Fade everything outside the X-Ray context set, the way the renderer does.
 *
 * The rule is the renderer's, restated only because the world view builds its
 * own glTF and cannot inherit the render pass: everything not in
 * `ghostExceptIds` drops to `DEFAULT_GHOST_ALPHA` — the constant this imports
 * rather than a second literal — and the current selection is exempt. RGB is
 * untouched; ghosting is an alpha change only.
 *
 * Returns the input untouched when no X-Ray is active, which is the common
 * case, so nothing is copied for nothing.
 *
 * GPU-instanced occurrences ARE ghosted here, and that is a deliberate
 * divergence from the viewport, which does not: `Scene.setInstancedVisibility`
 * takes only the hide and isolate sets, so an instanced facade panel stays
 * solid there while everything around it fades. That is the viewport being
 * wrong rather than the map — the user asked to X-ray everything outside the
 * focus, and a solid facade in front of a ghosted building answers a question
 * nobody asked. Replicating it to stay symmetrical would mean copying a defect.
 * Filed against the renderer separately; when it is fixed the two agree again.
 */
function applyGhostAlpha(
  meshes: readonly MeshData[],
  ghostExceptIds: ReadonlySet<number> | null | undefined,
  selectedIds: ReadonlySet<number> | null | undefined,
): MeshData[] {
  if (ghostExceptIds == null) return meshes as MeshData[];
  return meshes.map((m) => {
    if (ghostExceptIds.has(m.expressId) || selectedIds?.has(m.expressId)) return m;
    const [r, g, b] = m.color ?? [0.7, 0.7, 0.7, 1];
    return { ...m, color: [r, g, b, DEFAULT_GHOST_ALPHA] as [number, number, number, number] };
  });
}

/** No-op (and no copy) when neither filter is active — the common case. */
function filterVisibleMeshes(
  meshes: readonly MeshData[],
  hiddenIds: ReadonlySet<number> | null | undefined,
  isolatedIds: ReadonlySet<number> | null | undefined,
): MeshData[] {
  const hiding = hiddenIds != null && hiddenIds.size > 0;
  const isolating = isolatedIds != null;
  if (!hiding && !isolating) return meshes as MeshData[];
  return meshes.filter((m) => isEntityVisible(m.expressId, hiddenIds, isolatedIds));
}
