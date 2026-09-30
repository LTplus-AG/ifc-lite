/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read side of the wall joins (#6232 B2): a wall already in the store, source
 * or authored, as the `WallJoinTarget` a join rewrites, and the
 * `IfcRelConnectsPathElements` that tie walls together. Reads go through the
 * mutation overlay, so a wall or join written earlier in the session counts.
 *
 * A wall is readable when it is a straight wall with a placement that names its
 * direction, an extruded body over a rectangle or a four-point polygon (what
 * `addWallToStore` and `applyWallJoinToStore` write), and an optional `Axis`
 * polyline on the wall's own centreline. Anything else reads as null: it can
 * neither be re-shaped nor joined.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { AnchorEntityReader } from './resolve-anchor.js';
import type { WallJoinTarget } from './wall-join-apply.js';
import type { PlanPoint, WallConnectionType, WallEndCut, WallJoinWall } from './wall-join.js';

/** A wall as the join tools see it, with the ids and native-unit values a re-shape writes. */
export interface WallJoinRead extends WallJoinTarget {
  /** IfcAxis2Placement3D of the wall's placement. */
  axisPlacementId: number;
  /** IfcCartesianPoint of the placement's Location. */
  locationPointId: number;
  /** IfcDirection of the placement's RefDirection. */
  refDirectionId: number;
  /** The Location, in the file's native unit. */
  location: [number, number, number];
  /** `PlacementRelTo` of the wall's placement: two walls join only in the same frame. */
  parentPlacementId: number | null;
  /** Extrusion depth in metres, `NaN` when the slot is not a number. */
  height: number;
  /**
   * The body is the plain rectangle `addWallToStore` writes without cuts,
   * offset or axis alignment: the four coupled entities (placement, direction,
   * XDim, profile origin) describe the wall completely.
   */
  plain: boolean;
}

export interface WallJoinRel {
  relId: number;
  relatingId: number;
  relatedId: number;
  relatingConnection: WallConnectionType;
  relatedConnection: WallConnectionType;
  relatingPriorities: number[];
  relatedPriorities: number[];
  name: string | null;
}

const WALL_TYPES = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE']);
const EPS = 1e-9;
const CONNECTIONS: readonly string[] = ['ATSTART', 'ATEND', 'ATPATH'];

function refId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^#[1-9][0-9]*$/.test(value)) return Number(value.slice(1));
  return null;
}

function numbers(value: unknown, min: number): number[] | null {
  return Array.isArray(value) && value.length >= min && value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? (value as number[])
    : null;
}

/** A polyline's 2D points (native), without a repeated closing point; null unless every point is a 2D or 3D IfcCartesianPoint. */
function polylinePoints(reader: AnchorEntityReader, polylineId: number | null): PlanPoint[] | null {
  const polyline = polylineId === null ? null : reader.entity(polylineId);
  if (polyline?.type.toUpperCase() !== 'IFCPOLYLINE' || !Array.isArray(polyline.attributes[0])) return null;
  const points: PlanPoint[] = [];
  for (const ref of polyline.attributes[0] as unknown[]) {
    const id = refId(ref);
    const point = id === null ? null : reader.entity(id);
    const xy = point?.type.toUpperCase() === 'IFCCARTESIANPOINT' ? numbers(point.attributes[0], 2) : null;
    if (!xy) return null;
    points.push([xy[0], xy[1]]);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) <= EPS) points.pop();
  return points;
}

interface BodyExtent {
  /** x range of the right (yMin) and left (yMax) faces, native, in the wall frame. */
  right: [number, number];
  left: [number, number];
  yMin: number;
  yMax: number;
  rectangular: boolean;
  /** Rectangle only: whether its origin is the plain `[XDim / 2, 0]`. */
  centred: boolean;
}

