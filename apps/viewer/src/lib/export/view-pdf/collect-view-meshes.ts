/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The mesh set the viewport is ACTUALLY drawing right now — the input to the
 * to-scale 3D-view PDF export (#2042).
 *
 * DEFECT CLASS 1 — half a model (#2558, fixed by #2576). `geometryResult.meshes`
 * is only the flat half of the scene: GPU-instanced occurrences render from
 * compact shards and are deliberately ABSENT from that list (see
 * `utils/instancedExport.ts`). The Cesium world view read it straight and
 * dropped 9,950 of 18,555 meshes — a tower's whole curtain-wall facade — while
 * looking like a successful export. So this function does not accept "the
 * meshes" as one list it might quietly under-fill: `instancedMeshes` is a
 * REQUIRED field, materialized by the caller through
 * `withInstancedMeshes(geometryResult, instancedModelRange)`, and it is appended before
 * any filtering so the instanced half answers every visibility channel the
 * flat half does.
 *
 * DEFECT CLASS 2 — a partial visibility fold. "What the user sees" is five
 * independent channels, and a consumer that folds four of them prints elements
 * the screen does not show:
 *   1. `hiddenEntities`   (blocklist)            — via `isEntityVisible`
 *   2. `isolatedEntities` (allowlist, nullable)  — via `isEntityVisible`
 *   3. `computedIsolatedIds` (storey/class isolation, wins over 2) — via
 *      `effectiveIsolatedIds`, the same resolution the viewport and the Cesium
 *      overlay use (#2578)
 *   4. `typeVisibility`   (IfcSpace / openings / site / … class toggles, #2060)
 *      — via the shared `isTypeVisible` mapping
 *   5. per-model `visible` (federation) — a hidden federated model contributes
 *      no meshes at all
 * Each channel is imported from its single source of truth rather than
 * restated here, which is exactly how the world view came to disagree with the
 * viewport in the first place.
 *
 * Not folded here, deliberately: the Model/Types view switch. Callers pass a
 * mesh list already narrowed by `selectModelMeshes` (the same thing the 2D
 * drawing pipeline does), because a printed drawing always draws the building,
 * never the type library.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { isEntityVisible } from '@ifc-lite/renderer';
import { effectiveIsolatedIds } from '@/lib/effective-isolation';
import { isTypeVisible, type TypeVisibilityGate } from '@/store/typeVisibilityFilter';

/** Everything the drawn mesh set is a function of. Plain data: no store reads,
 *  no renderer reads — the caller resolves those so this stays testable. */
export interface ViewMeshInput {
  /** Flat meshes, in federated global id space (`geometryResult.meshes`, after
   *  `selectModelMeshes`). */
  meshes: readonly MeshData[];
  /**
   * GPU-instanced occurrences, materialized by the caller from the live
   * renderer scene via `withInstancedMeshes(geometryResult, instancedModelRange)`.
   *
   * Required, not optional, and not defaulted: an omitted-by-accident
   * instanced half is precisely the #2558 defect, and a required field turns
   * that omission into a compile error instead of a half-empty PDF. Pass `[]`
   * only when there genuinely are none.
   */
  instancedMeshes: readonly MeshData[];
  /** Store `hiddenEntities`, in global id space. */
  hiddenEntities: ReadonlySet<number> | null | undefined;
  /** Store `isolatedEntities`, in global id space. */
  isolatedEntities: ReadonlySet<number> | null | undefined;
  /** `ViewportContainer`'s computed isolation (storey + class + store). */
  computedIsolatedIds: ReadonlySet<number> | null | undefined;
  /** The class-level toggles (`typeVisibility`). */
  typeVisibility: TypeVisibilityGate;
  /**
   * Per-model visibility keyed by `MeshData.modelIndex`. An index that is
   * ABSENT from the map counts as visible, so the single-model path can pass
   * an empty map; only an explicit `false` hides a model.
   */
  modelVisibility: ReadonlyMap<number, boolean> | null | undefined;
}

/**
 * Fold every visibility channel over the complete (flat + instanced) mesh set.
 *
 * Order matters in one respect only: the instanced half is appended BEFORE the
 * filters, so hiding an instanced occurrence hides it in the PDF too.
 *
 * Instanced shard meshes carry no `ifcType` (the renderer's scene does not keep
 * one), so the class toggles cannot gate them — the same limitation the
 * viewport has, where `Scene.setInstancedVisibility` takes only the hide and
 * isolate sets. `isTypeVisible` treats a missing type as visible, matching it.
 */
export function collectViewMeshes(input: ViewMeshInput): MeshData[] {
  const isolatedIds = effectiveIsolatedIds(input.computedIsolatedIds, input.isolatedEntities);
  const complete: readonly MeshData[] =
    input.instancedMeshes.length === 0
      ? input.meshes
      : [...input.meshes, ...input.instancedMeshes];

  return complete.filter(
    (mesh) =>
      isModelVisible(mesh.modelIndex, input.modelVisibility) &&
      isTypeVisible(mesh.ifcType, input.typeVisibility) &&
      isEntityVisible(mesh.expressId, input.hiddenEntities, isolatedIds),
  );
}

/**
 * A mesh with no `modelIndex` belongs to the primary model (index 0) — that is
 * the convention the merged federation list stamps and the legacy single-model
 * path leaves unset. Instanced shards are primary-model only (#1912), so they
 * ride the same rule.
 */
function isModelVisible(
  modelIndex: number | undefined,
  modelVisibility: ReadonlyMap<number, boolean> | null | undefined,
): boolean {
  if (modelVisibility == null) return true;
  return modelVisibility.get(modelIndex ?? 0) !== false;
}
