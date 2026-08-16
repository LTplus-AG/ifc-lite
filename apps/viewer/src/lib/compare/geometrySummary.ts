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

import type { CoordinateInfo, MeshData } from '@ifc-lite/geometry';
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

/**
 * Axis-aligned bounding box in the renderer's Y-up axes. The bare shape says
 * nothing about WHICH frame its numbers are in - and two boxes in different
 * frames look exactly alike at a call site, which is how one side of a
 * comparison ended up absolute world while the other stayed RTC-relative -
 * so this module only ever hands out the branded {@link WorldAabb}.
 */
export interface Aabb { min: readonly [number, number, number]; max: readonly [number, number, number] }

/**
 * An {@link Aabb} whose coordinates are ABSOLUTE world (Y-up): the model's
 * RTC offset and origin shift folded in, the frame `MeshData.geometryAabb`
 * is contracted to be in. The `frame` tag is a real runtime field, not a
 * phantom brand: an untagged box in an unstated frame does not typecheck
 * where a `WorldAabb` is required, and a debugger shows what a box claims
 * to be.
 */
export interface WorldAabb extends Aabb { readonly frame: 'world' }

/** The Y-up translation that lifts a model's render-frame coordinates
 *  (`origin + positions`) into the absolute world frame - see
 *  {@link renderToWorldShift}. */
export interface RenderToWorldShift { readonly x: number; readonly y: number; readonly z: number }

/**
 * A model's render-to-world shift, read off its `CoordinateInfo`:
 *
 *   world_yup = render + originShift + rtcAsYup,  rtcAsYup = (rtc.x, rtc.z, -rtc.y)
 *
 * (`wasmRtcOffset` is recorded in IFC Z-up axes; `originShift` is already
 * Y-up). The same composition as `federationAlign.ts`'s `totalYupOffset` and
 * `scanSectionMath.ts`'s `pointCloudRenderFrameShift`, both derived from
 * `reproject.ts`. Absent info (or absent offsets) means the render frame IS
 * the world frame - the zero shift keeps un-georeferenced models bit-exact.
 */
export function renderToWorldShift(info: CoordinateInfo | undefined): RenderToWorldShift {
  const shift = info?.originShift;
  const rtc = info?.wasmRtcOffset;
  return {
    x: (shift?.x ?? 0) + (rtc?.x ?? 0),
    y: (shift?.y ?? 0) + (rtc?.z ?? 0),
    z: (shift?.z ?? 0) - (rtc?.y ?? 0),
  };
}

/** Mutable AABB accumulator for {@link meshBounds} / {@link meshBoundsIndex}. */
interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

function emptyBox(): Box {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

/**
 * Fold one mesh's vertices into `box`, reconstructing the ABSOLUTE world
 * coordinate.
 *
 * `positions` are NOT world on the wasm path: the pipeline defaults to a
 * per-element local frame (`rust/geometry/src/router/transforms/mod.rs`), so
 * render vertex i = `origin + positions[3i..3i+3]`, and `origin` is the
 * element's AABB centre - it FOLLOWS the element. Summing raw positions
 * therefore reported a pure translation as `movedDistance = 0` (the panel
 * showed no move, the bulk CSV wrote `MovedDistance_m = 0`): only `origin`
 * moved, and the positions were byte-identical. The exact trap
 * `buildFingerprints.ts` documents against.
 *
 * `origin + positions` is still only the RENDER frame (RTC/origin shift
 * subtracted); `toWorld` lifts it into the absolute frame `geometryAabb`
 * lives in, so a box folded here is comparable with a wasm box on the other
 * side. All arithmetic in f64: origin and shift are f64, so a 2 m move stays
 * readable next to a 6,600 km coordinate.
 */
function foldMeshWorldPositions(mesh: MeshData, box: Box, toWorld: RenderToWorldShift): void {
  const o = mesh.origin;
  const ox = (o?.[0] ?? 0) + toWorld.x, oy = (o?.[1] ?? 0) + toWorld.y, oz = (o?.[2] ?? 0) + toWorld.z;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
    if (x < box.minX) box.minX = x; if (y < box.minY) box.minY = y; if (z < box.minZ) box.minZ = z;
    if (x > box.maxX) box.maxX = x; if (y > box.maxY) box.maxY = y; if (z > box.maxZ) box.maxZ = z;
  }
}

