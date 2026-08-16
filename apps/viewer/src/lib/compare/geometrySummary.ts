/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "how did it move / reshape" arithmetic shared by the compare detail
 * panel (`describeChange.ts`) and the bulk report writer (`exportReport.ts`).
 *
 * One module, because the two consumers must not disagree: the panel's
 * "moved 40 m" and the CSV's `MovedDistance_m` describe the same entry, and
 * both the box-centre comparison (#1197) and the composed-placement fallback
 * for geometry-less products encode field-measured false-positive lessons that
 * a second copy would eventually drop on one side.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from '../../store/types.js';
import type { CompareRef } from './buildFingerprints.js';
import { composeWorldPlacement } from './worldPlacement.js';

export interface GeometrySummary {
  /** Bounding-box-centre displacement A→B, in model units (metres in the
   *  renderer frame). 0 when below {@link MOVE_EPS} (tessellation/float noise). */
  movedDistance: number;
  delta: { x: number; y: number; z: number };
  /** True when the bounding-box size changed beyond tolerance (not a pure move). */
  reshaped: boolean;
  /** Per-axis bounding-box size change A→B in the display frame (x, y=plan, z=up). */
  sizeDelta: { x: number; y: number; z: number };
}

/** A centre shift below this (renderer metres) is tessellation / float noise,
 *  not a move — keeps a re-cut or re-tessellated element that stayed put from
 *  reading as "moved" (#1197). */
const MOVE_EPS = 2e-3;
/** Per-axis bounding-box size change above this counts as a reshape. */
const RESHAPE_EPS = 1e-3;

/** Axis-aligned bounding box in the renderer world frame. */
export interface Aabb { min: readonly [number, number, number]; max: readonly [number, number, number] }

/** Axis-aligned bounding box of an entity's meshes (renderer world frame). */
export function meshBounds(meshes: readonly MeshData[], globalId: number): Aabb | null {
  let any = false;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    if (mesh.expressId !== globalId) continue;
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      any = true;
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  if (!any) return null;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/**
 * The A→B move of a geometry-less product, read off its composed world
 * placement and converted to metres with each model's own `lengthUnitScale`
 * (the transform is in the file's native length unit — see `worldPlacement.ts`).
 *
 * `null` when either side cannot be composed, which hands the caller back to
 * the box comparison rather than inventing a displacement from an abstention.
 *
 * Both consumers call this on a no-box-on-EITHER-side trigger — but missing
 * boxes are NOT on their own the signature of a geometry-less product. A
 * GPU-instanced entity (#924) carries a real WASM hash while appearing in
 * neither side's flat `geometryResult.meshes`, so its boxes are missing too,
 * and its unchanged placement must not speak for mesh evidence it does not
 * represent (a reshape-in-place would read "moved 0"). `ref.meshed === false`
 * is the recorded fact "the geometry pass produced nothing drawable for this
 * id", so this summary answers only when BOTH sides say so; anything else
 * falls back to the box comparison, whose missing-side answer ("reshaped") is
 * the honest reading for a meshed entity we cannot bound. For the pair this
 * exists for, falling through instead answered "Reshaped" with an empty
 * `MovedDistance_m` — the same false "Reshaped" the field report flagged,
 * from the other direction.
 */
export function placementMoveSummary(
  a: FederatedModel | undefined,
  aRef: CompareRef,
  b: FederatedModel | undefined,
  bRef: CompareRef,
): GeometrySummary | null {
  if (aRef.meshed !== false || bRef.meshed !== false) return null;
  const aStore = a?.ifcDataStore;
  const bStore = b?.ifcDataStore;
  if (!aStore || !bStore) return null;
  const wa = composeWorldPlacement(aStore, aRef.localId);
  const wb = composeWorldPlacement(bStore, bRef.localId);
  if (!wa || !wb) return null;
  // Row-major 4x4: translation at indices 3, 7, 11, in IFC's Z-up frame.
  const dx = wb[3]! * (bStore.lengthUnitScale ?? 1) - wa[3]! * (aStore.lengthUnitScale ?? 1);
  const dy = wb[7]! * (bStore.lengthUnitScale ?? 1) - wa[7]! * (aStore.lengthUnitScale ?? 1);
  const dz = wb[11]! * (bStore.lengthUnitScale ?? 1) - wa[11]! * (aStore.lengthUnitScale ?? 1);
  const rawMoved = Math.hypot(dx, dy, dz);
  const movedDistance = rawMoved < MOVE_EPS ? 0 : rawMoved;
  const zero = { x: 0, y: 0, z: 0 };
  // The panel's frame is (x, y = plan, z = up), which IFC's Z-up axes map to
  // directly — unlike the mesh path, whose boxes arrive in the renderer's
  // Y-up frame and need the swap `summarizeGeometryChange` applies.
  return {
    movedDistance,
    delta: movedDistance === 0 ? zero : { x: dx, y: dy, z: dz },
    // A product with no representation has no extent, so it cannot reshape.
    // Reporting one here is precisely the false positive this function exists
    // to stop; a rotation with no translation reads as an unchanged position,
    // which is a known and deliberate limit of a centre-based summary.
    reshaped: false,
    sizeDelta: zero,
  };
}

/**
 * Classify an A→B bounding-box change as a move and/or reshape. Pure (takes
 * pre-computed AABBs) so a bulk report can pre-index every element's bounds in
 * one pass instead of re-scanning the mesh array per element (#1202).
 */
export function summarizeGeometryChange(ba: Aabb | null, bb: Aabb | null): GeometrySummary | null {
  const zero = { x: 0, y: 0, z: 0 };
  if (!ba || !bb) return { movedDistance: 0, delta: zero, reshaped: true, sizeDelta: zero };

  // Position is the AABB *centre*, not a vertex-weighted centroid: a void re-cut
  // or a different triangulation redistributes mesh vertices and drags a weighted
  // centroid metres away while the element occupies the exact same space — that
  // was the phantom "moved 1.09 m" on a wall that never moved (#1197). The box
  // centre only shifts when the element's spatial extent actually translates.
  const dx = (bb.min[0] + bb.max[0]) / 2 - (ba.min[0] + ba.max[0]) / 2;
  const dy = (bb.min[1] + bb.max[1]) / 2 - (ba.min[1] + ba.max[1]) / 2;
  const dz = (bb.min[2] + bb.max[2]) / 2 - (ba.min[2] + ba.max[2]) / 2;
  const rawMoved = Math.hypot(dx, dy, dz);
  const movedDistance = rawMoved < MOVE_EPS ? 0 : rawMoved;

  // Renderer is Y-up; report deltas in IFC-ish terms (x, y=plan, z=up) by mapping
  // renderer (x, y_up, z) → display (x, z, y_up) so "z" reads as height.
  const delta = movedDistance === 0 ? zero : { x: dx, y: dz, z: dy };

  const sdx = (bb.max[0] - bb.min[0]) - (ba.max[0] - ba.min[0]);
  const sdy = (bb.max[1] - bb.min[1]) - (ba.max[1] - ba.min[1]);
  const sdz = (bb.max[2] - bb.min[2]) - (ba.max[2] - ba.min[2]);
  const reshaped = Math.abs(sdx) > RESHAPE_EPS || Math.abs(sdy) > RESHAPE_EPS || Math.abs(sdz) > RESHAPE_EPS;
  const sizeDelta = reshaped ? { x: sdx, y: sdz, z: sdy } : zero;

  return { movedDistance, delta, reshaped, sizeDelta };
}
