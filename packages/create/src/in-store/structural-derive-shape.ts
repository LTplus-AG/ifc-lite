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

/** An asymmetric I's validated dimensions (IfcAsymmetricIShapeProfileDef). */
type AsymmetricI = { bottom: number; top: number; depth: number; web: number; bottomThickness: number; topThickness: number };

/**
 * An asymmetric I's dimensions, or null when it is not idealised: a missing or non-positive width, thickness or
 * web, or a depth that leaves the web no height. The geometry reader refuses only the last; derive also refuses
 * a section with no web or flange, which has no centroid worth an axis. An omitted TopFlangeThickness is the
 * bottom one (schema rule WR3), a present but unreadable one is refused. Bounds and centroid both read this,
 * so they cannot disagree on validity.
 */
function asymmetricIDimensions(a: readonly unknown[]): AsymmetricI | null {
  const [bottom, depth, web, bottomThickness, top] = [3, 4, 5, 6, 8].map((i) => num(a[i]));
  const topThickness = a[9] === null || a[9] === undefined ? bottomThickness : num(a[9]);
  if (bottom === null || depth === null || web === null || bottomThickness === null || top === null || topThickness === null) return null;
  const positive = [bottom, top, web, bottomThickness, topThickness].every((v) => v > 0);
  return positive && depth > bottomThickness + topThickness ? { bottom, top, depth, web, bottomThickness, topThickness } : null;
}

/** An asymmetric I's bounds: the wider flange by the overall depth, as the geometry reader draws it. */
function asymmetricI(a: readonly unknown[]): { size: [unknown, unknown]; exact: boolean } {
  const d = asymmetricIDimensions(a);
  return { size: d ? [Math.max(d.bottom, d.top), d.depth] : [null, null], exact: false };
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
  IFCASYMMETRICISHAPEPROFILEDEF: (a) => asymmetricI(a),
  IFCLSHAPEPROFILEDEF: (a) => ({ size: [a[4] ?? a[3], a[3]], exact: false }),
  IFCTSHAPEPROFILEDEF: (a) => ({ size: [a[4], a[3]], exact: false }),
  IFCUSHAPEPROFILEDEF: (a) => ({ size: [a[4], a[3]], exact: false }),
  IFCCSHAPEPROFILEDEF: (a) => ({ size: [a[4], a[3]], exact: false }),
};

/**
 * Where each profile type states its IFC2X3 `CentreOfGravityInX/Y` (#10377): the attribute count of its IFC2X3 layout
 * and the slot per axis. Read at that arity only: IFC4 deleted the attribute, and reused the asymmetric I's slot for
 * BottomFlangeEdgeRadius. The IFC2x3 TC1 definition of every one of these types measures it "from the center of the
 * bounding box" (the profile origin since IFC2x Edition 3). Only AxisVM's L is known to state a positive one; T, U, C
 * and the asymmetric I rest on the TC1 text.
 */
const STATED_CENTRE: Record<string, { arity: number; x?: number; y?: number }> = {
  IFCLSHAPEPROFILEDEF: { arity: 11, x: 9, y: 10 },
  IFCTSHAPEPROFILEDEF: { arity: 13, y: 12 },
  IFCUSHAPEPROFILEDEF: { arity: 11, x: 10 },
  IFCCSHAPEPROFILEDEF: { arity: 9, x: 8 },
  IFCASYMMETRICISHAPEPROFILEDEF: { arity: 12, y: 11 },
};

/**
 * The offset along one axis from a stated centre of gravity, which carries the fillets the sharp-cornered shape lacks,
 * or the computed one. EXPRESS types the value as a positive length; AxisVM's L agrees with the TC1 reading
 * (IfcOpenShell puts the centroid of its 75 x 75 x 6 angle with fillets 17.085 mm off; the file states 17.07184). So it
 * is used only when its magnitude is within 10% of the computed offset, and with the computed sign: TC1 fixes -y for
 * the asymmetric I because it assumes the wider flange at the bottom, which a wider top flange reverses.
 */
function statedOffset(a: readonly unknown[], slot: number | undefined, computed: number, halfExtent: number): number {
  const value = slot === undefined ? null : num(a[slot]);
  const offset = Math.abs(computed);
  // Measured from the near outer fibre instead (an L leg or T flange face, a U or C web back, an asymmetric I's wider
  // flange face), the same centroid is `halfExtent - offset` away. Near the quarter point the two readings are within
  // 20%, so a stated value cannot say which one it is: keep the computed offset. From the far fibre it is
  // `halfExtent + offset`, never within 10%.
  if (value === null || value <= 0 || Math.abs(halfExtent - offset - offset) <= 0.2 * offset) return computed;
  return Math.abs(value - offset) <= 0.1 * offset ? Math.sign(computed) * value : computed;
}