/** A folded accumulator as a {@link WorldAabb}, or null when nothing was
 *  folded. World because {@link foldMeshWorldPositions} folded `toWorld` in. */
function finishBox(box: Box): WorldAabb | null {
  if (box.minX === Infinity) return null;
  return { frame: 'world', min: [box.minX, box.minY, box.minZ], max: [box.maxX, box.maxY, box.maxZ] };
}

/** The wasm pass's whole-entity ABSOLUTE world box as a {@link WorldAabb}
 *  copy. Already absolute at the source (see `MeshData.geometryAabb`), so no
 *  shift is applied here. */
function fromEntityAabb(aabb: { min: readonly number[]; max: readonly number[] }): WorldAabb {
  return {
    frame: 'world',
    min: [aabb.min[0], aabb.min[1], aabb.min[2]],
    max: [aabb.max[0], aabb.max[1], aabb.max[2]],
  };
}

/**
 * Axis-aligned bounding box of an entity's meshes, ALWAYS in the absolute
 * world frame ({@link WorldAabb}).
 *
 * Prefers `MeshData.geometryAabb` - the whole-entity ABSOLUTE world box from
 * the wasm hashing pass, RTC offset and per-element `origin` already folded in
 * (all submeshes of an entity carry the identical box). It is the same box
 * `buildFingerprints.ts` feeds the diff engine, and the only one that stays
 * comparable when two revisions chose different RTC offsets. When the pass
 * produced no box (hashing off, older cache, NaN sentinel dropped - see
 * `geometry-fingerprints.ts`), the fallback folds
 * `toWorld + origin + positions` per vertex, landing in the SAME absolute
 * frame.
 *
 * `toWorld` is the owning model's {@link renderToWorldShift} and is required,
 * not defaulted: a hashed entity can keep its box in one revision and lose it
 * to the NaN drop in the other, and when the fallback stayed RTC-relative
 * that pair compared a world box against a render box - on a georeferenced
 * model the reported "movement" was the RTC offset, a fabricated number worse
 * than the `movedDistance = 0` the origin fold fixed (#2659). An optional
 * shift would let the next call site quietly reintroduce exactly that.
 */
export function meshBounds(
  meshes: readonly MeshData[],
  globalId: number,
  toWorld: RenderToWorldShift,
): WorldAabb | null {
  let box: Box | null = null;
  for (const mesh of meshes) {
    if (mesh.expressId !== globalId) continue;
    if (mesh.geometryAabb) return fromEntityAabb(mesh.geometryAabb);
    foldMeshWorldPositions(mesh, box ??= emptyBox(), toWorld);
  }
  return box ? finishBox(box) : null;
}

/**
 * One pass over a model's meshes -> express id -> entity world {@link Aabb}.
 * The bulk-report twin of {@link meshBounds} (#1202): SAME per-mesh fold and
 * same `geometryAabb` preference, shared so the two cannot drift - a private
 * copy of this loop is how the report path missed the `origin` fold that
 * `meshBounds`'s contract requires (#2529).
 */
export function meshBoundsIndex(
  meshes: readonly MeshData[],
  toWorld: RenderToWorldShift,
): Map<number, WorldAabb> {
  const resolved = new Map<number, WorldAabb>();
  const acc = new Map<number, Box>();
  for (const mesh of meshes) {
    if (resolved.has(mesh.expressId)) continue;
    if (mesh.geometryAabb) {
      resolved.set(mesh.expressId, fromEntityAabb(mesh.geometryAabb));
      acc.delete(mesh.expressId);
      continue;
    }
    let box = acc.get(mesh.expressId);
    if (!box) acc.set(mesh.expressId, box = emptyBox());
    foldMeshWorldPositions(mesh, box, toWorld);
  }
  for (const [id, box] of acc) {
    const aabb = finishBox(box);
    // An entity whose meshes carried no vertices gets NO box - indexing the
    // empty accumulator would hand `summarizeGeometryChange` an Infinity box
    // and a NaN distance, where `meshBounds` answers null.
    if (aabb) resolved.set(id, aabb);
  }
  return resolved;
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
 *
 * Takes {@link WorldAabb}, not bare {@link Aabb}: the subtraction below is
 * only meaningful between boxes in the SAME frame, and requiring the brand
 * makes a mixed-frame pair (the #2659 defect) a type error instead of a
 * plausible-looking displacement.
 */
export function summarizeGeometryChange(ba: WorldAabb | null, bb: WorldAabb | null): GeometrySummary | null {
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
