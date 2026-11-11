/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads one element's shape for the structural derivation, in world metres:
 * a straight Axis representation, and the extruded prism of its Body. What
 * this reads and what it refuses is listed in `structural-derive-types.ts`;
 * every refusal returns the reason as `issue`.
 */

import {
  applyFrame, axis2d, axis3d, composeFrame, num, placementInAncestor, pointOf, refId, unit,
  type Frame3, type GeometryEntityReader,
} from './host-geometry-frame.js';
import type { PrismFact, Vec3 } from './structural-derive-types.js';

export interface ElementShape {
  axis?: [Vec3, Vec3];
  prism?: PrismFact;
  issue?: string;
}

type Entity = { type: string; attributes: readonly unknown[] };
type Flat = [number, number];
const IDENTITY: Frame3 = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** Mapped items and boolean operands nest; this bounds the unwrap. */
const MAX_ITEM_DEPTH = 16;

const upper = (e: Entity | null | undefined) => e?.type.toUpperCase() ?? '';
const refs = (value: unknown): number[] => (Array.isArray(value) ? value.map(refId).filter((id): id is number => id !== null) : []);

function anyPoint(reader: GeometryEntityReader, ref: unknown): Vec3 | null {
  return pointOf(reader, ref, 'IFCCARTESIANPOINT', 3) ?? pointOf(reader, ref, 'IFCCARTESIANPOINT', 2);
}

function representations(reader: GeometryEntityReader, product: Entity): Map<string, Entity> {
  const shape = reader.entity(refId(product.attributes[6]) ?? 0);
  const out = new Map<string, Entity>();
  for (const id of refs(shape?.attributes[2])) {
    const rep = reader.entity(id);
    const identifier = typeof rep?.attributes[1] === 'string' ? rep.attributes[1].toUpperCase() : '';
    if (rep && !out.has(identifier)) out.set(identifier, rep);
  }
  return out;
}

/** A straight Axis polyline, in the product's placement frame. */
function readAxis(reader: GeometryEntityReader, rep: Entity | undefined): [Vec3, Vec3] | null {
  const items = refs(rep?.attributes[3]);
  const line = items.length === 1 ? reader.entity(items[0]) : null;
  if (upper(line) !== 'IFCPOLYLINE') return null;
  const points = refs(line!.attributes[0]).map((id) => anyPoint(reader, id));
  if (points.length < 2 || points.some((p) => p === null)) return null;
  const a = points[0]!, b = points[points.length - 1]!;
  const d = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  if (!d) return null;
  const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  for (const p of points) {
    const r: Vec3 = [p![0] - a[0], p![1] - a[1], p![2] - a[2]];
    const t = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
    if (Math.hypot(r[0] - t * d[0], r[1] - t * d[1], r[2] - t * d[2]) > span * 1e-6) return null;
  }
  return [a, b];
}

/** `IfcCartesianTransformationOperator3D` as a rigid frame; scaled or non-uniform operators are refused. */
function operatorFrame(reader: GeometryEntityReader, ref: unknown): Frame3 | string {
  const op = reader.entity(refId(ref) ?? 0);
  if (upper(op) !== 'IFCCARTESIANTRANSFORMATIONOPERATOR3D') return 'mapped item target is not a uniform 3D operator';
  const [axis1, , localOrigin, scaleValue, axis3] = op!.attributes;
  if (scaleValue !== null && scaleValue !== undefined && num(scaleValue) !== 1) return 'mapped item is scaled';
  const o = anyPoint(reader, localOrigin);
  const x0 = axis1 === null || axis1 === undefined ? [1, 0, 0] as Vec3 : pointOf(reader, axis1, 'IFCDIRECTION');
  const z0 = axis3 === null || axis3 === undefined ? [0, 0, 1] as Vec3 : pointOf(reader, axis3, 'IFCDIRECTION');
  const z = z0 && unit(z0);
  const y = z && x0 && unit([z[1] * x0[2] - z[2] * x0[1], z[2] * x0[0] - z[0] * x0[2], z[0] * x0[1] - z[1] * x0[0]]);
  if (!o || !z || !y) return 'mapped item target is unreadable';
  return { o, x: [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]], y, z };
}

