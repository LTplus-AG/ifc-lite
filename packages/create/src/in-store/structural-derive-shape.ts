/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads one element's shape for the structural derivation, in world metres:
 * a straight Axis representation, and the extruded prism of its Body. What
 * this reads and what it refuses is listed in `structural-derive-types.ts`;
 * every refusal returns the reason as `shapeIssue`.
 */

import { vecLen } from '../ifc-creator-math.js';
import {
  IDENTITY_FRAME3, applyFrame, axis2d, axis3d, composeFrame, num, placementInAncestor, pointOf, refId, unit,
  type Frame3, type GeometryEntityReader,
} from './host-geometry-frame.js';
import { readAxisEnds } from './extract-grids.js';
import { mappedItemFrame } from './resolve-host.js';
import { dot, scale, sub } from './structural-derive-idealise.js';
import type { PrismFact, Vec3 } from './structural-derive-types.js';

interface ElementShape {
  axis?: [Vec3, Vec3];
  prism?: PrismFact;
  shapeIssue?: string;
}

type Entity = { type: string; attributes: readonly unknown[] };
type Flat = [number, number];
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
  const span = vecLen(sub(b, a));
  if (!(span > 0)) return null;
  const d = scale(sub(b, a), 1 / span);
  // Every point on the line, moving forward from start to end: no bend and no backtracking.
  const eps = span * 1e-6;
  let previous = -eps;
  for (const p of points) {
    const r = sub(p!, a);
    const along = dot(r, d);
    if (vecLen(sub(r, scale(d, along))) > eps || along < previous - eps || along > span + eps) return null;
    previous = along;
  }
  return [a, b];
}

/** Unwrap one Body item to its extruded solid and the frame it sits in. */
function extrusionOf(reader: GeometryEntityReader, itemId: number): { solid: Entity; frame: Frame3 } | string {
  let frame = IDENTITY_FRAME3;
  let item = reader.entity(itemId);
  for (let depth = 0; depth < MAX_ITEM_DEPTH; depth++) {
    const type = upper(item);
    if (type === 'IFCEXTRUDEDAREASOLID') return { solid: item!, frame };
    // A difference only removes material, so its first operand carries the axis; a union or intersection does not.
    if (type === 'IFCBOOLEANCLIPPINGRESULT' || (type === 'IFCBOOLEANRESULT' && item!.attributes[0] === '.DIFFERENCE.')) {
      item = reader.entity(refId(item!.attributes[1]) ?? 0);
      continue;
    }
    if (type !== 'IFCMAPPEDITEM') return `Body is ${item?.type ?? 'unreadable'}, not an extrusion`;
    const mapped = mappedItemFrame(reader, item!.attributes);
    if (!mapped) return 'mapped item is unreadable';
    if (mapped.items.length !== 1) return `mapped representation has ${mapped.items.length} items`;
    frame = composeFrame(frame, mapped.frame);
    item = reader.entity(mapped.items[0]);
  }
  return 'Body items nest too deeply';
}

function polylinePoints(reader: GeometryEntityReader, polyline: Entity): Flat[] | null {
  const read = refs(polyline.attributes[0]).map((id) => anyPoint(reader, id));
  return read.every((p) => p !== null) ? read.map((p) => [p![0], p![1]]) : null;
}

/** A composite curve of polyline and straight trimmed-line segments; any other segment is refused. */
function compositePoints(reader: GeometryEntityReader, composite: Entity): Flat[] | null {
  const points: Flat[] = [];
  for (const segmentId of refs(composite.attributes[0])) {
    const segment = reader.entity(segmentId);
    const parentId = refId(segment?.attributes[2]) ?? 0;
    const parent = reader.entity(parentId);
    if (upper(segment) !== 'IFCCOMPOSITECURVESEGMENT') return null;
    const part = upper(parent) === 'IFCPOLYLINE' ? polylinePoints(reader, parent!) : readAxisEnds((id) => reader.entity(id), parentId);
    if (!part) return null;
    if (segment!.attributes[1] === false || segment!.attributes[1] === '.F.') part.reverse();
    for (const p of part) {
      const last = points[points.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) points.push(p);
    }
  }
  return points.length > 0 ? points : null;
}

/**
 * The point order explicit `IfcIndexedPolyCurve.Segments` set: `IfcLineIndex`
 * runs joined end to start (1-based indices), or null when Segments is absent
 * and the point list is the order. Arc segments are refused.
 */
function segmentOrder(segments: unknown, count: number): number[] | null | string {
  if (segments === null || segments === undefined) return null;
  const order: number[] = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    // Source records carry [TYPE, value]; session-authored ones { typed: { type, value } }.
    const typed = Array.isArray(segment) ? { type: segment[0], value: segment[1] }
      : (segment as { typed?: { type?: unknown; value?: unknown } } | null)?.typed;
    if (typeof typed?.type !== 'string' || typed.type.toUpperCase() !== 'IFCLINEINDEX') return 'profile has arc segments';
    const indices = Array.isArray(typed.value) ? typed.value : [];
    if (indices.length < 2 || indices.some((i) => !Number.isInteger(i) || i < 1 || i > count)) return 'profile segment indices are unreadable';
    for (const i of indices as number[]) if (order[order.length - 1] !== i - 1) order.push(i - 1);
  }
  return order.length > 0 ? order : 'profile segment indices are unreadable';
}

