/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity placement on the Y.Doc — the canonical, IFCX-native way to sync
 * a move/rotate edit across a collab room.
 *
 * Placement rides as the standard IFCX `usd::xformop` attribute (a 4×4
 * row-major matrix). Because `snapshotToIfcx` copies every entity attribute
 * straight into the IFCX node, and `parseIfcxViewerModel` already reads
 * `usd::xformop` via its geometry extractor, placement round-trips with **no
 * change to the snapshot writer or the IFCX parser** — it is just another
 * attribute.
 *
 * The viewer's geometry-edit stack speaks a normalized local-placement
 * (`{location, axis, refDirection}`) — exactly an `IfcAxis2Placement3D`
 * (origin + local +Z + local +X). These helpers convert that shape ⇆ the
 * matrix so the legacy STEP edit math and the IFCX wire form stay in sync.
 * All coordinates are IFC storey-local, Z-up (the same frame the STEP
 * placement chain and `getNodeTransform` use — the Z-up→Y-up swap happens
 * later, in the renderer ingest).
 *
 * Matrix convention (must match `@ifc-lite/ifcx` `getNodeTransform` /
 * `applyTransform`): row-major `number[][]`, **row-vector** form `p' = [p 1]·M`,
 * so the basis vectors are the first three ROWS and the translation is ROW 3.
 */

import * as Y from 'yjs';
import { ENTITY_KEY, entitiesMap } from './schema.js';

/** IFCX/USD transform attribute key (mirrors `@ifc-lite/ifcx` `ATTR.TRANSFORM`). */
export const USD_XFORMOP = 'usd::xformop';

/** 4×4 row-major matrix, row-vector convention. */
export type Mat4 = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

/** The IFCX `usd::xformop` attribute value shape. */
export interface UsdXformOp {
  transform: number[][];
}

/**
 * Normalized local placement — an `IfcAxis2Placement3D`:
 *   - `location`     storey-local origin (IFC Z-up)
 *   - `axis`         local +Z direction (defaults to world +Z)
 *   - `refDirection` local +X direction (defaults to world +X)
 */
export interface LocalPlacement {
  location: [number, number, number];
  axis?: [number, number, number];
  refDirection?: [number, number, number];
}

type Vec3 = [number, number, number];

const EPS = 1e-9;

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < EPS) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Build a 4×4 (row-vector) matrix from a normalized local placement.
 * Rows 0/1/2 carry the orthonormal local X/Y/Z basis; row 3 the origin.
 */
export function placementToMatrix(p: LocalPlacement): Mat4 {
  const z = normalize((p.axis ?? [0, 0, 1]) as Vec3);
  const zAxis: Vec3 = z[0] === 0 && z[1] === 0 && z[2] === 0 ? [0, 0, 1] : z;
  const refRaw = (p.refDirection ?? [1, 0, 0]) as Vec3;
  // Gram–Schmidt: project refDirection off the Z axis so X ⟂ Z.
  const d = dot(refRaw, zAxis);
  let x = normalize([refRaw[0] - d * zAxis[0], refRaw[1] - d * zAxis[1], refRaw[2] - d * zAxis[2]]);
  if (x[0] === 0 && x[1] === 0 && x[2] === 0) {
    // refDirection was parallel to Z — fall back to a stable perpendicular.
    x = Math.abs(zAxis[0]) < 0.9 ? normalize(cross([1, 0, 0], zAxis)) : normalize(cross([0, 1, 0], zAxis));
  }
  const y = cross(zAxis, x);
  const [lx, ly, lz] = p.location;
  return [
    [x[0], x[1], x[2], 0],
    [y[0], y[1], y[2], 0],
    [zAxis[0], zAxis[1], zAxis[2], 0],
    [lx, ly, lz, 1],
  ];
}

/** Decompose a (row-vector) matrix back to a normalized local placement. */
export function matrixToPlacement(m: number[][]): LocalPlacement {
  return {
    location: [m[3]?.[0] ?? 0, m[3]?.[1] ?? 0, m[3]?.[2] ?? 0],
    axis: [m[2]?.[0] ?? 0, m[2]?.[1] ?? 0, m[2]?.[2] ?? 1],
    refDirection: [m[0]?.[0] ?? 1, m[0]?.[1] ?? 0, m[0]?.[2] ?? 0],
  };
}

/* ------------------------------------------------------------------ */
/* Y.Doc accessors                                                     */
/* ------------------------------------------------------------------ */

function getEntity(doc: Y.Doc, path: string): Y.Map<unknown> | undefined {
  return entitiesMap(doc).get(path) as Y.Map<unknown> | undefined;
}

/**
 * Write an entity's local placement as the `usd::xformop` attribute. Stored as
 * a plain JSON matrix (replaced atomically — a placement has no meaningful
 * partial update at the IFC level). No-op if the entity is missing.
 */
export function setEntityPlacement(doc: Y.Doc, path: string, placement: LocalPlacement): void {
  const entity = getEntity(doc, path);
  if (!entity) return;
  const attrs = entity.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
  if (!attrs) return;
  const matrix = placementToMatrix(placement);
  attrs.set(USD_XFORMOP, { transform: matrix.map((row) => [...row]) } satisfies UsdXformOp);
}

/** Read an entity's local placement from `usd::xformop`, or null if absent. */
export function getEntityPlacement(doc: Y.Doc, path: string): LocalPlacement | null {
  const attrs = getEntity(doc, path)?.get(ENTITY_KEY.ATTRIBUTES) as Y.Map<unknown> | undefined;
  const xform = attrs?.get(USD_XFORMOP) as UsdXformOp | undefined;
  if (!xform || !Array.isArray(xform.transform)) return null;
  return matrixToPlacement(xform.transform);
}

/**
 * `meta.placementBaseline` key — the `usd::xformop` value an entity's geometry
 * blob was baked at. Lives in the entity's `meta` map, which is **room-only**:
 * `snapshotToIfcx` emits attributes/children/inherits but not `meta`, so this
 * never pollutes the IFCX wire. Every client renders `blob + (current xformop
 * relative to this baseline)`, so a late joiner that hydrates a blob baked at
 * M₀ while `usd::xformop` already reads M₁ still places it correctly.
 */
export const PLACEMENT_BASELINE_META = 'placementBaseline';

/**
 * Record the placement an entity's geometry blob was baked at (the value of
 * `usd::xformop` when the blob was seeded — identity for legacy STEP models
 * whose geometry is baked world-absolute). Idempotent: only the first write
 * sticks, so re-seeding never moves the baseline out from under live edits.
 */
export function setPlacementBaseline(doc: Y.Doc, path: string, placement: LocalPlacement): void {
  const entity = getEntity(doc, path);
  if (!entity) return;
  const meta = entity.get(ENTITY_KEY.META) as Y.Map<unknown> | undefined;
  if (!meta || meta.has(PLACEMENT_BASELINE_META)) return;
  const matrix = placementToMatrix(placement);
  meta.set(PLACEMENT_BASELINE_META, { transform: matrix.map((row) => [...row]) } satisfies UsdXformOp);
}

/** Read the baked-baseline placement, or null if none was recorded. */
export function getPlacementBaseline(doc: Y.Doc, path: string): LocalPlacement | null {
  const meta = getEntity(doc, path)?.get(ENTITY_KEY.META) as Y.Map<unknown> | undefined;
  const xform = meta?.get(PLACEMENT_BASELINE_META) as UsdXformOp | undefined;
  if (!xform || !Array.isArray(xform.transform)) return null;
  return matrixToPlacement(xform.transform);
}
