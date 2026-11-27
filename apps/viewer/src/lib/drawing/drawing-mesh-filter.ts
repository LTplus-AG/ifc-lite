/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which meshes a 2D drawing cuts, as ONE per-mesh predicate over metadata
 * only (express id, class, IFC type), so the same answer holds for a resident
 * mesh, a CPU-released one and its backed read-back copy (#10264).
 */

import type { MeshData } from '@ifc-lite/geometry';
import { modelMeshGate } from '@/lib/type-view-visibility';
import { isMeshTypeVisible, type RetypedClasses, type TypeVisibilityGate } from '@/store/typeVisibilityFilter';
import type { StructuralViewMode } from '@/store/types';

/** The mesh fields a drawing filter may read. */
export type DrawingMeshMeta = Pick<MeshData, 'expressId' | 'ifcType' | 'geometryClass'>;
export type DrawingMeshFilter = (mesh: DrawingMeshMeta) => boolean;

export interface DrawingMeshFilterInput {
  /** The whole flat list, for the type-library gate's "has placed geometry" test. */
  meshes: readonly DrawingMeshMeta[];
  typeVisibility: TypeVisibilityGate;
  structuralViewMode: StructuralViewMode;
  retypedClasses: RetypedClasses | undefined;
  hiddenIds: ReadonlySet<number>;
  isolatedIds: ReadonlySet<number> | null;
  computedIsolatedIds: ReadonlySet<number> | null | undefined;
}

export function drawingMeshFilter(input: DrawingMeshFilterInput): DrawingMeshFilter {
  const { typeVisibility, structuralViewMode, retypedClasses, hiddenIds, isolatedIds, computedIsolatedIds } = input;
  // Type-library geometry (issue #2058): `geometryResult.meshes` holds the
  // whole scene, including the `IfcTypeProduct` RepresentationMap copies the
  // wasm mesh pass emits (class 1 orphan type, 2 instanced type). The Model
  // view never shows them, so neither does the drawing.
  const modelMesh = modelMeshGate(input.meshes);
  return (mesh) => modelMesh(mesh)
    // Class-level Visibility toggles (issue #2060) are a GLOBAL filter, not a
    // 3D-only one: a hidden IfcSpace / IfcOpeningElement is not cut either, in
    // the 2D view and in the 3D section overlay. Same shared mapping as the
    // viewport, basket and GLB export, retypes included (#10119).
    && isMeshTypeVisible(mesh, typeVisibility, structuralViewMode, retypedClasses)
    // Hidden entities and isolation hold global ids, so they cover every federated model.
    && !hiddenIds.has(mesh.expressId)
    && (isolatedIds === null || isolatedIds.has(mesh.expressId))
    // Storey selection. Meaningfully nullable, same convention as
    // `packages/renderer/src/entity-visibility.ts`'s `isEntityVisible`:
    // null/undefined means no isolation channel is active, while a non-null
    // Set — EMPTY included — is active and matches nothing (#4509).
    && (computedIsolatedIds == null || computedIsolatedIds.has(mesh.expressId));
}