/** A rectangle of a compound profile: its centre in the profile frame and its area. */
type Part = [cx: number, cy: number, w: number, h: number];

/**
 * Where the centroid of an asymmetric steel section lies from the centre of its bounds, in the
 * profile's own frame (x along the width, y along the depth), from its sharp-cornered shape (fillets
 * move it by well under a millimetre). Orientations follow the IFC profile definitions: an L has its
 * legs left and bottom, a T its flange on top, a U and C their web on the left. An asymmetric I has its
 * bottom flange at the bottom because the viewer's profile reader (`rust/geometry/src/profiles/shapes.rs`)
 * draws it so; no authoring file states it (unproven). An omitted TopFlangeThickness is the bottom one
 * (schema rule WR3). Null for a section whose centroid is its bounds centre or that is not read.
 */
function sectionCentroidOffset(type: string, a: readonly unknown[], x: number, y: number): Flat | null {
  const [p3, p4, p5, p6] = [num(a[3]), num(a[4]), num(a[5]), num(a[6])];
  const parts = ((): Part[] | null => {
    // An omitted Width is the Depth (IFC2X3), as the bounds already read it.
    if (type === 'IFCLSHAPEPROFILEDEF' && p3 !== null && p5 !== null) {
      const w = p4 ?? p3;
      return [[0, -p3 / 2 + p5 / 2, w, p5], [-w / 2 + p5 / 2, p5 / 2, p5, p3 - p5]];
    }
    if (type === 'IFCTSHAPEPROFILEDEF' && p3 !== null && p4 !== null && p5 !== null && p6 !== null) {
      return [[0, p3 / 2 - p6 / 2, p4, p6], [0, -p6 / 2, p5, p3 - p6]];
    }
    if (type === 'IFCUSHAPEPROFILEDEF' && p3 !== null && p4 !== null && p5 !== null && p6 !== null) {
      const flange = (y0: number): Part => [p5 / 2, y0, p4 - p5, p6];
      return [[-p4 / 2 + p5 / 2, 0, p5, p3], flange(p3 / 2 - p6 / 2), flange(-p3 / 2 + p6 / 2)];
    }
    if (type === 'IFCCSHAPEPROFILEDEF' && p3 !== null && p4 !== null && p5 !== null && p6 !== null && p6 > p5) {
      const flange = (y0: number): Part => [p5 / 2, y0, p4 - p5, p5];
      const lip = (sign: number): Part => [p4 / 2 - p5 / 2, sign * (p3 / 2 - p5 - (p6 - p5) / 2), p5, p6 - p5];
      return [[-p4 / 2 + p5 / 2, 0, p5, p3], flange(p3 / 2 - p5 / 2), flange(-p3 / 2 + p5 / 2), lip(1), lip(-1)];
    }
    const i = type === 'IFCASYMMETRICISHAPEPROFILEDEF' ? asymmetricIDimensions(a) : null;
    if (i) {
      return [[0, -i.depth / 2 + i.bottomThickness / 2, i.bottom, i.bottomThickness], [0, (i.bottomThickness - i.topThickness) / 2, i.web, i.depth - i.bottomThickness - i.topThickness], [0, i.depth / 2 - i.topThickness / 2, i.top, i.topThickness]];
    }
    return null;
  })();
  if (!parts || parts.some(([, , w, h]) => !(w > 0) || !(h > 0)) || !(x > 0) || !(y > 0)) return null;
  const area = parts.reduce((sum, [, , w, h]) => sum + w * h, 0);
  const offset: Flat = [parts.reduce((sum, [cx, , w, h]) => sum + cx * w * h, 0) / area, parts.reduce((sum, [, cy, w, h]) => sum + cy * w * h, 0) / area];
  const stated = STATED_CENTRE[type];
  if (stated?.arity !== a.length) return offset;
  return [statedOffset(a, stated.x, offset[0], x / 2), statedOffset(a, stated.y, offset[1], y / 2)];
}

/** A closed ring's points from a polyline, composite or indexed poly curve; a reason when the curve is not read. */
function curveRing(reader: GeometryEntityReader, curve: Entity | null): Flat[] | string {
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
  return Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9 ? points.slice(0, -1) : points;
}

/** Area and first moments of a shape: the area, and area times centroid in x and y. */
type Moments = { area: number; cx: number; cy: number };

/** Signed area and first moments of a simple polygon (shoelace); area 0 for a line. */
function ringMoments(ring: readonly Flat[]): Moments {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += cross / 2;
    cx += (ring[j][0] + ring[i][0]) * cross / 6;
    cy += (ring[j][1] + ring[i][1]) * cross / 6;
  }
  return { area, cx, cy };
}

