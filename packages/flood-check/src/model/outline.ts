/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one module that reads geometry from representation entities, without
 * meshing. Every exported reader returns what it read TOGETHER with how many
 * items were present and how many of them were readable ({@link Reading}),
 * and reads every item, never only the first: a multi-item representation
 * yields all readable items, and a caller can tell "nothing there"
 * (`items === 0`) from "partly read" (`0 < readable < items`) and "unreadable"
 * (`readable === 0 < items`). No reader returns geometry without that record.
 *
 * Readable: extrusions of rectangle and arbitrary closed profiles, polylines
 * and indexed poly-curves (arcs through their stored points); a Boolean
 * DIFFERENCE or INTERSECTION is bounded by its first operand (flagged
 * `subtracted`), a UNION is unreadable. Everything else (B-reps, mapped items,
 * composite curves) counts as an unreadable item.
 */

import { applyFrame, axisPlacementFrame, IDENTITY, type Frame, type Vec3 } from './placement.js';
import { asEnum, asNumber, asRef, asRefList, asString, type ModelReader } from './reader.js';

type Pt2 = [number, number];

function pointList(reader: ModelReader, id: number | null): Pt2[] | null {
  const e = reader.entity(id);
  if (!e) return null;
  if (e.type === 'IFCCARTESIANPOINTLIST2D' || e.type === 'IFCCARTESIANPOINTLIST3D') {
    const list = e.attributes[0];
    if (!Array.isArray(list)) return null;
    const out: Pt2[] = [];
    for (const row of list) {
      if (!Array.isArray(row)) return null;
      const x = asNumber(row[0]);
      const y = asNumber(row[1]);
      if (x === null || y === null) return null;
      out.push([x, y]);
    }
    return out;
  }
  return null;
}

/** Points of a planar bounded curve in its own coordinates; null when it cannot be read. */
/** Per-item primitive (one curve: points, or null when that item cannot be read); production callers use the readers below. */
export function curvePoints(reader: ModelReader, id: number | null): Pt2[] | null {
  const e = reader.entity(id);
  if (!e) return null;
  if (e.type === 'IFCPOLYLINE') {
    const out: Pt2[] = [];
    for (const pid of asRefList(e.attributes[0])) {
      const p = reader.entity(pid);
      const c = p && Array.isArray(p.attributes[0]) ? p.attributes[0].map(asNumber) : null;
      if (!c || c[0] === null || c[1] === null) return null;
      out.push([c[0] as number, c[1] as number]);
    }
    return out.length >= 2 ? out : null;
  }
  if (e.type === 'IFCINDEXEDPOLYCURVE') {
    const pts = pointList(reader, asRef(e.attributes[0]));
    if (!pts || pts.length < 2) return null;
    const segments = e.attributes[1];
    if (segments === null || segments === undefined) return pts; // no Segments: the points in list order
    // Segments name the points of the curve and their order (1-based; a line, or an arc through three points, which adds
    // the circle's axis-aligned extremes lying on it so the curve's extent is exact). A point the segments omit is not on
    // the curve, and a malformed segment makes the whole outline unreadable.
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const out: Pt2[] = [];
    let last = -1;
    for (const seg of segments) {
      const indices = Array.isArray(seg) && typeof seg[0] === 'string' && Array.isArray(seg[1]) ? seg[1] : null;
      if (!indices || indices.length < 2) return null;
      if (indices.some((i) => typeof i !== 'number' || !Number.isInteger(i) || i < 1 || i > pts.length)) return null;
      const arc = seg[0] === 'IFCARCINDEX';
      if (arc && indices.length !== 3) return null;
      if (last !== indices[0]) out.push(pts[indices[0] - 1]);
      const rest = arc ? arcPoints(pts[indices[0] - 1], pts[indices[1] - 1], pts[indices[2] - 1]) : indices.slice(1).map((i: number) => pts[i - 1]);
      for (const p of rest) {
        const prev = out[out.length - 1];
        if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
      }
      last = indices[indices.length - 1];
    }
    return out.length >= 2 ? out : null;
  }
  return null;
}

/**
 * The points of an arc from `a` through `b` to `c`, after `a`: `b`, `c`, and
 * every axis-aligned extreme of their circle that lies on the arc, in order
 * along it. Three collinear points are a straight line (`b`, `c`).
 */
function arcPoints(a: Pt2, b: Pt2, c: Pt2): Pt2[] {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return [b, c];
  const sq = (p: Pt2) => p[0] * p[0] + p[1] * p[1];
  const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - ux, a[1] - uy);
  const ang = (p: Pt2) => Math.atan2(p[1] - uy, p[0] - ux);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ta = ang(a);
  const ccw = norm(ang(b) - ta) < norm(ang(c) - ta);
  const along = (t: number) => (ccw ? norm(t - ta) : norm(ta - t));
  const sweep = along(ang(c));
  const out: Array<[number, Pt2]> = [[along(ang(b)), b], [sweep, c]];
  for (const e of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const off = along(e);
    if (off > 1e-9 && off < sweep - 1e-9) out.push([off, [ux + r * Math.cos(e), uy + r * Math.sin(e)]]);
  }
  return out.sort((x, y) => x[0] - y[0]).map(([, p]) => p);
}