/** Unwrap one Body item to its extruded solid and the frame it sits in. */
function extrusionOf(reader: GeometryEntityReader, itemId: number): { solid: Entity; frame: Frame3 } | string {
  let frame = IDENTITY;
  let item = reader.entity(itemId);
  for (let depth = 0; depth < MAX_ITEM_DEPTH; depth++) {
    const type = upper(item);
    if (type === 'IFCEXTRUDEDAREASOLID') return { solid: item!, frame };
    if (type === 'IFCBOOLEANCLIPPINGRESULT' || type === 'IFCBOOLEANRESULT') {
      item = reader.entity(refId(item!.attributes[1]) ?? 0);
      continue;
    }
    if (type !== 'IFCMAPPEDITEM') return `Body is ${item?.type ?? 'unreadable'}, not an extrusion`;
    const source = reader.entity(refId(item!.attributes[0]) ?? 0);
    const target = operatorFrame(reader, item!.attributes[1]);
    if (typeof target === 'string') return target;
    const origin = axis3d(reader, source?.attributes[0]);
    const items = refs(reader.entity(refId(source?.attributes[1]) ?? 0)?.attributes[3]);
    if (!origin || items.length !== 1) return 'mapped representation is unreadable or has several items';
    frame = composeFrame(frame, composeFrame(target, origin));
    item = reader.entity(items[0]);
  }
  return 'Body items nest too deeply';
}

function polylinePoints(reader: GeometryEntityReader, polyline: Entity): Flat[] | null {
  const read = refs(polyline.attributes[0]).map((id) => anyPoint(reader, id));
  return read.every((p) => p !== null) ? read.map((p) => [p![0], p![1]]) : null;
}

/** A straight trimmed line, trimmed by Cartesian points. */
function trimmedLinePoints(reader: GeometryEntityReader, curve: Entity | null): Flat[] | null {
  if (upper(curve) !== 'IFCTRIMMEDCURVE' || upper(reader.entity(refId(curve!.attributes[0]) ?? 0)) !== 'IFCLINE') return null;
  const trim = (value: unknown): Flat | null => {
    for (const ref of Array.isArray(value) ? value : []) {
      const p = anyPoint(reader, ref);
      if (p) return [p[0], p[1]];
    }
    return null;
  };
  const a = trim(curve!.attributes[1]), b = trim(curve!.attributes[2]);
  if (!a || !b) return null;
  return curve!.attributes[3] === false || curve!.attributes[3] === '.F.' ? [b, a] : [a, b];
}

/** A composite curve of polyline and straight trimmed-line segments, joined; any other segment curve is refused. */
function compositePoints(reader: GeometryEntityReader, composite: Entity): Flat[] | null {
  const points: Flat[] = [];
  for (const segmentId of refs(composite.attributes[0])) {
    const segment = reader.entity(segmentId);
    const parent = reader.entity(refId(segment?.attributes[2]) ?? 0);
    if (upper(segment) !== 'IFCCOMPOSITECURVESEGMENT') return null;
    const part = upper(parent) === 'IFCPOLYLINE' ? polylinePoints(reader, parent!) : trimmedLinePoints(reader, parent);
    if (!part) return null;
    if (segment!.attributes[1] === false || segment!.attributes[1] === '.F.') part.reverse();
    for (const p of part) {
      const last = points[points.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) points.push(p);
    }
  }
  return points.length > 0 ? points : null;
}

const box = (x: number, y: number): Flat[] => [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];

/** Bounds-only profiles: [width attribute, depth attribute] indices into the profile record. */
const BOUNDS_PROFILES: Record<string, (a: readonly unknown[]) => [unknown, unknown]> = {
  IFCCIRCLEPROFILEDEF: (a) => [2 * (num(a[3]) ?? NaN), 2 * (num(a[3]) ?? NaN)],
  IFCCIRCLEHOLLOWPROFILEDEF: (a) => [2 * (num(a[3]) ?? NaN), 2 * (num(a[3]) ?? NaN)],
  IFCELLIPSEPROFILEDEF: (a) => [2 * (num(a[3]) ?? NaN), 2 * (num(a[4]) ?? NaN)],
  IFCISHAPEPROFILEDEF: (a) => [a[3], a[4]],
  IFCLSHAPEPROFILEDEF: (a) => [a[4] ?? a[3], a[3]],
  IFCTSHAPEPROFILEDEF: (a) => [a[4], a[3]],
  IFCUSHAPEPROFILEDEF: (a) => [a[4], a[3]],
  IFCCSHAPEPROFILEDEF: (a) => [a[4], a[3]],
};
const RECTANGLES = new Set(['IFCRECTANGLEPROFILEDEF', 'IFCROUNDEDRECTANGLEPROFILEDEF', 'IFCRECTANGLEHOLLOWPROFILEDEF']);

