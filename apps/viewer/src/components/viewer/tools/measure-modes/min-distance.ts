/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimum distance between two picked entities — the geometry half of #2737's
 * third item.
 *
 * The hard part already exists: `minDistanceBetweenMeshes` in
 * `@ifc-lite/clash/contact` is an exact branch-and-bound BVH traversal over
 * the same `triTriDistance` predicate clash detection uses, so this is not a
 * second copy of a distance routine (which #2737 explicitly asked us not to
 * write). What was missing is the bridge: the viewer holds `MeshData[]`, and
 * that predicate wants one `Mesh` per entity.
 *
 * Three things make that bridge worth its own tested module rather than a few
 * lines at a call site.
 *
 * 1. AN ENTITY IS USUALLY SEVERAL SUBMESHES, each with its own `origin`. The
 *    world position of a vertex is `origin + position` (per-element local
 *    frame, absent meaning absolute) — the same rule `boundsFromMeshes` in
 *    `utils/viewportUtils.ts` applies. Concatenating submeshes therefore means
 *    adding EACH submesh's own origin, not one origin for the entity, and
 *    rebasing each submesh's indices by the running vertex count. Get any of
 *    those three steps wrong and the answer is silently plausible.
 *
 *    That failure mode is not hypothetical here: `measure-modes/radius.ts`
 *    carries a note about an order-dependent plane that turned a 2 m arc into
 *    a 2.8 km one. Same family of bug, same file neighbourhood.
 *
 * 2. NO AXIS CONVERSION, DELIBERATELY. `Mesh` in `@ifc-lite/clash/contact` is
 *    documented as "world coordinates (Z-up, matching IFC)", and the viewer's
 *    frame is Y-up. This module feeds render-frame vertices in ANYWAY, and
 *    that is correct rather than sloppy: Euclidean distance is invariant under
 *    the Y-up/Z-up relabeling, which is a rotation — it changes no length. The
 *    witness points then come back already in the frame the readout displays,
 *    so there is no conversion hop on the way out either.
 *
 *    Converting to IFC axes and back would be two extra transforms whose only
 *    effect is to cancel, and every transform hop is somewhere the bug in (1)
 *    can hide. The deviation from the type's stated contract is intentional
 *    and is why it is written down here.
 *
 * 3. `null` IS NOT ZERO. The predicate returns `null` when either mesh has no
 *    triangles, "deliberately distinct from returning 0, which would read as
 *    'they touch'". A UI that renders `dist ?? 0` turns "I could not measure
 *    this" into "these are touching", which is worse than showing nothing.
 *    The result type below makes that unrepresentable rather than merely
 *    discouraged.
 */

import { minDistanceBetweenMeshes } from '@ifc-lite/clash/contact';
import type { MeshData } from '@ifc-lite/geometry';

/** A point in the viewer's render frame, the same frame `MeshData` uses. */
export type MeasurePoint3 = readonly [number, number, number];

/**
 * Why a pair could not be measured. Kept as a reason rather than a bare
 * `null` so the readout can say which entity was the problem.
 */
export interface MinDistanceRefusal {
  readonly kind: 'refused';
  /** Which of the two picks had no usable geometry, or 'both'. */
  readonly missing: 'a' | 'b' | 'both';
}

export interface MinDistanceOk {
  readonly kind: 'ok';
  /** Metres in the render frame. 0 when the two entities touch or overlap. */
  readonly distance: number;
  readonly pointA: MeasurePoint3;
  readonly pointB: MeasurePoint3;
}

export type MinDistanceResult = MinDistanceOk | MinDistanceRefusal;

/**
 * Collect one entity's submeshes into a single triangle soup in render-frame
 * world coordinates.
 *
 * Returns `null` when the entity contributes no triangles — either it has no
 * submeshes at all, or every one of them is degenerate. That is the case the
 * caller must not confuse with a distance of zero.
 */
export function meshForEntity(
  meshes: readonly MeshData[],
  entityId: number,
  modelIndex?: number,
): { id: string; positions: Float64Array; indices: Uint32Array } | null {
  const parts = meshes.filter(
    (m) =>
      m.expressId === entityId &&
      // A federated scene reuses express ids across models, so an id alone is
      // ambiguous. When the caller knows the model, honour it; when it does
      // not, fall back to id-only rather than silently matching nothing.
      (modelIndex === undefined || (m.modelIndex ?? 0) === modelIndex) &&
      m.indices.length >= 3 &&
      m.positions.length >= 9,
  );
  if (parts.length === 0) return null;

  let vertexCount = 0;
  let indexCount = 0;
  for (const p of parts) {
    vertexCount += p.positions.length / 3;
    indexCount += p.indices.length;
  }

  const positions = new Float64Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);

  let vBase = 0; // vertices written so far, i.e. the rebase offset
  let pOut = 0;
  let iOut = 0;
  for (const part of parts) {
    // world = origin + position. Each submesh carries its OWN origin; using
    // the first submesh's origin for all of them displaces every later part.
    const ox = part.origin ? part.origin[0] : 0;
    const oy = part.origin ? part.origin[1] : 0;
    const oz = part.origin ? part.origin[2] : 0;

    for (let i = 0; i < part.positions.length; i += 3) {
      positions[pOut] = (part.positions[i] as number) + ox;
      positions[pOut + 1] = (part.positions[i + 1] as number) + oy;
      positions[pOut + 2] = (part.positions[i + 2] as number) + oz;
      pOut += 3;
    }
    for (let i = 0; i < part.indices.length; i++) {
      indices[iOut++] = (part.indices[i] as number) + vBase;
    }
    vBase += part.positions.length / 3;
  }

  return { id: `${modelIndex ?? 0}:${entityId}`, positions, indices };
}

/**
 * Closest approach between two picked entities.
 *
 * Both entities are resolved from the same `MeshData[]` the viewer already
 * holds, so no re-meshing happens. The witness points come back in the render
 * frame, ready for `pointCoordinates` without further transformation.
 */
export function minDistanceBetweenEntities(
  meshes: readonly MeshData[],
  a: { entityId: number; modelIndex?: number },
  b: { entityId: number; modelIndex?: number },
): MinDistanceResult {
  const meshA = meshForEntity(meshes, a.entityId, a.modelIndex);
  const meshB = meshForEntity(meshes, b.entityId, b.modelIndex);

  if (meshA === null || meshB === null) {
    const missing = meshA === null && meshB === null ? 'both' : meshA === null ? 'a' : 'b';
    return { kind: 'refused', missing };
  }

  const result = minDistanceBetweenMeshes(meshA, meshB);
  // The predicate's own `null` — reachable only for an empty mesh, which the
  // guard above already excludes, but propagated rather than assumed away.
  if (result === null) return { kind: 'refused', missing: 'both' };

  return {
    kind: 'ok',
    distance: result.distance,
    pointA: [result.pointA[0], result.pointA[1], result.pointA[2]],
    pointB: [result.pointB[0], result.pointB[1], result.pointB[2]],
  };
}
