/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a `HostAnchor` — everything an opening or a hosted door/window needs
 * to know about the wall or slab it is cut into — from a parsed store plus the
 * live mutation overlay, so a host authored earlier in the same session works
 * exactly like one read from the file.
 *
 * The in-store builders stay pure: this is the only place that walks the host
 * graph. It reads the host's placement, its containing storey (via
 * IfcRelContainedInSpatialStructure) and the bounds of its Body geometry, from
 * which the opening builder derives the default cut depth.
 */

import { firstProjAxis } from '@ifc-lite/data';
import { axis2d, axis3d, applyFrame, pointOf, refId, num, unit, vec3, type Vec3, type Frame3 } from './host-geometry-frame.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { HostAnchor, HostBounds, HostKind } from './anchor.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';

const HOST_KINDS: ReadonlyMap<string, HostKind> = new Map([
  ['IFCWALL', 'wall'],
  ['IFCWALLSTANDARDCASE', 'wall'],
  ['IFCWALLELEMENTEDCASE', 'wall'],
  ['IFCSLAB', 'slab'],
  ['IFCSLABSTANDARDCASE', 'slab'],
  ['IFCSLABELEMENTEDCASE', 'slab'],
]);

export function resolveHostAnchor(
  store: IfcDataStore,
  hostExpressId: number,
  view?: MutablePropertyView | null,
): HostAnchor {
  const reader = new AnchorEntityReader(store, view);
  const host = reader.entity(hostExpressId);
  if (!host) throw new Error(`resolveHostAnchor: host #${hostExpressId} does not exist`);
  const hostKind = HOST_KINDS.get(host.type.toUpperCase());
  if (!hostKind) {
    throw new Error(`resolveHostAnchor: #${hostExpressId} is an ${host.type}; openings are supported in IfcWall and IfcSlab hosts`);
  }

  const hostPlacementId = refId(named(host, 'ObjectPlacement', 5));
  if (hostPlacementId === null || reader.entity(hostPlacementId)?.type.toUpperCase() !== 'IFCLOCALPLACEMENT') {
    throw new Error(`resolveHostAnchor: host #${hostExpressId} has no IfcLocalPlacement to cut the opening in`);
  }

  const storeyId = containingStorey(reader, hostExpressId);
  if (storeyId === null) {
    throw new Error(`resolveHostAnchor: host #${hostExpressId} is not contained in a spatial structure element (IfcRelContainedInSpatialStructure)`);
  }
  const anchor = resolveSpatialAnchor(store, storeyId, view);

  const shapeId = refId(named(host, 'Representation', 6));
  const hostBounds = shapeId === null ? null : bodyBounds(reader, shapeId);
  return { ...anchor, hostId: hostExpressId, hostKind, hostPlacementId, hostBounds };
}

/**
 * The extent of `productId`'s Body geometry in its PARENT placement's frame
 * (native units): the body bounds taken through the product's own
 * RelativePlacement. For an opening placed relative to its host, that is the
 * cut's extent in the host's frame, whatever profile or orientation the
 * authoring tool gave it. Null when the product has no readable body.
 */
export function placedBodyExtent(
  store: IfcDataStore,
  productId: number,
  view?: MutablePropertyView | null,
): HostBounds | null {
  const reader = new AnchorEntityReader(store, view);
  const product = reader.entity(productId);
  if (!product) return null;
  const shapeId = refId(named(product, 'Representation', 6));
  const local = shapeId === null ? null : bodyBounds(reader, shapeId);
  const placementId = refId(named(product, 'ObjectPlacement', 5));
  const placement = placementId === null ? null : reader.entity(placementId);
  if (!local || placement?.type.toUpperCase() !== 'IFCLOCALPLACEMENT' || refId(placement.attributes[1]) === null) return null;
  const frame = axis3d(reader, placement.attributes[1]);
  if (!frame) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [local.min[0], local.max[0]]) for (const y of [local.min[1], local.max[1]]) for (const z of [local.min[2], local.max[2]]) {
    const p = applyFrame(frame, [x, y, z]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  }
  return { min, max };
}

function named(record: { names: string[]; attributes: unknown[] }, name: string, fallback: number): unknown {
  const index = record.names.indexOf(name);
  return record.attributes[index >= 0 ? index : fallback];
}