/** The area centroid of a ring; undefined for a zero-area ring. */
function ringCentroid(ring: readonly Flat[]): Flat | undefined {
  const { area, cx, cy } = ringMoments(ring);
  return Math.abs(area) > 1e-12 ? [cx / area, cy / area] : undefined;
}

/** The moments of a void curve: a polygonal ring, or an `IfcCircle` (its disc); null when it is not read. */
function voidMoments(reader: GeometryEntityReader, curve: Entity | null): Moments | null {
  if (upper(curve) === 'IFCCIRCLE') {
    const position = axis2d(reader, curve!.attributes[0]);
    const radius = num(curve!.attributes[1]);
    if (!position || radius === null || radius <= 0) return null;
    const area = Math.PI * radius * radius;
    return { area, cx: position.o[0] * area, cy: position.o[1] * area };
  }
  const ring = curveRing(reader, curve);
  return typeof ring === 'string' ? null : ringMoments(ring);
}

/** The centroid of an outer ring with voids removed. */
function materialCentroid(outer: readonly Flat[], voids: readonly Moments[]): Flat | undefined {
  const o = ringMoments(outer);
  const sign = Math.sign(o.area) || 1;
  let [area, cx, cy] = [o.area, o.cx, o.cy];
  for (const v of voids) {
    // The moments of a void subtract from the outer ring's, whatever its winding.
    const flip = Math.sign(v.area) === sign ? -1 : 1;
    area += flip * v.area; cx += flip * v.cx; cy += flip * v.cy;
  }
  return Math.abs(area) > 1e-12 ? [cx / area, cy / area] : undefined;
}

/** A profile's outline in its own 2D frame, exact or as bounds, and its centroid when that is not the bounds centre. */
function profileOutline(reader: GeometryEntityReader, profile: Entity | null): { points: Flat[]; exact: boolean; centroid?: Flat } | string {
  const type = upper(profile);
  const a = profile?.attributes ?? [];
  if (type === 'IFCARBITRARYCLOSEDPROFILEDEF' || type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
    const outer = curveRing(reader, reader.entity(refId(a[2]) ?? 0));
    if (typeof outer === 'string') return outer;
    // A profile with voids is read by its outer outline (profile voids are not carried), but its
    // material centroid subtracts them. An unreadable void leaves the centroid out, not wrong.
    let centroid: Flat | undefined = ringCentroid(outer);
    if (type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
      const voids = refs(a[3]).map((id) => voidMoments(reader, reader.entity(id)));
      centroid = voids.every((v): v is Moments => v !== null) ? materialCentroid(outer, voids) : undefined;
    }
    return { points: outer, exact: true, ...(centroid ? { centroid } : {}) };
  }
  const parameterised = PARAMETERISED[type]?.(a);
  const [x, y] = parameterised ? parameterised.size.map(num) : [null, null];
  if (x === null || y === null || x <= 0 || y <= 0) {
    return type === 'IFCASYMMETRICISHAPEPROFILEDEF' ? 'asymmetric I profile dimensions are unreadable or inconsistent' : `profile ${profile?.type ?? 'unreadable'} is not supported`;
  }
  const position = axis2d(reader, a[2]);
  if (!position) return 'profile position is unreadable';
  const { o, x: dir } = position;
  const corners: Flat[] = [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];
  const toPlane = ([px, py]: Flat): Flat => [o[0] + dir[0] * px - dir[1] * py, o[1] + dir[1] * px + dir[0] * py];
  const offset = sectionCentroidOffset(type, a, x, y);
  return { points: corners.map(toPlane), exact: parameterised!.exact, ...(offset ? { centroid: toPlane(offset) } : {}) };
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
  const profile = reader.entity(refId(sweptArea) ?? 0);
  const outline = profileOutline(reader, profile);
  if (typeof outline === 'string') return outline;
  const unitDir = dir && unit(dir);
  if (!solidFrame || !unitDir || depth === null || depth <= 0) return 'extrusion is unreadable';
  const frame = composeFrame(placement, composeFrame(found.frame, solidFrame));
  const toWorld = (p: Vec3): Vec3 => scale(applyFrame(frame, p), metres);
  return {
    outline: outline.points.map(([x, y]) => toWorld([x, y, 0])),
    extrusion: sub(toWorld(scale(unitDir, depth)), toWorld([0, 0, 0])),
    outlineExact: outline.exact,
    ...(['IFCARBITRARYPROFILEDEFWITHVOIDS', 'IFCRECTANGLEHOLLOWPROFILEDEF'].includes(upper(profile)) ? { profileHasVoids: true } : {}),
    ...(upper(profile) === 'IFCROUNDEDRECTANGLEPROFILEDEF' ? { outlineRounded: true } : {}),
    ...(outline.centroid ? { centroid: toWorld([outline.centroid[0], outline.centroid[1], 0]) } : {}),
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
