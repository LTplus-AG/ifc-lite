/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimum distance between two picked entities — the geometry half of #2737's
 * second item, "minimum distance between two elements".
 *
 * The hard part already exists: `minDistanceBetweenMeshes` in
 * `@ifc-lite/clash/contact` is an exact branch-and-bound BVH traversal over
 * the same `triTriDistance` predicate clash detection uses, so this is not a
 * second copy of a distance routine (which #2737 explicitly asked us not to
 * write). What was missing is the bridge: the viewer holds `MeshData[]`, and
 * that predicate wants one `Mesh` per entity.
 *
 * Four things make that bridge worth its own tested module rather than a few
 * lines at a call site. The fourth arrived from review after the first three
 * were written, which is why it reads as an afterthought — it is one.
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
 *
 * 4. CORRUPT VERTICES ARE THE VIEWER'S PROBLEM, NOT THE PREDICATE'S. Point (1)
 *    says this mirrors `boundsFromMeshes`; that rule has a second half, which
 *    an earlier draft of this module replicated the arithmetic of and dropped.
 *    `boundsFromMeshes` also discards non-finite and beyond-10 km vertices,
 *    and the ceiling is shared (`NORMAL_COORD_THRESHOLD_M`) precisely because
 *    three files had each grown their own copy of it.
 *
 *    It matters here more than for a bounding box. `minDistanceBetweenBvhs`
 *    starts `best.distance` at `Infinity` and lowers it only on
 *    `r.dist < best.distance`; NaN loses every comparison, so a single NaN
 *    vertex makes the traversal return its own initialiser as though it were
 *    a measurement. The half-metre answer becomes "Infinity m", tagged `ok`.
 *    Both guards below exist for that: reject the geometry going in, and
 *    refuse a non-finite result coming out.
 *
 *    Rejection is per submesh, so an entity can lose part of itself and still
 *    be measurable. That is deliberate — refusing outright would discard
 *    geometry the user can legitimately measure — but it leaves a quieter
 *    version of the same problem: the discarded submesh may have been the
 *    NEARER one, making the reported distance arbitrarily too large while
 *    looking entirely plausible. So the counts are reported (`dropped`)
 *    rather than swallowed. This module cannot force a readout to show them,
 *    but it can refuse to pretend they are zero.
 */

import { minDistanceBetweenMeshes } from '@ifc-lite/clash/contact';
import { NORMAL_COORD_THRESHOLD_M } from '@ifc-lite/geometry';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * The same vertex test `boundsFromMeshes` applies, against the same shared
 * ceiling -- `viewportUtils.ts`'s `isValidCoord` is module-private, so this
 * mirrors it rather than importing it, exactly as `localParsingUtils.ts` and
 * `useGeometryStreaming.ts` already do.
 *
 * Judged in WORLD space, after the origin is added: a real RTC-shifted model
 * carries a large origin and small positions and stays well inside the
 * ceiling, so testing raw positions would pass corrupt data and testing the
 * origin alone would reject good data.
 */
function isUsableWorldCoord(x: number, y: number, z: number): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z) &&
    Math.abs(x) < NORMAL_COORD_THRESHOLD_M &&
    Math.abs(y) < NORMAL_COORD_THRESHOLD_M &&
    Math.abs(z) < NORMAL_COORD_THRESHOLD_M
  );
}

/**
 * Whether every vertex of one submesh survives that test.
 *
 * Rejection is per SUBMESH, never per vertex, and that is forced rather than
 * chosen: `boundsFromMeshes` may skip an individual bad vertex because it only
 * accumulates a bounding box, whereas dropping one vertex here would shift
 * every subsequent index and silently corrupt the rebasing below.
 */
function hasUsableCoords(part: MeshData): boolean {
  const ox = part.origin ? part.origin[0] : 0;
  const oy = part.origin ? part.origin[1] : 0;
  const oz = part.origin ? part.origin[2] : 0;
  for (let i = 0; i < part.positions.length; i += 3) {
    if (
      !isUsableWorldCoord(
        (part.positions[i] as number) + ox,
        (part.positions[i + 1] as number) + oy,
        (part.positions[i + 2] as number) + oz,
      )
    ) {
      return false;
    }
  }
  return true;
}

/** A point in the viewer's render frame, the same frame `MeshData` uses. */
export type MeasurePoint3 = readonly [number, number, number];

/**
 * Why a pair could not be measured. Kept as a reason rather than a bare
 * `null` so the readout can say which entity was the problem.
 */