function containingStorey(reader: AnchorEntityReader, hostId: number): number | null {
  for (const relId of reader.ids('IFCRELCONTAINEDINSPATIALSTRUCTURE')) {
    const rel = reader.entity(relId);
    const related = rel ? named(rel, 'RelatedElements', 4) : null;
    if (!rel || !Array.isArray(related) || !related.some((v) => refId(v) === hostId)) continue;
    return refId(named(rel, 'RelatingStructure', 5));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body bounds
// ---------------------------------------------------------------------------

function bodyBounds(reader: AnchorEntityReader, productShapeId: number): HostBounds | null {
  const shape = reader.entity(productShapeId);
  const reps = shape ? shape.attributes[2] : null;
  if (!Array.isArray(reps)) return null;
  const points: Vec3[] = [];
  for (const repRef of reps) {
    const repId = refId(repRef);
    const rep = repId === null ? null : reader.entity(repId);
    if (!rep) return null;
    const identifier = rep.attributes[1];
    if (typeof identifier === 'string' && identifier.toLowerCase() !== 'body') continue;
    const items = rep.attributes[3];
    if (!Array.isArray(items) || items.length === 0) return null;
    for (const item of items) {
      const itemId = refId(item);
      if (itemId === null || !collectItemPoints(reader, itemId, points)) return null;
    }
  }
  if (points.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  }
  return { min, max };
}

/**
 * Points bounding one representation item. A boolean result is bounded by its
 * FirstOperand (a clipping only removes material, so the operand's bounds are
 * conservative). Mapped items compose their target with the inverse mapping
 * origin. An iterative path set preserves two real instances of one map,
 * while a work/point budget also bounds acyclic fan-out (#6232 D5).
 */
function collectItemPoints(reader: AnchorEntityReader, itemId: number, out: Vec3[]): boolean {
  const identity: Frame3 = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const stack = [{ id: itemId, frame: identity, exit: false }];
  const path = new Set<number>();
  const records = new Map<number, ReturnType<AnchorEntityReader['entity']>>();
  const mappings = new Map<number, ReturnType<typeof mappedItemFrame>>();
  const leaves = new Map<number, Vec3[]>();
  let work = 0;
  while (stack.length) {
    const task = stack.pop()!;
    if (task.exit) { path.delete(task.id); continue; }
    if (++work > 10_000 || path.has(task.id)) return false;
    path.add(task.id);
    stack.push({ ...task, exit: true });
    if (!records.has(task.id)) records.set(task.id, reader.entity(task.id));
    const item = records.get(task.id);
    if (!item) return false;
    const type = item.type.toUpperCase();
    if (type === 'IFCBOOLEANRESULT' || type === 'IFCBOOLEANCLIPPINGRESULT') {
      const id = refId(item.attributes[1]);
      if (id === null) return false;
      stack.push({ id, frame: task.frame, exit: false });
      continue;
    }
    if (type === 'IFCMAPPEDITEM') {
      if (!mappings.has(task.id)) mappings.set(task.id, mappedItemFrame(reader, item.attributes));
      const mapped = mappings.get(task.id);
      if (!mapped || mapped.items.length > 10_000 - work) return false;
      const frame = composeFrame(task.frame, mapped.frame);
      for (const id of mapped.items) stack.push({ id, frame, exit: false });
      continue;
    }
    let points = leaves.get(task.id);
    if (!points) {
      points = [];
      if (type === 'IFCEXTRUDEDAREASOLID') extrudedPoints(reader, item.attributes, points);
      else if (type === 'IFCTRIANGULATEDFACESET' || type === 'IFCPOLYGONALFACESET') {
        const list = refId(item.attributes[0]);
        const coords = list === null ? null : reader.entity(list)?.attributes[0];
        if (!Array.isArray(coords) || coords.length > 100_000) return false;
        for (const c of coords) { const p = vec3(c); if (!p) return false; points.push(p); }
      }
      leaves.set(task.id, points);
    }
    if (points.length === 0 || out.length + points.length > 100_000) return false;
    for (const p of points) {
      const placed = applyFrame(task.frame, p);
      if (!placed.every(Number.isFinite)) return false;
      out.push(placed);
    }
  }
  return true;
}

function composeFrame(outer: Frame3, inner: Frame3): Frame3 {
  const direction = (p: Vec3): Vec3 => [0, 1, 2].map(i => outer.x[i] * p[0] + outer.y[i] * p[1] + outer.z[i] * p[2]) as Vec3;
  return { o: applyFrame(outer, inner.o), x: direction(inner.x), y: direction(inner.y), z: direction(inner.z) };
}

function mappedItemFrame(reader: AnchorEntityReader, attrs: unknown[]): { items: number[]; frame: Frame3 } | null {
  const mapId = refId(attrs[0]), targetId = refId(attrs[1]);
  const map = mapId === null ? null : reader.entity(mapId);
  const target = targetId === null ? null : reader.entity(targetId);
  const originId = map ? refId(map.attributes[0]) : null;
  const origin = originId === null ? null : reader.entity(originId);
  const repId = map ? refId(map.attributes[1]) : null;
  const rep = repId === null ? null : reader.entity(repId);
  if (!map || !target || origin?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D' || !pointOf(reader, origin.attributes[0]) || !rep || !Array.isArray(rep.attributes[3])) return null;
  const targetType = target.type.toUpperCase();
  if (targetType !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3D' && targetType !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM') return null;
  const a = target.attributes;
  const o = pointOf(reader, a[2]);
  // IfcBaseAxis derives Z first, projects Axis1 off Z, then projects Axis2
  // off both. Axis2's sense permits mirroring; normalizing three unrelated
  // supplied vectors would produce a skew instead of the specified operator.
  // https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcBaseAxis.htm
  const direction = (value: unknown, fallback: Vec3) => value === null || value === undefined ? fallback : pointOf(reader, value, 'IFCDIRECTION');
  const zAxis = unit(direction(a[4], [0, 0, 1]) ?? [0, 0, 0]);
  if (!zAxis) return null;
  const project = (v: Vec3, axes: Vec3[]) => {
    const p: Vec3 = [...v];
    for (const axis of axes) {
      const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
      for (let i = 0; i < 3; i++) p[i] -= dot * axis[i];
    }
    return unit(p);
  };
  const xArg = direction(a[0], firstProjAxis(zAxis));
  const xAxis = xArg ? project(xArg, [zAxis]) : null;
  const yArg = direction(a[1], [0, 1, 0]);
  const yAxis = yArg && xAxis ? project(yArg, [zAxis, xAxis]) : null;
  if (!xAxis || !yAxis) return null;
  const scale = a[3] === null || a[3] === undefined ? 1 : num(a[3]);
  const scales = [scale, a[5] === null || a[5] === undefined ? scale : num(a[5]), a[6] === null || a[6] === undefined ? scale : num(a[6])];
  if (!o || scales.some(v => v === null || v <= 0)) return null;
  const [x, y, z] = [xAxis, yAxis, zAxis].map((v, i) => v.map(n => n * scales[i]!) as Vec3);
  const source = axis3d(reader, originId);
  if (!source) return null;
  const inverse: Frame3 = {
    o: [source.x, source.y, source.z].map(v => -(v[0] * source.o[0] + v[1] * source.o[1] + v[2] * source.o[2])) as Vec3,
    x: [source.x[0], source.y[0], source.z[0]], y: [source.x[1], source.y[1], source.z[1]], z: [source.x[2], source.y[2], source.z[2]],
  };
  const items = rep.attributes[3].map(refId);
  if (items.some(id => id === null) || items.length === 0) return null;
  return { items: items as number[], frame: composeFrame({ o, x, y, z }, inverse) };
}

/** IfcExtrudedAreaSolid: SweptArea(0), Position(1), ExtrudedDirection(2), Depth(3). */
function extrudedPoints(reader: AnchorEntityReader, attrs: unknown[], out: Vec3[]): void {
  const profileId = refId(attrs[0]);
  const outline = profileId === null ? null : profileOutline(reader, profileId);
  const depth = num(attrs[3]);
  const dir = pointOf(reader, attrs[2], 'IFCDIRECTION');
  if (!outline || depth === null || depth <= 0 || !dir) return;
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len === 0) return;
  const d: Vec3 = [dir[0] / len * depth, dir[1] / len * depth, dir[2] / len * depth];
  const frame = axis3d(reader, attrs[1]);
  if (!frame) return;
  for (const [px, py] of outline) {
    for (const t of [0, 1]) {
      const local: Vec3 = [px + d[0] * t, py + d[1] * t, d[2] * t];
      out.push(applyFrame(frame, local));
    }
  }
}

/** Profile outline in the solid's XY, after the profile's own Position. */
function profileOutline(reader: AnchorEntityReader, profileId: number): Array<[number, number]> | null {
  const profile = reader.entity(profileId);
  if (!profile) return null;
  const type = profile.type.toUpperCase();
  if (type === 'IFCRECTANGLEPROFILEDEF' || type === 'IFCRECTANGLEHOLLOWPROFILEDEF' || type === 'IFCROUNDEDRECTANGLEPROFILEDEF') {
    const xd = num(profile.attributes[3]);
    const yd = num(profile.attributes[4]);
    if (xd === null || yd === null || xd <= 0 || yd <= 0) return null;
    const frame = axis2d(reader, profile.attributes[2]);
    if (!frame) return null;
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
      const x = sx * xd / 2;
      const y = sy * yd / 2;
      return [frame.o[0] + frame.x[0] * x - frame.x[1] * y, frame.o[1] + frame.x[1] * x + frame.x[0] * y];
    });
  }
  if (type === 'IFCARBITRARYCLOSEDPROFILEDEF' || type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
    const curveId = refId(profile.attributes[2]);
    const curve = curveId === null ? null : reader.entity(curveId);
    if (!curve) return null;
    const curveType = curve.type.toUpperCase();
    let raw: unknown[] = [];
    if (curveType === 'IFCPOLYLINE' && Array.isArray(curve.attributes[0])) {
      raw = curve.attributes[0].map(p => pointOf(reader, p));
    } else if (curveType === 'IFCINDEXEDPOLYCURVE') {
      const listId = refId(curve.attributes[0]);
      const list = listId === null ? null : reader.entity(listId)?.attributes[0];
      if (Array.isArray(list)) raw = list;
    }
    const points = raw.map(vec3);
    if (points.some(p => p === null)) return null;
    const pts = points.map((p): [number, number] => [p![0], p![1]]);
    return pts.length >= 3 ? pts : null;
  }
  return null;
}
