/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a pick resolves to, and how a decoded pick sample becomes one.
 *
 * Split out of `picker.ts` so this half is reachable without a GPU: everything
 * around it (render the pick pass, read back a texel, unproject the depth)
 * needs a device, while deciding WHICH entity — and since #2985 which
 * representation item — a sample landed on is pure table lookup.
 *
 * Every import here is type-only, so nothing is emitted and the `PickResult`
 * re-export in `types.ts` is not a runtime cycle.
 */

import type { MeshData } from '@ifc-lite/geometry';

import type { DecodedPickSample, PointPickNode } from './point-picker.js';
import type { Mesh } from './types.js';

/**
 * Result from GPU picking
 * For multi-model support, includes both expressId and modelIndex
 */
export interface PickResult {
  expressId: number;
  modelIndex?: number;  // Index of the model this entity belongs to
  /**
   * World-space XYZ of the picked surface point. Optional because the
   * pick path can skip depth readback for callers that only need the
   * entityId (e.g. selection state). Recovered by sampling the pick
   * pass's depth texture at the click position and unprojecting.
   */
  worldXYZ?: { x: number; y: number; z: number };
  /**
   * The `IfcRepresentationItem` the picked surface was built from (#2985), so
   * a host can drill from a clicked pane or frame down to its own entity
   * instead of stopping at the owning product. Same name and same value as
   * `MeshData.geometryItemId`; it is NEVER a material id — `materialId` carries
   * that case upstream and the two are never both set (#3199).
   *
   * The KEY IS ABSENT, never 0, wherever the renderer has no item identity to
   * report, and those absences do not all mean the same thing:
   *   - the single merged-mesh fallback and a cached `IfcMappedItem` genuinely
   *     have none, mirroring `MeshData.geometryItemId` itself;
   *   - a colour-merged batch holds many entities, so whatever item id it
   *     carries belongs to none of them individually and is not reported;
   *   - a GPU-instanced occurrence has none on the GPU route ONLY. The
   *     instanced pick shader writes the express id straight into the sample,
   *     with no per-instance item channel to look one up from. The CPU raycast
   *     never runs that shader, and since #2985 carried the id onto instanced
   *     occurrences it DOES report one: `Scene.getInstancedMeshDataPieces`
   *     stamps `geometryItemId` on each synthetic `MeshData` it materialises.
   *     So the two routes disagree here, and only the shader half is open.
   * Rectangle/marquee pick returns bare express ids and never builds a
   * `PickResult` at all, so it cannot report this either.
   */
  geometryItemId?: number;
}

/**
 * The representation item a piece of geometry may report on a pick, or
 * `undefined` when it may not (#2985).
 *
 * A piece carrying per-vertex `entityIds` is registered under every entity it
 * names (`Scene.addMeshData`), so where it genuinely holds more than
 * `expressId` its item id describes none of them individually and is withheld.
 *
 * Carrying `entityIds` is NOT by itself evidence of that, which is why this
 * scans for a FOREIGN id rather than testing the field's presence: an authored
 * single-entity mesh (a slab/space/wall added in-session) tags every vertex
 * with its own id for picking, so all-same-id attributes unambiguously and is
 * reported. `Scene.translateFlatMeshesForEntity` draws the same line the same
 * way, and got there the hard way — a "skip on any entityIds at all" test there
 * froze authored elements under the gizmo. The two must agree about what a
 * shared piece is.
 *
 * Latent, not live: no in-tree producer sets `MeshData.entityIds` at all today
 * (`packages/`, `apps/`, and the Rust crates were all checked), so only
 * hand-built fixtures reach the scan. It is written to match the sibling rule,
 * not to fix an observed misattribution.
 *
 * ONE home, because the two pick routes reach that rule from different sides
 * and must not answer one click two ways:
 *   - CPU (`raycastTriangles`, every model over `MAX_PICK_MESH_CREATION`) walks
 *     `Scene.meshDataMap` DIRECTLY, so it sees raw merged pieces and the rule
 *     is what stops it attributing a batch's id to one entity;
 *   - GPU (`Renderer.createMeshFromData`) is fed by `Scene.getMeshDataPieces`,
 *     which splits a merged piece per entity first — and its rebuilt literal
 *     happens to carry neither `entityIds` nor `geometryItemId` forward, so
 *     today it strips the id as a SIDE EFFECT rather than by any stated rule.
 *     `createMeshFromData` is public and applies the rule itself instead of
 *     inheriting that accident.
 *
 * @param expressId - the entity the pick is about to attribute the piece to.
 *   Not `piece.expressId`: a merged piece is looked up under every id it names,
 *   so the raycaster's map key is the one that decides, not the piece's own.
 */