export type MinDistanceRefusal =
  | {
      readonly kind: 'refused';
      readonly reason: 'no-usable-geometry';
      /** Which of the two picks had no usable geometry, or 'both'. */
      readonly missing: 'a' | 'b' | 'both';
    }
  | {
      /**
       * The traversal returned, but not with a real measurement. Carries no
       * `missing`, because neither pick is the thing at fault -- see the
       * backstop in `minDistanceBetweenEntities` for what this catches.
       */
      readonly kind: 'refused';
      readonly reason: 'non-finite-distance';
    };

export interface MinDistanceOk {
  readonly kind: 'ok';
  /** Metres in the render frame. 0 when the two entities touch or overlap. */
  readonly distance: number;
  readonly pointA: MeasurePoint3;
  readonly pointB: MeasurePoint3;
  /**
   * Submeshes discarded as corrupt before measuring, per side.
   *
   * Either count being non-zero means `distance` is the closest approach of
   * WHAT SURVIVED, not of the whole entity — and it can be arbitrarily larger
   * than the truth, because the discarded submesh may have been the nearer
   * one. Unlike the `Infinity` this module also refuses, that is a plausible
   * number, so nothing about the value itself reveals the problem.
   *
   * Measuring what survives is still the right call — refusing an entity
   * outright because one submesh is bad would throw away geometry the user
   * can legitimately measure. Reporting it silently is not. A readout that
   * ignores this renders a clearance the user may act on.
   */
  readonly dropped: { readonly a: number; readonly b: number };
}

export type MinDistanceResult = MinDistanceOk | MinDistanceRefusal;

/**
 * Collect one entity's submeshes into a single triangle soup in render-frame
 * world coordinates.
 *
 * Returns `null` when the entity contributes no USABLE triangles — it has no
 * submeshes at all, or every one of them is degenerate, or every one of them
 * carries a vertex the viewer already treats as corrupt (see
 * `hasUsableCoords`). All three are the case the caller must not confuse with
 * a distance of zero.
 */
export function meshForEntity(
  meshes: readonly MeshData[],
  entityId: number,
  modelIndex?: number,
): {
  id: string;
  positions: Float64Array;
  indices: Uint32Array;
  /** Submeshes matched but discarded as corrupt. See `MinDistanceOk.dropped`. */
  dropped: number;
} | null {
  const candidates = meshes.filter(
    (m) =>
      m.expressId === entityId &&
      // A federated scene reuses express ids across models, so an id alone is
      // ambiguous. When the caller knows the model, honour it; when it does
      // not, fall back to id-only rather than silently matching nothing.
      (modelIndex === undefined || (m.modelIndex ?? 0) === modelIndex) &&
      m.indices.length >= 3 &&
      m.positions.length >= 9,
  );
  // Split rather than filter in one pass, because the COUNT is reportable:
  // measuring against what survives is right, but doing it silently is not.
  const parts = candidates.filter(hasUsableCoords);
  const dropped = candidates.length - parts.length;
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

  return { id: `${modelIndex ?? 0}:${entityId}`, positions, indices, dropped };
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
    return { kind: 'refused', reason: 'no-usable-geometry', missing };
  }

  const result = minDistanceBetweenMeshes(meshA, meshB);
  // The predicate's own `null` — reachable only for an empty mesh, which the
  // guard above already excludes, but propagated rather than assumed away.
  if (result === null) return { kind: 'refused', reason: 'no-usable-geometry', missing: 'both' };

  // A traversal that never completed a comparison still RETURNS, carrying its
  // `Infinity` initialiser. `minDistanceBetweenBvhs` only overwrites `best` on
  // `r.dist < best.distance`, and every comparison against NaN is false, so a
  // non-finite vertex leaves the sentinel in place — and `kind: 'ok'` would
  // then promise a measurement that was never made. The entry guard above
  // should make this unreachable; it is asserted rather than assumed because
  // the cost of being wrong is a readout saying "Infinity m".
  if (!Number.isFinite(result.distance)) {
    return { kind: 'refused', reason: 'non-finite-distance' };
  }

  return {
    kind: 'ok',
    distance: result.distance,
    pointA: [result.pointA[0], result.pointA[1], result.pointA[2]],
    pointB: [result.pointB[0], result.pointB[1], result.pointB[2]],
    dropped: { a: meshA.dropped, b: meshB.dropped },
  };
}
