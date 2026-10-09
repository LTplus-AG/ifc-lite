/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Package-private body frame reads: defaults belong only to omitted optional
 * attributes, never to an explicit unreadable reference (#6232 / #6539). */
import { firstProjAxis } from '@ifc-lite/data';
import type { AnchorEntityReader } from './resolve-anchor.js';
import type { HostBounds } from './anchor.js';

/** Structural entity access lets body and planar readers share the same
 * placement validation without requiring an anchor's unrelated methods. */
export interface GeometryEntityReader {
  entity(id: number): { type: string; attributes: readonly unknown[] } | null;
}

export type Vec3 = [number, number, number];
export type Frame3 = { o: Vec3; x: Vec3; y: Vec3; z: Vec3 };

/** Source extractors use numbers; overlay references use #id strings. */
export function refId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^#[1-9][0-9]*$/.test(value)) return Number(value.slice(1));
  return null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A 3D frame needs exactly three coordinates. A profile opts into two,
 * embedded in XY; missing 3D coordinates must never be synthesized. */
export function vec3(value: unknown, dimension: 2 | 3 = 3): Vec3 | null {
  if (!Array.isArray(value) || value.length !== dimension) return null;
  const x = num(value[0]);
  const y = num(value[1]);
  const z = dimension === 3 ? num(value[2]) : 0;
  return x === null || y === null || z === null ? null : [x, y, z];
}

export function pointOf(reader: GeometryEntityReader, ref: unknown, type = 'IFCCARTESIANPOINT', dimension: 2 | 3 = 3): Vec3 | null {
  const id = refId(ref);
  const entity = id === null ? null : reader.entity(id);
  return entity?.type.toUpperCase() === type ? vec3(entity.attributes[0], dimension) : null;
}

export function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : null;
}

