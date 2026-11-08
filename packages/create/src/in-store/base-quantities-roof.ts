/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Areas of a pitched roof's planes, read off its live body (#9296 round 3).
 *
 * A roof by footprint (`roof-footprint.ts`) is one swept solid per plane, each
 * an outline lying in the plane and swept up by the thickness. Its sloped area
 * is that outline's area; its area in plan is that times the cosine of the
 * plane's tilt. Like the slab reader beside it, this reads the shape and
 * stores nothing, and it answers only for bodies it can read exactly.
 */

import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { polygonArea } from './base-quantities-measure.js';
import { asExpressIdRef, readAttributes } from './edit/placement-core.js';

export interface RoofPlaneAreas {
  /** Sum of the planes' sloped areas, m². */
  readonly sloped: number;
  /** Sum of their areas in plan, m². */
  readonly projected: number;
}

type Read = (id: number | null) => unknown[] | null;

function coordinates(read: Read, id: number | null, dimension: number): number[] | null {
  const value = read(id)?.[0];
  if (!Array.isArray(value) || value.length < dimension || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  return value as number[];
}

/** One plane: a polygon swept along a direction. Null for anything else. */
function plane(read: Read, solidId: number | null, scale: number): { area: number; cos: number } | null {
  const solid = read(solidId);
  if (!solid || solid.length < 4) return null;
  const profile = read(asExpressIdRef(solid[0]));
  const curve = read(asExpressIdRef(profile?.[2]));
  const points = curve?.[0];
  if (!profile || profile.length !== 3 || !Array.isArray(points)) return null;
  const outline: Array<[number, number]> = [];
  for (const ref of points) {
    const p = coordinates(read, asExpressIdRef(ref), 2);
    if (!p) return null;
    outline.push([p[0] * scale, p[1] * scale]);
  }
  const position = read(asExpressIdRef(solid[1]));
  const axis = position?.[1] == null ? [0, 0, 1] : coordinates(read, asExpressIdRef(position[1]), 3);
  if (!axis) return null;
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  return length > 0 ? { area: Math.abs(polygonArea(outline)), cos: Math.abs(axis[2]) / length } : null;
}

/**
 * The sloped and plan areas of a roof whose Body is one or more planes, or
 * null when its body is not that (a loaded file's roof keeps its own sets).
 * Lengths are in the file's unit; `scale` is metres per unit.
 */
export function roofPlaneAreas(dataStore: IfcDataStore, view: MutablePropertyView, editor: Pick<StoreEditor, 'getNewEntity'>, roofId: number, scale: number): RoofPlaneAreas | null {
  const read: Read = (id) => (id === null ? null : readAttributes(dataStore, view, editor, id));
  const shape = read(asExpressIdRef(read(roofId)?.[6]));
  const reps = shape?.[2];
  if (!Array.isArray(reps)) return null;
  const bodies = reps.map((ref) => read(asExpressIdRef(ref))).filter((rep) => rep?.[1] === 'Body');
  const items = bodies.length === 1 ? bodies[0]![3] : null;
  if (!Array.isArray(items) || items.length === 0) return null;
  let sloped = 0, projected = 0;
  for (const item of items) {
    const measured = plane(read, asExpressIdRef(item), scale);
    if (!measured) return null;
    sloped += measured.area;
    projected += measured.area * measured.cos;
  }
  return { sloped, projected };
}