/** Outer boundary of a profile definition, in the profile's own 2D coordinates. */
function profilePoints(reader: ModelReader, id: number | null): Pt2[] | null {
  const e = reader.entity(id);
  if (!e) return null;
  if (e.type === 'IFCARBITRARYCLOSEDPROFILEDEF' || e.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS') {
    return curvePoints(reader, asRef(reader.attr(e, 'OuterCurve')));
  }
  if (e.type === 'IFCRECTANGLEPROFILEDEF') {
    const x = asNumber(reader.attr(e, 'XDim'));
    const y = asNumber(reader.attr(e, 'YDim'));
    if (x === null || y === null) return null;
    const frame = axisPlacementFrame(reader, reader.attr(e, 'Position'));
    const corners: Pt2[] = [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];
    if (!frame) return reader.attr(e, 'Position') == null ? corners : null;
    return corners.map(([cx, cy]) => {
      const p = applyFrame(frame, [cx, cy, 0]);
      return [p[0], p[1]];
    });
  }
  return null;
}

/** The items of a product's representation with one of the given identifiers. */
function representationItems(reader: ModelReader, productId: number, identifier: string): number[] {
  const product = reader.entity(productId);
  const shape = reader.entity(asRef(reader.attr(product, 'Representation')));
  if (!shape) return [];
  const items: number[] = [];
  for (const repId of asRefList(reader.attr(shape, 'Representations'))) {
    const rep = reader.entity(repId);
    if (!rep) continue;
    if (asString(reader.attr(rep, 'RepresentationIdentifier')) !== identifier) continue;
    items.push(...asRefList(reader.attr(rep, 'Items')));
  }
  return items;
}

/**
 * Follow IfcBooleanClippingResult / IfcBooleanResult first operands down to
 * the solid they cut. A DIFFERENCE or INTERSECTION lies within its first
 * operand, so that operand bounds it (`subtracted`: the solid is smaller than
 * what is read); a UNION does not (its second operand would be dropped), so it
 * is unreadable (null).
 */
function unwrapClipping(reader: ModelReader, id: number): { solid: number; subtracted: boolean } | null {
  const seen = new Set<number>();
  let current: number | null = id;
  let subtracted = false;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const e = reader.entity(current);
    if (!e) return null;
    if (e.type !== 'IFCBOOLEANCLIPPINGRESULT' && e.type !== 'IFCBOOLEANRESULT') return { solid: current, subtracted };
    if (e.type === 'IFCBOOLEANRESULT' && asEnum(reader.attr(e, 'Operator')) === 'UNION') return null;
    subtracted = true;
    current = asRef(reader.attr(e, 'FirstOperand'));
  }
  return null;
}

/** How many items a representation had, and how many of them were read. */
export interface Reading {
  /** Items present. 0: there is nothing of this kind. */
  items: number;
  /** Of those, the items read. */
  readable: number;
}

export type Completeness = 'none' | 'complete' | 'partial' | 'unreadable';

export function completeness(r: Reading): Completeness {
  if (r.items === 0) return 'none';
  if (r.readable === 0) return 'unreadable';
  return r.readable < r.items ? 'partial' : 'complete';
}

/** A slab's plan outline: one ring per readable item, in object coordinates (raw file units). */
export interface OutlineReading extends Reading {
  rings: Vec3[][];
  /**
   * The rings fill something the slab does not cover: inner boundaries that
   * are not kept (a profile with voids, a `FootPrint` of several curves), or an
   * outline read from the outer operand of a Boolean DIFFERENCE.
   */
  voids: boolean;
}

/**
 * Every ring of a slab's plan outline: its `FootPrint` curves when they can
 * all be read, else every near-horizontal extrusion of its `Body`. Each item
 * read gives its own ring; an item that cannot be read is counted, not dropped.
 */