/** IfcAxis2Placement2D: Position is optional on a profile; Location is required. */
export function axis2d(reader: GeometryEntityReader, ref: unknown): { o: [number, number]; x: [number, number] } | null {
  if (ref === null || ref === undefined) return { o: [0, 0], x: [1, 0] };
  const id = refId(ref), placement = id === null ? null : reader.entity(id);
  if (placement?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT2D') return null;
  const o = pointOf(reader, placement.attributes[0], 'IFCCARTESIANPOINT', 2);
  const refDirection = placement.attributes[1];
  const dir = refDirection === null || refDirection === undefined ? [1, 0, 0] as Vec3 : pointOf(reader, refDirection, 'IFCDIRECTION', 2);
  const x = dir ? unit([dir[0], dir[1], 0]) : null;
  return o && x ? { o: [o[0], o[1]], x: [x[0], x[1]] } : null;
}

/** IfcAxis2Placement3D: only an omitted optional Position/Axis/RefDirection
 * uses defaults. An explicit missing, zero or parallel axis is unreadable. */
export function axis3d(reader: GeometryEntityReader, ref: unknown): Frame3 | null {
  if (ref === null || ref === undefined) return { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const id = refId(ref), placement = id === null ? null : reader.entity(id);
  if (placement?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D') return null;
  const o = pointOf(reader, placement.attributes[0]);
  const axis = placement.attributes[1], refDirection = placement.attributes[2];
  const direction = axis === null || axis === undefined ? [0, 0, 1] as Vec3 : pointOf(reader, axis, 'IFCDIRECTION');
  const z = direction ? unit(direction) : null;
  if (!o || !z) return null;
  // An absent RefDirection uses the renderer's canonical fill (#5922).
  const r = refDirection === null || refDirection === undefined ? firstProjAxis(z) : pointOf(reader, refDirection, 'IFCDIRECTION');
  if (!r) return null;
  const dot = r[0] * z[0] + r[1] * z[1] + r[2] * z[2];
  const x = unit([r[0] - dot * z[0], r[1] - dot * z[1], r[2] - dot * z[2]]);
  if (!x) return null;
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { o, x, y, z };
}

export function applyFrame(f: Frame3, p: Vec3): Vec3 {
  return [
    f.o[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.z[0] * p[2],
    f.o[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.z[1] * p[2],
    f.o[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.z[2] * p[2],
  ];
}

const IDENTITY_FRAME3: Frame3 = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function transformBounds(bounds: HostBounds, frame: Frame3): HostBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    const p = applyFrame(frame, [x, y, z]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  }
  return { min, max };
}

export function composeFrame(outer: Frame3, inner: Frame3): Frame3 {
  const direction = (p: Vec3): Vec3 => [0, 1, 2].map(i => outer.x[i] * p[0] + outer.y[i] * p[1] + outer.z[i] * p[2]) as Vec3;
  return { o: applyFrame(outer, inner.o), x: direction(inner.x), y: direction(inner.y), z: direction(inner.z) };
}

/** Rigid placement inverse; axis3d supplies orthonormal placement axes. */
export function inverseFrame(f: Frame3): Frame3 {
  return {
    o: [f.x, f.y, f.z].map(v => -(v[0] * f.o[0] + v[1] * f.o[1] + v[2] * f.o[2])) as Vec3,
    x: [f.x[0], f.y[0], f.z[0]], y: [f.x[1], f.y[1], f.z[1]], z: [f.x[2], f.y[2], f.z[2]],
  };
}

/** Full 3D local-placement chain, including the opening's rotated frame.
 * Missing references, cycles and excessive acyclic chains are unreadable. */
export function placementInAncestor(reader: GeometryEntityReader, placementId: number, ancestorId: number | null): Frame3 | null {
  let frame = IDENTITY_FRAME3;
  let id: number | null = placementId;
  const visited = new Set<number>();
  while (id !== null && id !== ancestorId) {
    if (visited.size >= 10_000 || visited.has(id)) return null;
    visited.add(id);
    const placement = reader.entity(id);
    const axisId = placement ? refId(placement.attributes[1]) : null;
    if (placement?.type.toUpperCase() !== 'IFCLOCALPLACEMENT' || axisId === null) return null;
    const own = axis3d(reader, axisId);
    if (!own) return null;
    frame = composeFrame(own, frame);
    const parent = placement.attributes[0];
    // #7328: an explicit unreadable parent is not an omitted world root.
    if (parent !== null && parent !== undefined && refId(parent) === null) return null;
    id = refId(parent);
  }
  return id === ancestorId ? frame : null;
}

/** Express one local placement in another's full 3D frame. Only the branches
 * below their common ancestor need readable frames; the shared ancestor
 * cancels, as it does in the canonical planar storey reader (#6232). */
export function placementRelativeTo(reader: GeometryEntityReader, placementId: number, referenceId: number): Frame3 | null {
  const parent = (id: number): number | null | undefined => {
    const entity = reader.entity(id);
    if (entity?.type.toUpperCase() !== 'IFCLOCALPLACEMENT') return undefined;
    const value = entity.attributes[0];
    return value === null || value === undefined ? null : refId(value) ?? undefined;
  };
  const referenceChain = new Set<number>();
  let id: number | null | undefined = referenceId;
  while (id !== null && id !== undefined && !referenceChain.has(id)) {
    if (referenceChain.size >= 10_000) return null;
    referenceChain.add(id);
    id = parent(id);
  }
  const referenceReachesRoot = id === null;
  const visited = new Set<number>();
  id = placementId;
  while (id !== null && id !== undefined && !referenceChain.has(id)) {
    if (visited.size >= 10_000 || visited.has(id)) return null;
    visited.add(id);
    id = parent(id);
  }
  if (id === undefined || (id === null && !referenceReachesRoot)) return null;
  const own = placementInAncestor(reader, placementId, id);
  const reference = placementInAncestor(reader, referenceId, id);
  return own && reference ? composeFrame(inverseFrame(reference), own) : null;
}

/** Subcontexts inherit CoordinateSpaceDimension from ParentContext. */
export function contextDimension(reader: AnchorEntityReader, contextId: number): 2 | 3 | null {
  let id: number | null = contextId;
  const visited = new Set<number>();
  while (id !== null && visited.size < 10_000 && !visited.has(id)) {
    visited.add(id);
    const context = reader.entity(id);
    if (context?.type.toUpperCase() === 'IFCGEOMETRICREPRESENTATIONCONTEXT') {
      const dimension = context.attributes[2];
      return dimension === 2 || dimension === 3 ? dimension : null;
    }
    if (context?.type.toUpperCase() !== 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT') return null;
    id = refId(context.attributes[6]);
  }
  return null;
}
