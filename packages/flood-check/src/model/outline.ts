/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plan outlines read straight from representation entities, without meshing:
 * a slab's `FootPrint` curve or the swept profile of its `Body` extrusion, and
 * a wall's `Axis` curve. Arcs in indexed poly-curves are taken through their
 * stored points (chord approximation), which is fine at footprint scale.
 * Anything else (B-reps, mapped items, composite curves) yields null and the
 * caller falls back.
 */

import { applyFrame, axisPlacementFrame, IDENTITY, type Frame, type Vec3 } from './placement.js';
import { asNumber, asRef, asRefList, asString, type ModelReader } from './reader.js';

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

/** Points of a planar bounded curve in its own coordinates. */
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
    return pts && pts.length >= 2 ? pts : null;
  }
  return null;
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

/** Follow IfcBooleanClippingResult first operands down to the solid they clip. */
function unwrapClipping(reader: ModelReader, id: number): number | null {
  const seen = new Set<number>();
  let current: number | null = id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const e = reader.entity(current);
    if (!e) return null;
    if (e.type !== 'IFCBOOLEANCLIPPINGRESULT' && e.type !== 'IFCBOOLEANRESULT') return current;
    current = asRef(reader.attr(e, 'FirstOperand'));
  }
  return null;
}

/**
 * A slab's plan outline in object coordinates (raw file units): its
 * `FootPrint` curve if present, else the profile of a near-vertical `Body`
 * extrusion. Null when neither can be read.
 */
export function slabOutline(reader: ModelReader, slabId: number): Vec3[] | null {
  for (const item of representationItems(reader, slabId, 'FootPrint')) {
    const pts = curvePoints(reader, item);
    if (pts && pts.length >= 3) return pts.map(([x, y]) => [x, y, 0]);
  }
  for (const item of representationItems(reader, slabId, 'Body')) {
    const solidId = unwrapClipping(reader, item);
    const solid = reader.entity(solidId);
    if (!solid || solid.type !== 'IFCEXTRUDEDAREASOLID') continue;
    const profile = profilePoints(reader, asRef(reader.attr(solid, 'SweptArea')));
    if (!profile || profile.length < 3) continue;
    const position = reader.attr(solid, 'Position') == null
      ? IDENTITY
      : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
    if (!position) continue;
    // A profile only stands for the plan outline when it lies in a horizontal plane.
    if (Math.abs(position.z[2]) < 0.99) continue;
    return profile.map(([x, y]) => applyFrame(position, [x, y, 0]));
  }
  return null;
}

/**
 * Whether the slab's outline has inner boundaries that {@link slabOutline}
 * drops: an `IfcArbitraryProfileDefWithVoids` body profile with inner curves,
 * or a `FootPrint` with more than one curve. The outline then fills the
 * courtyards those voids stand for.
 */
export function slabOutlineHasVoids(reader: ModelReader, slabId: number): boolean {
  let footprintCurves = 0;
  for (const item of representationItems(reader, slabId, 'FootPrint')) {
    const pts = curvePoints(reader, item);
    if (pts && pts.length >= 3) footprintCurves++;
  }
  if (footprintCurves > 1) return true;
  for (const item of representationItems(reader, slabId, 'Body')) {
    const solid = reader.entity(unwrapClipping(reader, item));
    if (!solid || solid.type !== 'IFCEXTRUDEDAREASOLID') continue;
    const profile = reader.entity(asRef(reader.attr(solid, 'SweptArea')));
    if (profile?.type !== 'IFCARBITRARYPROFILEDEFWITHVOIDS') continue;
    const inner = reader.attr(profile, 'InnerCurves');
    if (Array.isArray(inner) && inner.length > 0) return true;
  }
  return false;
}

/** A wall's `Axis` curve points in object coordinates (raw file units). */
export function wallAxis(reader: ModelReader, wallId: number): Vec3[] | null {
  for (const item of representationItems(reader, wallId, 'Axis')) {
    const pts = curvePoints(reader, item);
    if (pts) return pts.map(([x, y]) => [x, y, 0]);
  }
  return null;
}

/** Points given in a product's object coordinates, carried to its world frame. */
export function toWorld(frame: Frame, points: readonly Vec3[]): Vec3[] {
  return points.map((p) => applyFrame(frame, p));
}

/**
 * Corner points of every extruded `Body` item of a product, top and bottom,
 * in the product's object coordinates. Null when no item is a readable
 * extrusion. Used for openings, whose placement often sits at the host's
 * origin while the hole itself is placed by its extrusion.
 */
export function extrusionCorners(reader: ModelReader, productId: number): Vec3[] | null {
  const out: Vec3[] = [];
  for (const item of representationItems(reader, productId, 'Body')) {
    const solid = reader.entity(unwrapClipping(reader, item));
    if (!solid || solid.type !== 'IFCEXTRUDEDAREASOLID') continue;
    const profile = profilePoints(reader, asRef(reader.attr(solid, 'SweptArea')));
    const depth = asNumber(reader.attr(solid, 'Depth'));
    const dirEntity = reader.entity(asRef(reader.attr(solid, 'ExtrudedDirection')));
    const ratios = dirEntity && Array.isArray(dirEntity.attributes[0]) ? dirEntity.attributes[0].map(asNumber) : null;
    if (!profile || depth === null || !ratios || ratios.some((v) => v === null)) continue;
    const n = Math.hypot(...(ratios as number[]));
    if (!(n > 0)) continue;
    const dir: Vec3 = [(ratios[0] as number) / n, (ratios[1] as number) / n, ((ratios[2] as number | undefined) ?? 0) / n];
    const position = reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
    if (!position) continue;
    for (const [x, y] of profile) {
      out.push(applyFrame(position, [x, y, 0]));
      out.push(applyFrame(position, [x + dir[0] * depth, y + dir[1] * depth, dir[2] * depth]));
    }
  }
  return out.length > 0 ? out : null;
}