export function readSlabOutline(reader: ModelReader, slabId: number): OutlineReading {
  const footprint = representationItems(reader, slabId, 'FootPrint');
  const fromFootprint: OutlineReading = { rings: [], items: footprint.length, readable: 0, voids: footprint.length > 1 };
  for (const item of footprint) {
    const pts = curvePoints(reader, item);
    if (!pts || pts.length < 3) continue;
    fromFootprint.rings.push(pts.map(([x, y]) => [x, y, 0]));
    fromFootprint.readable++;
  }
  if (footprint.length > 0 && completeness(fromFootprint) === 'complete') return fromFootprint;
  const body = representationItems(reader, slabId, 'Body');
  const fromBody: OutlineReading = { rings: [], items: body.length, readable: 0, voids: false };
  for (const item of body) {
    const unwrapped = unwrapClipping(reader, item);
    const solid = reader.entity(unwrapped?.solid);
    if (!unwrapped || !solid || solid.type !== 'IFCEXTRUDEDAREASOLID') continue;
    const profileId = asRef(reader.attr(solid, 'SweptArea'));
    const profile = profilePoints(reader, profileId);
    if (!profile || profile.length < 3) continue;
    const position = reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
    // A profile only stands for the plan outline when it lies in a horizontal plane.
    if (!position || Math.abs(position.z[2]) < 0.99) continue;
    fromBody.rings.push(profile.map(([x, y]) => applyFrame(position, [x, y, 0])));
    fromBody.readable++;
    const profileEntity = reader.entity(profileId);
    const inner = profileEntity?.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS' ? reader.attr(profileEntity, 'InnerCurves') : null;
    if (unwrapped.subtracted || (Array.isArray(inner) && inner.length > 0)) fromBody.voids = true;
  }
  // The body when it was read in full, or when the footprint gave nothing better; else the partly read footprint.
  if (completeness(fromBody) === 'complete' || footprint.length === 0 || fromBody.readable > fromFootprint.readable) return fromBody;
  return fromFootprint;
}

/** A wall's `Axis`: one polyline per readable curve, in object coordinates (raw file units). */
export interface AxisReading extends Reading {
  lines: Vec3[][];
}

export function readWallAxis(reader: ModelReader, wallId: number): AxisReading {
  const items = representationItems(reader, wallId, 'Axis');
  const out: AxisReading = { lines: [], items: items.length, readable: 0 };
  for (const item of items) {
    const pts = curvePoints(reader, item);
    if (!pts || pts.length < 2) continue;
    out.lines.push(pts.map(([x, y]) => [x, y, 0]));
    out.readable++;
  }
  return out;
}

/** Points given in a product's object coordinates, carried to its world frame. */
export function toWorld(frame: Frame, points: readonly Vec3[]): Vec3[] {
  return points.map((p) => applyFrame(frame, p));
}

/** Representations that carry no solid: they say nothing about where a body ends. */
const NON_SOLID = new Set(['Axis', 'FootPrint', 'Profile', 'Annotation', 'Reference', 'CoG', 'Clearance', 'Lighting', 'Box', 'Surface']);

/** What could be read of a product's body: items of its solid representations (`Body`, or one with no identifier). */
export interface BodyReading extends Reading {
  /** Corners of the readable items, top and bottom, in the product's object coordinates. */
  corners: Vec3[];
}

/**
 * Every solid item of a product, counted whether or not it can be read, so
 * "no body" (`items === 0`), "partly readable" and "wholly unreadable"
 * (`items > 0`, `readable === 0`) stay apart. A Boolean UNION is unreadable
 * (only its first operand would be read); a DIFFERENCE or INTERSECTION is
 * bounded by its first operand.
 */
export function readBody(reader: ModelReader, productId: number): BodyReading {
  const product = reader.entity(productId);
  const shape = reader.entity(asRef(reader.attr(product, 'Representation')));
  const out: BodyReading = { items: 0, readable: 0, corners: [] };
  if (!shape) return out;
  for (const repId of asRefList(reader.attr(shape, 'Representations'))) {
    const rep = reader.entity(repId);
    const identifier = rep ? asString(reader.attr(rep, 'RepresentationIdentifier')) : null;
    if (!rep || (identifier !== null && NON_SOLID.has(identifier))) continue;
    for (const item of asRefList(reader.attr(rep, 'Items'))) {
      out.items++;
      const before = out.corners.length;
      readExtrusion(reader, item, out.corners);
      if (out.corners.length > before) out.readable++;
    }
  }
  return out;
}

function readExtrusion(reader: ModelReader, item: number, out: Vec3[]): void {
  // A DIFFERENCE's first operand bounds the solid from outside: its lowest point is no higher than the solid's.
  const solid = reader.entity(unwrapClipping(reader, item)?.solid);
  if (!solid || solid.type !== 'IFCEXTRUDEDAREASOLID') return;
  const profile = profilePoints(reader, asRef(reader.attr(solid, 'SweptArea')));
  const depth = asNumber(reader.attr(solid, 'Depth'));
  const dirEntity = reader.entity(asRef(reader.attr(solid, 'ExtrudedDirection')));
  const ratios = dirEntity && Array.isArray(dirEntity.attributes[0]) ? dirEntity.attributes[0].map(asNumber) : null;
  if (!profile || depth === null || !ratios || ratios.some((v) => v === null)) return;
  const n = Math.hypot(...(ratios as number[]));
  if (!(n > 0)) return;
  const dir: Vec3 = [(ratios[0] as number) / n, (ratios[1] as number) / n, ((ratios[2] as number | undefined) ?? 0) / n];
  const position = reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
  if (!position) return;
  for (const [x, y] of profile) {
    out.push(applyFrame(position, [x, y, 0]));
    out.push(applyFrame(position, [x + dir[0] * depth, y + dir[1] * depth, dir[2] * depth]));
  }
}