/** A profile's outline in its own 2D frame, exact or as bounds. */
function profileOutline(reader: GeometryEntityReader, profile: Entity | null): { points: Flat[]; exact: boolean } | string {
  const type = upper(profile);
  const a = profile?.attributes ?? [];
  if (type === 'IFCARBITRARYCLOSEDPROFILEDEF' || type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
    const curve = reader.entity(refId(a[2]) ?? 0);
    let points: Flat[] | null = null;
    if (upper(curve) === 'IFCPOLYLINE') {
      points = polylinePoints(reader, curve!);
    } else if (upper(curve) === 'IFCCOMPOSITECURVE') {
      points = compositePoints(reader, curve!);
    } else if (upper(curve) === 'IFCINDEXEDPOLYCURVE') {
      if (curve!.attributes[1] != null && JSON.stringify(curve!.attributes[1]).toUpperCase().includes('ARCINDEX')) return 'profile has arc segments';
      const list = reader.entity(refId(curve!.attributes[0]) ?? 0);
      const coords = upper(list) === 'IFCCARTESIANPOINTLIST2D' && Array.isArray(list!.attributes[0]) ? list!.attributes[0] as unknown[] : [];
      points = coords.every((c) => Array.isArray(c) && num(c[0]) !== null && num(c[1]) !== null) ? coords.map((c) => [(c as number[])[0], (c as number[])[1]]) : null;
    }
    if (!points || points.length < 3) return `profile curve ${curve?.type ?? 'unreadable'} is not a polyline`;
    const [first, last] = [points[0], points[points.length - 1]];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) points = points.slice(0, -1);
    return { points, exact: true };
  }
  let size: [unknown, unknown] | null = null;
  if (RECTANGLES.has(type)) size = [a[3], a[4]];
  else if (BOUNDS_PROFILES[type]) size = BOUNDS_PROFILES[type](a);
  const [x, y] = size ? [num(size[0]), num(size[1])] : [null, null];
  if (x === null || y === null || x <= 0 || y <= 0) return `profile ${profile?.type ?? 'unreadable'} is not supported`;
  const position = axis2d(reader, a[2]);
  if (!position) return 'profile position is unreadable';
  const { o, x: dir } = position;
  const points = box(x, y).map(([px, py]): Flat => [o[0] + dir[0] * px - dir[1] * py, o[1] + dir[1] * px + dir[0] * py]);
  return { points, exact: RECTANGLES.has(type) };
}

function readPrism(reader: GeometryEntityReader, rep: Entity | undefined, placement: Frame3, metres: number): PrismFact | string {
  if (!rep) return 'no Body representation';
  const items = refs(rep.attributes[3]);
  if (items.length !== 1) return `Body has ${items.length} items`;
  const found = extrusionOf(reader, items[0]);
  if (typeof found === 'string') return found;
  const [sweptArea, position, direction, depthValue] = found.solid.attributes;
  const solidFrame = axis3d(reader, position);
  const dir = pointOf(reader, direction, 'IFCDIRECTION');
  const depth = num(depthValue);
  const outline = profileOutline(reader, reader.entity(refId(sweptArea) ?? 0));
  if (typeof outline === 'string') return outline;
  if (!solidFrame || !dir || depth === null || depth <= 0) return 'extrusion is unreadable';
  const frame = composeFrame(placement, composeFrame(found.frame, solidFrame));
  const toMetres = (p: Vec3): Vec3 => [p[0] * metres, p[1] * metres, p[2] * metres];
  const unitDir = unit(dir);
  if (!unitDir) return 'extrusion direction is zero';
  const top = applyFrame(frame, [unitDir[0] * depth, unitDir[1] * depth, unitDir[2] * depth]);
  return {
    outline: outline.points.map(([x, y]) => toMetres(applyFrame(frame, [x, y, 0]))),
    extrusion: toMetres([top[0] - frame.o[0], top[1] - frame.o[1], top[2] - frame.o[2]]),
    outlineExact: outline.exact,
  };
}

/** Shape facts for one product; `metres` is the file's length-unit scale. */
export function readElementShape(reader: GeometryEntityReader, productId: number, metres: number, withAxis: boolean): ElementShape {
  const product = reader.entity(productId);
  if (!product) return { issue: 'element is unreadable' };
  const placementId = refId(product.attributes[5]);
  const placement = placementId === null ? IDENTITY : placementInAncestor(reader, placementId, null);
  if (!placement) return { issue: 'ObjectPlacement is unreadable' };
  const reps = representations(reader, product);
  const out: ElementShape = {};
  const axis = withAxis ? readAxis(reader, reps.get('AXIS')) : null;
  if (axis) out.axis = axis.map((p) => applyFrame(placement, p).map((v) => v * metres) as Vec3) as [Vec3, Vec3];
  const prism = readPrism(reader, reps.get('BODY'), placement, metres);
  if (typeof prism === 'string') out.issue = prism;
  else out.prism = prism;
  return out;
}
