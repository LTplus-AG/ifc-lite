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
 * `subtracted`), a UNION is unreadable. Mapped items are followed through
 * their representation maps; unsupported leaf geometry (B-reps, composite
 * curves) counts as an unreadable item.
 */

import { ringContainsRing } from '../geom.js';
import { MAX_MAPPED_ITEMS, placedItems, type MappedWorkBudget } from './mapped.js';
import { curvePoints, profilePoints } from './curves.js';
import { applyFrame, axisPlacementFrame, composeFrames, IDENTITY, type Frame, type Vec3 } from './placement.js';
import { asEnum, asNumber, asRef, asRefList, asString, type ModelReader } from './reader.js';


export { ARC_MAX_PIECES, ARC_SAGITTA } from './arc.js';
export { curvePoints } from './curves.js';

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
   * The rings fill something the slab does not cover whose shape is not read:
   * a `FootPrint` of several curves, an outline read from the outer operand of
   * a Boolean DIFFERENCE, or an inner curve that cannot be read.
   */
  voids: boolean;
  /**
   * Inner boundaries of the slab's profiles (`IfcArbitraryProfileDefWithVoids`),
   * read, in object coordinates: holes in the plan. Whether one is open ground
   * (a courtyard) or interior (a shaft, a stair opening, a floor area under the
   * building) is decided with the slabs above (`footprint.ts`).
   */
  holes: Vec3[][];
}

/**
 * Every ring of a slab's plan outline: its `FootPrint` curves when they can
 * all be read, else every near-horizontal extrusion of its `Body`. Each item
 * read gives its own ring; an item that cannot be read is counted, not dropped.
 */
export function readSlabOutline(reader: ModelReader, slabId: number): OutlineReading {
  const budget: MappedWorkBudget = { remaining: MAX_MAPPED_ITEMS };
  const footprint = representationItems(reader, slabId, 'FootPrint').flatMap((top) => placedItems(reader, top, IDENTITY, 0, new Set(), budget));
  const fromFootprint: OutlineReading = { rings: [], items: footprint.length, readable: 0, voids: footprint.length > 1, holes: [] };
  for (const { item, frame } of footprint) {
    const pts = frame ? curvePoints(reader, item) : null;
    if (!pts || pts.length < 3) continue;
    fromFootprint.rings.push(pts.map(([x, y]) => applyFrame(frame!, [x, y, 0])));
    fromFootprint.readable++;
  }
  const body = representationItems(reader, slabId, 'Body').flatMap((top) => placedItems(reader, top, IDENTITY, 0, new Set(), budget));
  if (footprint.length > 0 && completeness(fromFootprint) === 'complete') {
    // The FootPrint gives the outer curves only; the Body's holes (inner curves read, or a Boolean cut whose shape is not)
    // still count, never a complete outline with a filled courtyard.
    for (const { item, frame } of body) {
      const h = frame ? bodyHoles(reader, item, frame) : { holes: [], unknown: true };
      if (h.unknown) fromFootprint.voids = true;
      fromFootprint.holes.push(...h.holes);
    }
    return fromFootprint;
  }
  const fromBody: OutlineReading = { rings: [], items: body.length, readable: 0, voids: false, holes: [] };
  for (const { item, frame } of body) {
    const unwrapped = frame ? unwrapClipping(reader, item) : null;
    const solid = reader.entity(unwrapped?.solid);
    if (!unwrapped || !solid || solid.type !== 'IFCEXTRUDEDAREASOLID') continue;
    const profileId = asRef(reader.attr(solid, 'SweptArea'));
    const profile = profilePoints(reader, profileId);
    if (!profile || profile.length < 3) continue;
    const position = reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
    const placed = position && composeFrames(frame!, position);
    // Check the composed frame: a mapped item's target can tilt a locally horizontal extrusion.
    if (!placed || Math.abs(placed.z[2]) < 0.99) continue;
    const direction = extrusionDirection(reader, solid.expressId);
    if (!direction) continue;
    const worldDirection = [0, 1, 2].map((axis) => placed.x[axis]! * direction[0] + placed.y[axis]! * direction[1] + placed.z[axis]! * direction[2]);
    if (Math.hypot(worldDirection[0]!, worldDirection[1]!) > 1e-6 * Math.hypot(...worldDirection)) continue;
    fromBody.rings.push(profile.map(([x, y]) => applyFrame(placed, [x, y, 0])));
    fromBody.readable++;
    const h = bodyHoles(reader, item, frame!);
    if (h.unknown) fromBody.voids = true;
    fromBody.holes.push(...h.holes);
  }
  // The body when it was read in full, or when the footprint gave nothing better; else the partly read footprint.
  if (completeness(fromBody) === 'complete' || footprint.length === 0 || fromBody.readable > fromFootprint.readable) return fromBody;
  return fromFootprint;
}