/** The body profile's extent in the wall frame, or null when it is neither an axis-aligned rectangle nor a four-point trapezoid. */
function bodyExtent(reader: AnchorEntityReader, profileId: number): BodyExtent | null {
  const profile = reader.entity(profileId);
  const type = profile?.type.toUpperCase();
  if (!profile) return null;
  if (type === 'IFCRECTANGLEPROFILEDEF') {
    const position = refId(profile.attributes[2]) === null ? null : reader.entity(refId(profile.attributes[2])!);
    const xDim = profile.attributes[3];
    const yDim = profile.attributes[4];
    if (position?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT2D' || typeof xDim !== 'number' || typeof yDim !== 'number') return null;
    if (!(xDim > 0) || !(yDim > 0)) return null;
    // A rotated profile is not one this reader can express as cuts.
    const rotation = refId(position.attributes[1]) === null ? null : reader.entity(refId(position.attributes[1])!);
    const dir = rotation ? numbers(rotation.attributes[0], 2) : null;
    if (dir && (Math.abs(dir[0] - 1) > EPS || Math.abs(dir[1]) > EPS)) return null;
    const point = refId(position.attributes[0]) === null ? null : reader.entity(refId(position.attributes[0])!);
    const centre = point ? numbers(point.attributes[0], 2) : null;
    if (!centre) return null;
    const x: [number, number] = [centre[0] - xDim / 2, centre[0] + xDim / 2];
    return {
      right: x, left: x, yMin: centre[1] - yDim / 2, yMax: centre[1] + yDim / 2,
      rectangular: true, centred: Math.abs(x[0]) <= EPS && Math.abs(centre[1]) <= EPS,
    };
  }
  if (type === 'IFCARBITRARYCLOSEDPROFILEDEF') {
    const points = polylinePoints(reader, refId(profile.attributes[2]));
    if (!points || points.length !== 4) return null;
    const ys = [...new Set(points.map((p) => p[1]))].sort((a, b) => a - b);
    if (ys.length !== 2 || !(ys[1] - ys[0] > EPS)) return null;
    const along = (y: number): [number, number] | null => {
      const xs = points.filter((p) => p[1] === y).map((p) => p[0]);
      return xs.length === 2 ? [Math.min(...xs), Math.max(...xs)] : null;
    };
    const right = along(ys[0]);
    const left = along(ys[1]);
    return right && left ? { right, left, yMin: ys[0], yMax: ys[1], rectangular: false, centred: false } : null;
  }
  return null;
}

const clean = (v: number): number => (Math.abs(v) <= EPS ? 0 : v);

/**
 * Read wall `wallId` as a join target. `lengthUnitScale` is the model's native
 * unit in metres; the target's plan values are metres.
 */
export function readWallJoinTarget(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  wallId: number,
  lengthUnitScale: number,
): WallJoinRead | null {
  const reader = new AnchorEntityReader(store, view);
  const wall = reader.entity(wallId);
  if (!wall || !WALL_TYPES.has(wall.type.toUpperCase())) return null;

  // Placement: the wall's Location and RefDirection (explicit: the join keeps the frame).
  const placementId = refId(wall.attributes[5]);
  const placement = placementId === null ? null : reader.entity(placementId);
  if (placement?.type.toUpperCase() !== 'IFCLOCALPLACEMENT') return null;
  const axisPlacementId = refId(placement.attributes[1]);
  const axisPlacement = axisPlacementId === null ? null : reader.entity(axisPlacementId);
  if (axisPlacementId === null || axisPlacement?.type.toUpperCase() !== 'IFCAXIS2PLACEMENT3D') return null;
  const locationPointId = refId(axisPlacement.attributes[0]);
  const refDirectionId = refId(axisPlacement.attributes[2]);
  if (locationPointId === null || refDirectionId === null) return null;
  const location = numbers(reader.entity(locationPointId)?.attributes[0], 3);
  const ratios = numbers(reader.entity(refDirectionId)?.attributes[0], 2);
  if (!location || !ratios) return null;
  const dirLength = Math.hypot(ratios[0], ratios[1]);
  if (!(dirLength > EPS) || (ratios.length > 2 && Math.abs(ratios[2]) > 1e-6 * dirLength)) return null;
  const dir: PlanPoint = [ratios[0] / dirLength, ratios[1] / dirLength];

  // Representations: the Body (an extruded profile) and the optional Axis.
  const productShapeId = refId(wall.attributes[6]);
  const productShape = productShapeId === null ? null : reader.entity(productShapeId);
  if (productShapeId === null || productShape?.type.toUpperCase() !== 'IFCPRODUCTDEFINITIONSHAPE'
    || !Array.isArray(productShape.attributes[2])) return null;
  const representationIds = (productShape.attributes[2] as unknown[]).map(refId);
  if (representationIds.length === 0 || representationIds.some((id) => id === null)) return null;
  const ids = representationIds as number[];
  const repOf = (identifier: string) => ids.find((id) => reader.entity(id)?.attributes[1] === identifier) ?? null;
  const bodyRepId = repOf('Body') ?? ids[0];
  const axisRepId = repOf('Axis');
  const bodyItems = reader.entity(bodyRepId)?.attributes[3];
  const solidId = Array.isArray(bodyItems) && bodyItems.length > 0 ? refId(bodyItems[0]) : null;
  const solid = solidId === null ? null : reader.entity(solidId);
  if (solidId === null || solid?.type.toUpperCase() !== 'IFCEXTRUDEDAREASOLID') return null;
  const profileId = refId(solid.attributes[0]);
  const extent = profileId === null ? null : bodyExtent(reader, profileId);
  if (profileId === null || !extent) return null;

  // The axis, from its polyline when there is one (on the wall's own centreline), else the body's length.
  let a0: number;
  let a1: number;
  let axisIsBody = false;
  if (axisRepId !== null) {
    const items = reader.entity(axisRepId)?.attributes[3];
    const points = Array.isArray(items) && items.length === 1 ? polylinePoints(reader, refId(items[0])) : null;
    if (!points || points.length !== 2 || Math.abs(points[0][1]) > EPS || Math.abs(points[1][1]) > EPS
      || !(points[1][0] - points[0][0] > EPS)) return null;
    [a0, a1] = [points[0][0], points[1][0]];
    axisIsBody = Math.abs(a0 - extent.right[0]) <= EPS && Math.abs(a1 - extent.right[1]) <= EPS;
  } else {
    a0 = Math.min(extent.right[0], extent.left[0]);
    a1 = Math.max(extent.right[1], extent.left[1]);
    axisIsBody = extent.rectangular;
  }

  const m = lengthUnitScale > 0 && Number.isFinite(lengthUnitScale) ? lengthUnitScale : 1;
  const metre = (native: number) => Math.round(native * m * 1e9) / 1e9;
  const origin: PlanPoint = [metre(location[0]), metre(location[1])];
  const at = (x: number): PlanPoint => [metre(location[0] + dir[0] * x), metre(location[1] + dir[1] * x)];
  const startCut: WallEndCut = { left: metre(clean(a0 - extent.left[0])), right: metre(clean(a0 - extent.right[0])) };
  const endCut: WallEndCut = { left: metre(clean(extent.left[1] - a1)), right: metre(clean(extent.right[1] - a1)) };
  const offset = metre((extent.yMin + extent.yMax) / 2);
  const wallShape: WallJoinWall = {
    start: at(a0),
    end: at(a1),
    thickness: metre(extent.yMax - extent.yMin),
    ...(offset !== 0 ? { offset } : {}),
    ...(startCut.left !== 0 || startCut.right !== 0 ? { startCut } : {}),
    ...(endCut.left !== 0 || endCut.right !== 0 ? { endCut } : {}),
  };
  const depth = solid.attributes[3];
  return {
    wallId,
    solidId,
    profileId,
    productShapeId,
    representationIds: ids,
    axisRepId,
    origin,
    wall: wallShape,
    axisPlacementId,
    locationPointId,
    refDirectionId,
    location: [location[0], location[1], location[2]],
    parentPlacementId: refId(placement.attributes[0]),
    height: typeof depth === 'number' ? metre(depth) : Number.NaN,
    plain: extent.rectangular && extent.centred && axisIsBody && offset === 0
      && startCut.left === 0 && startCut.right === 0 && endCut.left === 0 && endCut.right === 0,
  };
}

/** The connection type of an enum attribute, `.ATSTART.` or `ATSTART`. */
function connectionOf(value: unknown): WallConnectionType | null {
  const text = typeof value === 'string' ? value.replace(/^\.|\.$/g, '').toUpperCase() : '';
  return CONNECTIONS.includes(text) ? (text as WallConnectionType) : null;
}

function prioritiesOf(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
}

/**
 * Every live `IfcRelConnectsPathElements` that touches one of `wallIds` (all
 * of them when omitted). The attribute slots (Relating 5, Related 6,
 * priorities 7 and 8, connection types 9 and 10) are the same in IFC2X3,
 * IFC4 and IFC4X3.
 */
export function readWallJoinRels(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  wallIds?: ReadonlySet<number>,
): WallJoinRel[] {
  const reader = new AnchorEntityReader(store, view);
  const rels: WallJoinRel[] = [];
  for (const relId of reader.ids('IFCRELCONNECTSPATHELEMENTS')) {
    const attributes = reader.entity(relId)?.attributes;
    if (!attributes) continue;
    const relatingId = refId(attributes[5]);
    const relatedId = refId(attributes[6]);
    const relatedConnection = connectionOf(attributes[9]);
    const relatingConnection = connectionOf(attributes[10]);
    if (relatingId === null || relatedId === null || !relatedConnection || !relatingConnection) continue;
    if (wallIds && !wallIds.has(relatingId) && !wallIds.has(relatedId)) continue;
    rels.push({
      relId, relatingId, relatedId, relatingConnection, relatedConnection,
      relatingPriorities: prioritiesOf(attributes[7]),
      relatedPriorities: prioritiesOf(attributes[8]),
      name: typeof attributes[2] === 'string' ? attributes[2] : null,
    });
  }
  return rels;
}
