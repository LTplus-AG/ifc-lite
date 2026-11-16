/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcMappedItem`: the items of a `RepresentationMap`'s representation, placed
 * by `MappingTarget · MappingOrigin` (the order the repo's geometry engine
 * composes them in, `rust/geometry/.../mapped_transform.rs`). The target's
 * axes follow `IfcBaseAxis`: Axis3 (default +Z), Axis1 projected on its plane
 * (default `IfcFirstProjAxis`), Axis2 (default +Y) projected on both, so an
 * omitted Axis2 can make a mirror. A uniform Scale is applied; a non-uniform
 * one (Scale2 or Scale3 differing) is refused, its items unreadable. Nested
 * maps are followed up to `MAX_MAP_DEPTH`, and a map met again on the way is
 * a cycle: unreadable, never a loop.
 */

import { firstProjAxis } from '@ifc-lite/data';
import { asNumber, asRef, asRefList, type ModelReader } from './reader.js';
import { axisPlacementFrame, composeFrames, cross, dot, IDENTITY, normalize, readDirection, readPoint, type Frame, type Vec3 } from './placement.js';

export const MAX_MAP_DEPTH = 8;

/** One leaf item to read, placed by `frame`; null `frame`: an item that cannot be placed (counted, never read). */
export interface PlacedItem {
  item: number;
  frame: Frame | null;
}

const project = (v: Vec3, on: Vec3): Vec3 => {
  const d = dot(v, on);
  return [v[0] - d * on[0], v[1] - d * on[1], v[2] - d * on[2]];
};

/** `IfcCartesianTransformationOperator3D` (or its non-uniform subtype) as a frame; null when unreadable or non-uniform. */
function operatorFrame(reader: ModelReader, id: number | null): Frame | null {
  const e = reader.entity(id);
  if (!e || (e.type !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3D' && e.type !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM')) return null;
  const origin = readPoint(reader, reader.attr(e, 'LocalOrigin'));
  const optional = (name: string): Vec3 | null | undefined => {
    const v = reader.attr(e, name);
    return v === null || v === undefined ? undefined : readDirection(reader, v);
  };
  const [a1, a2, a3] = [optional('Axis1'), optional('Axis2'), optional('Axis3')];
  if (!origin || a1 === null || a2 === null || a3 === null) return null;
  const rawScale = reader.attr(e, 'Scale');
  const scale = rawScale === null || rawScale === undefined ? 1 : asNumber(rawScale);
  if (scale === null || !(scale > 0) || !Number.isFinite(scale)) return null;
  for (const name of ['Scale2', 'Scale3']) {
    const v = reader.attr(e, name);
    if (v === null || v === undefined) continue;
    const s = asNumber(v);
    // Non-uniform: a body stretched differently per axis is not read (its bounds would need the scaled solid itself).
    if (s === null || Math.abs(s - scale) > 1e-9 * Math.max(1, Math.abs(scale))) return null;
  }
  const z = normalize(a3 ?? [0, 0, 1]);
  if (!z) return null;
  const x = normalize(project(a1 ?? firstProjAxis(z), z));
  if (!x) return null;
  const y = normalize(project(project(a2 ?? [0, 1, 0], z), x)) ?? cross(z, x);
  const s = (v: Vec3): Vec3 => [v[0] * scale, v[1] * scale, v[2] * scale];
  return { origin, x: s(x), y: s(y), z: s(z) };
}

/**
 * The leaf items of a representation item, each with the frame that places it
 * in the item's own coordinates: itself for an ordinary item, the mapped
 * representation's items (recursively) for an `IfcMappedItem`.
 */
export function placedItems(reader: ModelReader, item: number, outer: Frame = IDENTITY, depth = 0, path: ReadonlySet<number> = new Set()): PlacedItem[] {
  const e = reader.entity(item);
  if (!e || e.type !== 'IFCMAPPEDITEM') return [{ item, frame: outer }];
  const mapId = asRef(reader.attr(e, 'MappingSource'));
  const map = reader.entity(mapId);
  const rep = map ? reader.entity(asRef(reader.attr(map, 'MappedRepresentation'))) : null;
  const target = operatorFrame(reader, asRef(reader.attr(e, 'MappingTarget')));
  const originRef = map ? reader.attr(map, 'MappingOrigin') : null;
  const origin = originRef === null || originRef === undefined ? IDENTITY : axisPlacementFrame(reader, originRef);
  if (!map || !rep || mapId === null || !target || !origin || depth >= MAX_MAP_DEPTH || path.has(mapId)) return [{ item, frame: null }];
  const frame = composeFrames(outer, composeFrames(target, origin));
  const inner = new Set(path).add(mapId);
  const out: PlacedItem[] = [];
  for (const child of asRefList(reader.attr(rep, 'Items'))) out.push(...placedItems(reader, child, frame, depth + 1, inner));
  return out.length > 0 ? out : [{ item, frame: null }];
}
