/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Apply a wall join (`computeWallJoin`) to two walls in the store: rewrite each
 * joined wall's body profile and `Axis` representation, and write the
 * `IfcRelConnectsPathElements` between them (#6232 D1).
 *
 * The wall's ObjectPlacement is left where it is. A join only moves an axis end
 * along the axis, so the wall frame (origin, +X along the axis) stays valid,
 * and openings placed relative to the wall keep their position. The new body
 * and axis are written in that frame, offset by where the new Start sits in it.
 * That is why a target carries `origin`: the plan point of the placement
 * origin, which is the wall's Start until a join moves Start.
 *
 * Only the entities the wall owns are replaced: a new profile goes into the
 * existing IfcExtrudedAreaSolid.SweptArea, a new Axis representation replaces
 * the old one in IfcProductDefinitionShape.Representations. The old profile and
 * axis are removed when this session created them (overlay entities), and left
 * to the exporter otherwise.
 *
 * Pure: writes through the editor only.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { relConnectsPathElementsAttributes } from './rel-connects-path.js';
import { schemaRegistry } from './schema-attributes.js';
import { emitWallAxisRepresentation, emitWallBodyProfile, wallJoinWallFromParams, type WallBuildResult, type WallInStoreParams } from './wall.js';
import { computeWallJoin, type PlanPoint, type WallJoin, type WallJoinOptions, type WallJoinWall } from './wall-join.js';

/** A wall in the store, with the ids a join rewrites and its current plan shape. */
export interface WallJoinTarget {
  wallId: number;
  /** IfcExtrudedAreaSolid of the Body; its SweptArea is replaced. */
  solidId: number;
  /** The profile the solid sweeps now. */
  profileId: number;
  /** IfcProductDefinitionShape of the wall. */
  productShapeId: number;
  /** Its current Representations, in order. */
  representationIds: readonly number[];
  /** The current `Axis` representation, when the wall has one (it is replaced, else a new one is appended). */
  axisRepId: number | null;
  /** Plan point (metres) of the wall's placement origin; the placement's +X runs along the axis. */
  origin: PlanPoint;
  /** The wall's current plan shape, metres. */
  wall: WallJoinWall;
}

export interface WallJoinApplyResult {
  join: WallJoin;
  /** The IfcRelConnectsPathElements written. */
  relId: number;
  /** The walls after the join, ready to take part in a next join. */
  a: WallJoinTarget;
  b: WallJoinTarget;
}

export interface WallJoinApplyOptions extends WallJoinOptions {
  /** Layer priorities for the relationship, by wall. Default empty. */
  priorities?: { a?: readonly number[]; b?: readonly number[] };
  /** Name for the IfcRelConnectsPathElements. */
  Name?: string;
}

type JoinAnchor = Pick<SpatialAnchor, 'ownerHistoryId' | 'axisContextId' | 'schema' | 'lengthUnitScale' | 'guidRandom'>;

/** The join target for a wall `addWallToStore` just built from `params`. */
export function wallJoinTargetFromBuild(build: WallBuildResult, params: WallInStoreParams): WallJoinTarget {
  return {
    wallId: build.wallId,
    solidId: build.solidId,
    profileId: build.profileId,
    productShapeId: build.productShapeId,
    representationIds: build.axisRepId === null ? [build.shapeRepId] : [build.shapeRepId, build.axisRepId],
    axisRepId: build.axisRepId,
    origin: [params.Start[0], params.Start[1]],
    wall: wallJoinWallFromParams(params),
  };
}

/**
 * Join walls `a` and `b` in the store. See `computeWallJoin` for the geometry
 * and `options`. Refuses IFC5 / IFCX anchors; IFC2X3, IFC4 and IFC4X3 are
 * written by their own attribute layouts.
 */
export function applyWallJoinToStore(
  editor: StoreEditor,
  anchor: JoinAnchor,
  a: WallJoinTarget,
  b: WallJoinTarget,
  options: WallJoinApplyOptions = {},
): WallJoinApplyResult {
  const op = 'applyWallJoinToStore';
  schemaRegistry(anchor.schema, op);
  if (a.wallId === b.wallId) throw new Error(`${op}: a wall cannot join itself`);
  for (const target of [a, b]) {
    for (const id of [target.wallId, target.solidId, target.profileId, target.productShapeId]) {
      if (!editor.hasEntity(id)) throw new Error(`${op}: #${id} of wall #${target.wallId} is not a live entity`);
    }
    if (editor.getEntityType(target.solidId)?.toUpperCase() !== 'IFCEXTRUDEDAREASOLID') {
      throw new Error(`${op}: wall #${target.wallId} body #${target.solidId} is not an IfcExtrudedAreaSolid`);
    }
  }

  // Everything that can refuse runs before the first write: the geometry, then
  // the relationship's attributes (schema layout, element classes, OwnerHistory).
  const join = computeWallJoin(a.wall, b.wall, options);
  const relatingIsA = join.relating === 'a';
  const [relating, related] = relatingIsA ? [join.a, join.b] : [join.b, join.a];
  const relAttributes = relConnectsPathElementsAttributes(editor, anchor, {
    RelatingElement: (relatingIsA ? a : b).wallId,
    RelatedElement: (relatingIsA ? b : a).wallId,
    RelatingConnectionType: relating.connection,
    RelatedConnectionType: related.connection,
    RelatingPriorities: relatingIsA ? options.priorities?.a : options.priorities?.b,
    RelatedPriorities: relatingIsA ? options.priorities?.b : options.priorities?.a,
    Name: options.Name,
  }, op);

  // The through wall of a T keeps its body; it only gains an Axis if it has none,
  // so every joined wall carries one.
  const nextA = join.a.connection === 'ATPATH' ? ensureAxis(editor, anchor, a) : rewriteWall(editor, anchor, a, join.a.wall);
  const nextB = join.b.connection === 'ATPATH' ? ensureAxis(editor, anchor, b) : rewriteWall(editor, anchor, b, join.b.wall);
  const relId = editor.addEntity('IfcRelConnectsPathElements', relAttributes as Parameters<StoreEditor['addEntity']>[1]).expressId;
  return { join, relId, a: nextA, b: nextB };
}

/** Where plan point `p` sits along the wall frame's X, metres from the placement origin. */
function alongFrame(target: WallJoinTarget, p: PlanPoint): number {
  const { start, end } = target.wall;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  return ((p[0] - target.origin[0]) * (end[0] - start[0]) + (p[1] - target.origin[1]) * (end[1] - start[1])) / length;
}

function rewriteWall(editor: StoreEditor, anchor: JoinAnchor, target: WallJoinTarget, wall: WallJoinWall): WallJoinTarget {
  const startX = alongFrame(target, wall.start);
  const endX = alongFrame(target, wall.end);
  const profileId = emitWallBodyProfile(editor, anchor, wall, startX);
  editor.setPositionalAttribute(target.solidId, 0, `#${profileId}`);
  removeOverlayProfile(editor, target.profileId);

  return { ...writeAxis(editor, anchor, target, startX, endX), profileId, wall };
}

/** Replace the wall's Axis representation (or append one) with `startX..endX` in its frame. */
function writeAxis(editor: StoreEditor, anchor: JoinAnchor, target: WallJoinTarget, startX: number, endX: number): WallJoinTarget {
  const axisRepId = emitWallAxisRepresentation(editor, anchor, startX, endX);
  const representationIds = target.axisRepId !== null && target.representationIds.includes(target.axisRepId)
    ? target.representationIds.map((id) => (id === target.axisRepId ? axisRepId : id))
    : [...target.representationIds, axisRepId];
  editor.setPositionalAttribute(target.productShapeId, 2, representationIds.map((id) => `#${id}`));
  if (target.axisRepId !== null) removeOverlayAxis(editor, target.axisRepId);
  return { ...target, representationIds, axisRepId };
}

/** A wall the join leaves as it is: give it an Axis when it has none. */
function ensureAxis(editor: StoreEditor, anchor: JoinAnchor, target: WallJoinTarget): WallJoinTarget {
  if (target.axisRepId !== null) return { ...target };
  return writeAxis(editor, anchor, target, alongFrame(target, target.wall.start), alongFrame(target, target.wall.end));
}

function refId(value: unknown): number | null {
  return typeof value === 'string' && /^#\d+$/.test(value) ? Number(value.slice(1)) : null;
}

/** Remove overlay entity `id` when it is one of `types`; returns its attributes, else null. */
function removeOverlay(editor: StoreEditor, id: number | null, types: readonly string[]): readonly unknown[] | null {
  if (id === null) return null;
  const entity = editor.getNewEntity(id);
  const type = editor.getEntityType(id)?.toUpperCase();
  if (!entity || !types.some((t) => t.toUpperCase() === type)) return null;
  editor.removeEntity(id);
  return entity.attributes;
}

/** A profile this session built: the profile, its Position and origin point, or its polyline and points. */
function removeOverlayProfile(editor: StoreEditor, profileId: number): void {
  const profile = removeOverlay(editor, profileId, ['IfcRectangleProfileDef', 'IfcArbitraryClosedProfileDef']);
  if (!profile) return;
  // IfcRectangleProfileDef.Position (slot 2) / IfcArbitraryClosedProfileDef.OuterCurve (slot 2).
  const inner = refId(profile[2]);
  const position = removeOverlay(editor, inner, ['IfcAxis2Placement2D']);
  if (position) removeOverlay(editor, refId(position[0]), ['IfcCartesianPoint']);
  const polyline = position ? null : removeOverlay(editor, inner, ['IfcPolyline']);
  // A closed polyline repeats its first point; remove each point once.
  const points = new Set(Array.isArray(polyline?.[0]) ? (polyline[0] as unknown[]).map(refId) : []);
  for (const point of points) removeOverlay(editor, point, ['IfcCartesianPoint']);
}

/** An Axis representation this session built: the representation, its polyline and points. */
function removeOverlayAxis(editor: StoreEditor, axisRepId: number): void {
  const rep = removeOverlay(editor, axisRepId, ['IfcShapeRepresentation']);
  const items = Array.isArray(rep?.[3]) ? (rep[3] as unknown[]) : [];
  for (const item of items) {
    const polyline = removeOverlay(editor, refId(item), ['IfcPolyline']);
    const points = new Set(Array.isArray(polyline?.[0]) ? (polyline[0] as unknown[]).map(refId) : []);
    for (const point of points) removeOverlay(editor, point, ['IfcCartesianPoint']);
  }
}