/**
 * A Body item's holes in plan: the inner curves of its profile, read and
 * placed like its outer curve; `unknown` when it has holes whose shape is not
 * read (a Boolean DIFFERENCE's second operand, or an inner curve that cannot be
 * read).
 */
function bodyHoles(reader: ModelReader, item: number, placed: Frame = IDENTITY): { holes: Vec3[][]; unknown: boolean } {
  const unwrapped = unwrapClipping(reader, item);
  if (!unwrapped) return { holes: [], unknown: false };
  const solid = reader.entity(unwrapped.solid);
  const profile = solid ? reader.entity(asRef(reader.attr(solid, 'SweptArea'))) : null;
  const inner = profile?.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS' ? asRefList(reader.attr(profile, 'InnerCurves')) : [];
  const localPosition = !solid || reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
  const position = localPosition ? composeFrames(placed, localPosition) : null;
  const holes: Vec3[][] = [];
  let unknown = false;
  for (const c of inner) {
    const pts = position ? curvePoints(reader, c) : null;
    if (!pts || pts.length < 3) unknown = true;
    else holes.push(pts.map(([x, y]) => applyFrame(position!, [x, y, 0])));
  }
  if (!unwrapped.subtracted) return { holes, unknown };
  // Boolean cuts: a DIFFERENCE whose second operand is a vertical prism cutting through the slab's whole thickness, wholly
  // inside its outline, is a hole in plan; one that leaves slab material under it (a recess) is none; anything else (a
  // notch at the edge, a half space or clipping, an intersection, an operand not read) is a hole whose shape is not read.
  const base = verticalPrism(reader, unwrapped.solid, placed);
  const seen = new Set<number>();
  for (let e = reader.entity(item); e && (e.type === 'IFCBOOLEANRESULT' || e.type === 'IFCBOOLEANCLIPPINGRESULT') && !seen.has(e.expressId); e = reader.entity(asRef(reader.attr(e, 'FirstOperand')))) {
    seen.add(e.expressId);
    const cut = e.type === 'IFCBOOLEANRESULT' && asEnum(reader.attr(e, 'Operator')) === 'DIFFERENCE' ? verticalPrism(reader, asRef(reader.attr(e, 'SecondOperand')), placed) : null;
    if (!cut || !base) {
      unknown = true;
      continue;
    }
    if (cut.low.some((z) => z > base.zMin + 1e-6) || cut.high.some((z) => z < base.zMax - 1e-6)) {
      unknown = true;
      continue;
    }
    const baseRing = base.plan.map(([x, y]) => ({ x, y }));
    const cutRing = cut.plan.map(([x, y]) => ({ x, y }));
    if (ringContainsRing(cutRing, baseRing)) holes.push(cut.plan);
    else unknown = true;
  }
  return { holes, unknown };
}

