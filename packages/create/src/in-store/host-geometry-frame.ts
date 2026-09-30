/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Package-private body frame reads: defaults belong only to omitted optional
 * attributes, never to an explicit unreadable reference (#6232 / #6539). */
import { firstProjAxis } from '@ifc-lite/data';
import type { AnchorEntityReader } from './resolve-anchor.js';

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

export function pointOf(reader: AnchorEntityReader, ref: unknown, type = 'IFCCARTESIANPOINT', dimension: 2 | 3 = 3): Vec3 | null {
  const id = refId(ref);
  const entity = id === null ? null : reader.entity(id);
  return entity?.type.toUpperCase() === type ? vec3(entity.attributes[0], dimension) : null;
}

export function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : null;
}

/** IfcAxis2Placement2D: Position is optional on a profile; Location is required. */
export function axis2d(reader: AnchorEntityReader, ref: unknown): { o: [number, number]; x: [number, number] } | null {
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
export function axis3d(reader: AnchorEntityReader, ref: unknown): Frame3 | null {
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