export function reportableItemId(
  piece: Pick<MeshData, 'entityIds' | 'geometryItemId'>,
  expressId: number,
): number | undefined {
  const ids = piece.entityIds;
  if (ids) {
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== expressId) return undefined;
    }
  }
  return piece.geometryItemId;
}

/**
 * The mesh a mesh-kind sample landed on, or `undefined` when the index is out
 * of range. The pick shader writes (actual index + 1), and THIS is the only
 * place that offset is spelled out.
 */
function meshForSample(decoded: DecodedPickSample, meshes: readonly Mesh[]): Mesh | undefined {
  return meshes[decoded.meshIndexPlusOne - 1];
}

/**
 * Which entity a decoded sample landed on, or `null` when it landed on nothing.
 *
 * The sample taxonomy lives here — the three ways a texel can name an entity,
 * and the mesh case's (index + 1) offset via {@link meshForSample} — so single
 * click and marquee cannot answer one texel two ways.
 *
 * Separate from {@link resolvePickSample} because a `PickResult` is the wrong
 * unit for a marquee: `Picker.pickRect` wants nothing but the id, once per
 * non-zero texel. Routing it through a full result allocated one object per
 * texel to read `.expressId` off and drop — millions of them on a
 * full-viewport rect over a HiDPI canvas, and the resulting GC dominated the
 * whole rect. Keep the dispatch shared and the allocation out of the loop.
 */
export function resolvePickedExpressId(
  decoded: DecodedPickSample,
  meshes: readonly Mesh[],
): number | null {
  if (decoded.kind === 'none') return null;
  // The point and instanced shaders write the express id straight into the
  // sample (federated globalId for points), so there is no table to look up.
  if (decoded.kind === 'point') return decoded.pointExpressId;
  if (decoded.kind === 'instanced') return decoded.instanceExpressId;
  return meshForSample(decoded, meshes)?.expressId ?? null;
}

/**
 * Map one decoded pick sample onto the entity behind it, with everything a
 * single click reports about it.
 *
 * `worldXYZ` is the already-unprojected hit position (null when the depth
 * readback found nothing to unproject); `meshes` is the same array, in the same
 * order, that the pick pass drew, because a mesh sample is an index into it.
 */
export function resolvePickSample(
  decoded: DecodedPickSample,
  meshes: readonly Mesh[],
  pointNodes: ReadonlyArray<PointPickNode> | undefined,
  worldXYZ: { x: number; y: number; z: number } | null,
): PickResult | null {
  const expressId = resolvePickedExpressId(decoded, meshes);
  if (expressId === null) return null;
  const world = worldXYZ ?? undefined;

  if (decoded.kind === 'point') {
    // Look up the asset for modelIndex — the only thing the id alone can't say.
    const node = pointNodes?.find((n) => (n.expressId >>> 0) === expressId);
    return { expressId, modelIndex: node?.modelIndex, worldXYZ: world };
  }

  if (decoded.kind === 'instanced') {
    // Instanced occurrence. modelIndex is not tracked per occurrence yet
    // (single-model instancing), and neither is geometryItemId: this shader
    // has no per-occurrence item channel to read one out of. Note the CPU
    // raycast route DOES report it for the same geometry, because
    // Scene.getInstancedMeshDataPieces stamps it onto the pieces it
    // materialises (#2985). This is the remaining half of that gap.
    return { expressId, modelIndex: undefined, worldXYZ: world };
  }

  // Mesh hit. The id above already came off this entry (and range-checked it);
  // re-reading it is what reaches the rest of the identity a bare id can't hold.
  const mesh = meshForSample(decoded, meshes);
  if (!mesh) return null;
  return {
    expressId,
    modelIndex: mesh.modelIndex,
    worldXYZ: world,
    // Spread, not `geometryItemId: mesh.geometryItemId`: a mesh with no item
    // identity must leave the key OFF, so a caller can tell "no item here" from
    // "an item whose id is 0" and from a pick that never ran.
    ...(mesh.geometryItemId !== undefined ? { geometryItemId: mesh.geometryItemId } : {}),
  };
}