/** An extrusion swept straight up or down from a horizontal profile: its plan outline and height range; null otherwise. */
function verticalPrism(reader: ModelReader, id: number | null, outer: Frame = IDENTITY): { plan: Vec3[]; low: number[]; high: number[]; zMin: number; zMax: number } | null {
  const solid = reader.entity(id);
  if (!solid || solid.type !== 'IFCEXTRUDEDAREASOLID') return null;
  const profileId = asRef(reader.attr(solid, 'SweptArea'));
  const profileEntity = reader.entity(profileId);
  // A hollow cutter leaves an island inside its outer boundary. Reading only
  // that boundary as a hole would erase material the Boolean result retains.
  if (profileEntity?.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS' && asRefList(reader.attr(profileEntity, 'InnerCurves')).length > 0) return null;
  const profile = profilePoints(reader, profileId);
  const depth = asNumber(reader.attr(solid, 'Depth'));
  const position = reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
  const direction = extrusionDirection(reader, solid.expressId);
  if (!profile || profile.length < 3 || depth === null || !position || !direction) return null;
  const placed = composeFrames(outer, position);
  const worldDirection = [0, 1, 2].map((axis) => placed.x[axis]! * direction[0] + placed.y[axis]! * direction[1] + placed.z[axis]! * direction[2]);
  if (Math.abs(placed.z[0]) > 1e-6 || Math.abs(placed.z[1]) > 1e-6 || Math.hypot(worldDirection[0]!, worldDirection[1]!) > 1e-6 * Math.hypot(...worldDirection)) return null;
  const plan = profile.map(([x, y]) => applyFrame(placed, [x, y, 0]));
  const highPoints = plan.map((p) => [p[0] + worldDirection[0]! * depth, p[1] + worldDirection[1]! * depth, p[2] + worldDirection[2]! * depth] as Vec3);
  const low = plan.map((p) => Math.min(p[2], p[2] + worldDirection[2]! * depth));
  const high = plan.map((p) => Math.max(p[2], p[2] + worldDirection[2]! * depth));
  const zMin = Math.min(...plan.map((p) => p[2]), ...highPoints.map((p) => p[2]));
  const zMax = Math.max(...plan.map((p) => p[2]), ...highPoints.map((p) => p[2]));
  return { plan, low, high, zMin, zMax };
}

/** A wall's `Axis`: one polyline per readable curve, in object coordinates (raw file units). */
export interface AxisReading extends Reading {
  lines: Vec3[][];
}

export function readWallAxis(reader: ModelReader, wallId: number): AxisReading {
  const budget: MappedWorkBudget = { remaining: MAX_MAPPED_ITEMS };
  const items = representationItems(reader, wallId, 'Axis').flatMap((top) => placedItems(reader, top, IDENTITY, 0, new Set(), budget));
  const out: AxisReading = { lines: [], items: items.length, readable: 0 };
  for (const { item, frame } of items) {
    const pts = frame ? curvePoints(reader, item) : null;
    if (!pts || pts.length < 2) continue;
    out.lines.push(pts.map(([x, y]) => applyFrame(frame!, [x, y, 0])));
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
  /**
   * Of the readable items, those read through the first operand of a Boolean
   * DIFFERENCE or clipping: they bound the solid (its lowest point is no
   * higher) but their centre is not the solid's.
   */
  clipped: number;
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
  const out: BodyReading = { items: 0, readable: 0, corners: [], clipped: 0 };
  const budget: MappedWorkBudget = { remaining: MAX_MAPPED_ITEMS };
  if (!shape) return out;
  for (const repId of asRefList(reader.attr(shape, 'Representations'))) {
    const rep = reader.entity(repId);
    const identifier = rep ? asString(reader.attr(rep, 'RepresentationIdentifier')) : null;
    if (!rep || (identifier !== null && NON_SOLID.has(identifier))) continue;
    // Every leaf counts: an ordinary item, or each item of a mapped representation (`mapped.ts`), placed by its map.
    for (const top of asRefList(reader.attr(rep, 'Items'))) {
      for (const { item, frame } of placedItems(reader, top, IDENTITY, 0, new Set(), budget)) {
        out.items++;
        if (!frame) continue;
        const before = out.corners.length;
        const clipped = readExtrusion(reader, item, out.corners, frame);
        if (out.corners.length > before) {
          out.readable++;
          if (clipped) out.clipped++;
        }
      }
    }
  }
  return out;
}

/** Reads one item's corners into `out`; true when they come from a clipped solid's first operand. */
function readExtrusion(reader: ModelReader, item: number, out: Vec3[], placed: Frame = IDENTITY): boolean {
  // A DIFFERENCE's first operand bounds the solid from outside: its lowest point is no higher than the solid's.
  const unwrapped = unwrapClipping(reader, item);
  const solid = reader.entity(unwrapped?.solid);
  if (!solid || solid.type !== 'IFCEXTRUDEDAREASOLID') return false;
  const profile = profilePoints(reader, asRef(reader.attr(solid, 'SweptArea')));
  const depth = asNumber(reader.attr(solid, 'Depth'));
  const dir = extrusionDirection(reader, solid.expressId);
  if (!profile || depth === null || !dir) return false;
  const position = reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
  if (!position) return false;
  for (const [x, y] of profile) {
    out.push(applyFrame(placed, applyFrame(position, [x, y, 0])));
    out.push(applyFrame(placed, applyFrame(position, [x + dir[0] * depth, y + dir[1] * depth, dir[2] * depth])));
  }
  return unwrapped!.subtracted;
}

/** `IfcExtrudedAreaSolid.Depth` follows a unit direction; null for malformed or zero-length ratios. */
function extrusionDirection(reader: ModelReader, solidId: number): Vec3 | null {
  const direction = reader.entity(asRef(reader.attr(reader.entity(solidId), 'ExtrudedDirection')));
  const ratios = direction && Array.isArray(direction.attributes[0]) ? direction.attributes[0].map(asNumber) : null;
  if (!ratios || ratios.length < 2 || ratios.length > 3 || ratios.some((v) => v === null)) return null;
  const vector: Vec3 = [ratios[0] as number, ratios[1] as number, (ratios[2] as number | undefined) ?? 0];
  const magnitude = Math.hypot(...vector);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return null;
  return [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude];
}

/**
 * A product's body as plan regions it covers: for each leaf (mapped items
 * expanded) that is a plain extrusion, its profile at the base and at the top,
 * in object coordinates; a point lies under the leaf only inside both (an
 * inclined plate covers less than either). `complete` is false when a leaf is
 * anything else (a Brep, a clipped or Boolean solid, an unreadable profile).
 */
export function extrusionRegions(reader: ModelReader, productId: number): { regions: Vec3[][][]; complete: boolean } {
  const product = reader.entity(productId);
  const shape = reader.entity(asRef(reader.attr(product, 'Representation')));
  const regions: Vec3[][][] = [];
  const budget: MappedWorkBudget = { remaining: MAX_MAPPED_ITEMS };
  let complete = true;
  for (const repId of asRefList(reader.attr(shape, 'Representations'))) {
    const rep = reader.entity(repId);
    const identifier = rep ? asString(reader.attr(rep, 'RepresentationIdentifier')) : null;
    if (!rep || (identifier !== null && NON_SOLID.has(identifier))) continue;
    for (const top of asRefList(reader.attr(rep, 'Items'))) {
      for (const { item, frame } of placedItems(reader, top, IDENTITY, 0, new Set(), budget)) {
        const solid = reader.entity(item);
        const swept = solid ? reader.entity(asRef(reader.attr(solid, 'SweptArea'))) : null;
        if (swept?.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS' && asRefList(reader.attr(swept, 'InnerCurves')).length > 0) complete = false;
        const profile = solid?.type === 'IFCEXTRUDEDAREASOLID' ? profilePoints(reader, asRef(reader.attr(solid, 'SweptArea'))) : null;
        const depth = solid ? asNumber(reader.attr(solid, 'Depth')) : null;
        const direction = solid ? extrusionDirection(reader, solid.expressId) : null;
        const position = !solid || reader.attr(solid, 'Position') == null ? IDENTITY : axisPlacementFrame(reader, reader.attr(solid, 'Position'));
        if (!frame || !profile || profile.length < 3 || depth === null || !position || !direction) {
          complete = false;
          continue;
        }
        const dir = direction.map((v) => v * depth);
        const at = (x: number, y: number, k: number) => applyFrame(frame, applyFrame(position, [x + k * dir[0], y + k * dir[1], k * (dir[2] ?? 0)]));
        regions.push([profile.map(([x, y]) => at(x, y, 0)), profile.map(([x, y]) => at(x, y, 1))]);
      }
    }
  }
  return { regions, complete };
}