/** Parameterised profiles: their [width, depth] bounds, and whether those bounds are the outline. */
const PARAMETERISED: Record<string, (a: readonly unknown[]) => { size: [unknown, unknown]; exact: boolean }> = {
  IFCRECTANGLEPROFILEDEF: (a) => ({ size: [a[3], a[4]], exact: true }),
  IFCROUNDEDRECTANGLEPROFILEDEF: (a) => ({ size: [a[3], a[4]], exact: true }),
  IFCRECTANGLEHOLLOWPROFILEDEF: (a) => ({ size: [a[3], a[4]], exact: true }),
  IFCCIRCLEPROFILEDEF: (a) => ({ size: [2 * (num(a[3]) ?? NaN), 2 * (num(a[3]) ?? NaN)], exact: false }),
  IFCCIRCLEHOLLOWPROFILEDEF: (a) => PARAMETERISED.IFCCIRCLEPROFILEDEF(a),
  IFCELLIPSEPROFILEDEF: (a) => ({ size: [2 * (num(a[3]) ?? NaN), 2 * (num(a[4]) ?? NaN)], exact: false }),
  IFCISHAPEPROFILEDEF: (a) => ({ size: [a[3], a[4]], exact: false }),
  IFCLSHAPEPROFILEDEF: (a) => ({ size: [a[4] ?? a[3], a[3]], exact: false }),
  IFCTSHAPEPROFILEDEF: (a) => ({ size: [a[4], a[3]], exact: false }),
  IFCUSHAPEPROFILEDEF: (a) => ({ size: [a[4], a[3]], exact: false }),
  IFCCSHAPEPROFILEDEF: (a) => ({ size: [a[4], a[3]], exact: false }),
};

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
      const list = reader.entity(refId(curve!.attributes[0]) ?? 0);
      const coords = upper(list) === 'IFCCARTESIANPOINTLIST2D' && Array.isArray(list!.attributes[0]) ? list!.attributes[0] as unknown[] : [];
      const all = coords.every((c) => Array.isArray(c) && num(c[0]) !== null && num(c[1]) !== null) ? coords.map((c): Flat => [(c as number[])[0], (c as number[])[1]]) : null;
      const order = segmentOrder(curve!.attributes[1], all?.length ?? 0);
      if (typeof order === 'string') return order;
      points = all && (order ? order.map((i) => all[i]) : all);
    }
    if (!points || points.length < 3) return `profile curve ${curve?.type ?? 'unreadable'} is not a polyline`;
    const [first, last] = [points[0], points[points.length - 1]];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) points = points.slice(0, -1);
    return { points, exact: true };
  }
  const parameterised = PARAMETERISED[type]?.(a);
  const [x, y] = parameterised ? parameterised.size.map(num) : [null, null];
  if (x === null || y === null || x <= 0 || y <= 0) return `profile ${profile?.type ?? 'unreadable'} is not supported`;
  const position = axis2d(reader, a[2]);
  if (!position) return 'profile position is unreadable';
  const { o, x: dir } = position;
  const corners: Flat[] = [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];
  const points = corners.map(([px, py]): Flat => [o[0] + dir[0] * px - dir[1] * py, o[1] + dir[1] * px + dir[0] * py]);
  return { points, exact: parameterised!.exact };
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
  const unitDir = dir && unit(dir);
  if (!solidFrame || !unitDir || depth === null || depth <= 0) return 'extrusion is unreadable';
  const frame = composeFrame(placement, composeFrame(found.frame, solidFrame));
  const toWorld = (p: Vec3): Vec3 => scale(applyFrame(frame, p), metres);
  return {
    outline: outline.points.map(([x, y]) => toWorld([x, y, 0])),
    extrusion: sub(toWorld(scale(unitDir, depth)), toWorld([0, 0, 0])),
    outlineExact: outline.exact,
  };
}

/** Shape facts for one product; `metres` is the file's length-unit scale. */
export function readElementShape(reader: GeometryEntityReader, productId: number, metres: number, withAxis: boolean): ElementShape {
  const product = reader.entity(productId);
  if (!product) return { shapeIssue: 'element is unreadable' };
  const placementId = refId(product.attributes[5]);
  const placement = placementId === null ? IDENTITY_FRAME3 : placementInAncestor(reader, placementId, null);
  if (!placement) return { shapeIssue: 'ObjectPlacement is unreadable' };
  const reps = representations(reader, product);
  const out: ElementShape = {};
  const axis = withAxis ? readAxis(reader, reps.get('AXIS')) : null;
  if (axis) out.axis = axis.map((p) => scale(applyFrame(placement, p), metres)) as [Vec3, Vec3];
  // RepresentationIdentifier is optional; an unnamed representation counts as Body, as in resolve-host's bodyBounds.
  const prism = readPrism(reader, reps.get('BODY') ?? reps.get(''), placement, metres);
  if (typeof prism === 'string') out.shapeIssue = prism;
  else out.prism = prism;
  return out;
}
