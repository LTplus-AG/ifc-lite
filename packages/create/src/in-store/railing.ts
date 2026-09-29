/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcRailing along a polyline path (#6232).
 *
 * `IfcCreator.addIfcRailing` draws one straight run (a square rail box plus a
 * post at each end). This builder takes a whole path: the handrail is one
 * IfcSweptDiskSolid swept along an IfcPolyline, so corners stay continuous,
 * and circular posts (IfcExtrudedAreaSolid of an IfcCircleProfileDef) stand at
 * every path vertex, plus intermediate ones when `PostSpacing` is set.
 *
 * `Height` is the height of the top of the handrail above the path, so the
 * rail's centreline runs at `Height - RailDiameter / 2` and the posts stop
 * there. The path is the railing's base line in storey coordinates; it may
 * slope (a stair or ramp railing).
 *
 * Schema gating (D2): attributes are laid out from the target schema's
 * registry; IFC2X3's mandatory `IfcSweptDiskSolid.StartParam`/`EndParam` are
 * written as the polyline's full parameter range, and IFC5 is refused.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitLocalPlacement,
  emitRelContainedInSpatialStructure,
  ownerHistoryRef,
  productGuid,
} from './_emit-helpers.js';
import { schemaAttributes, schemaRegistry } from './schema-attributes.js';

type Attrs = Parameters<StoreEditor['addEntity']>[1];
type Vec3 = [number, number, number];

const DEFAULT_RAIL_DIAMETER = 0.05;

export interface RailingInStoreParams {
  /** Base line of the railing, storey-local (metres). At least two distinct consecutive points. */
  Path: ReadonlyArray<readonly [number, number, number]>;
  /** Height of the top of the handrail above the path (metres). */
  Height: number;
  /** Handrail diameter (metres). Default 0.05. */
  RailDiameter?: number;
  /** Post diameter (metres). Default `RailDiameter`. */
  PostDiameter?: number;
  /**
   * Largest distance between posts along a segment (metres). Posts always
   * stand at every path vertex; with a spacing, each segment gets evenly
   * spaced intermediate posts no further apart than this.
   */
  PostSpacing?: number;
  /** IfcRailing PredefinedType. Default `HANDRAIL`. */
  PredefinedType?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface RailingBuildResult {
  railingId: number;
  placementId: number;
  /** The handrail's IfcSweptDiskSolid. */
  railSolidId: number;
  /** One IfcExtrudedAreaSolid per post, in path order. */
  postSolidIds: number[];
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Post base points along `path` (vertices, plus intermediates at `spacing`). */
export function railingPostPoints(path: ReadonlyArray<Vec3>, spacing?: number): Vec3[] {
  const posts: Vec3[] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const bays = spacing === undefined ? 1 : Math.max(1, Math.ceil(Math.hypot(...sub(b, a)) / spacing - 1e-9));
    for (let k = 1; k <= bays; k++) posts.push(lerp(a, b, k / bays));
  }
  return posts;
}

function assertRailingParams(params: RailingInStoreParams, op: string): void {
  if (!Array.isArray(params.Path) || params.Path.length < 2) {
    throw new Error(`${op}: Path needs at least two points`);
  }
  params.Path.forEach((p, i) => assertFinitePoint3({ [`Path[${i}]`]: p as Vec3 }, op));
  for (let i = 1; i < params.Path.length; i++) {
    if (Math.hypot(...sub(params.Path[i] as Vec3, params.Path[i - 1] as Vec3)) <= 1e-9) {
      throw new Error(`${op}: Path[${i - 1}] and Path[${i}] must be distinct points`);
    }
  }
  const rail = params.RailDiameter ?? DEFAULT_RAIL_DIAMETER;
  assertPositiveFinite([params.Height, rail, params.PostDiameter ?? rail], `${op}: Height, RailDiameter and PostDiameter must be finite positive numbers`);
  if (params.Height <= rail) throw new Error(`${op}: Height must be greater than RailDiameter`);
  if (params.PostSpacing !== undefined) {
    assertPositiveFinite([params.PostSpacing], `${op}: PostSpacing must be a finite positive number`);
  }
}

export function addRailingToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: RailingInStoreParams,
): RailingBuildResult {
  const op = 'addRailingToStore';
  assertRailingParams(params, op);
  const registry = schemaRegistry(anchor.schema, op);
  const isIfc2x3 = registry.name.toUpperCase() === 'IFC2X3';

  const railDiameter = params.RailDiameter ?? DEFAULT_RAIL_DIAMETER;
  const railRadius = toNativeLength(anchor, railDiameter / 2);
  const postRadius = toNativeLength(anchor, (params.PostDiameter ?? railDiameter) / 2);
  const railAxisHeight = toNativeLength(anchor, params.Height - railDiameter / 2);
  const path = params.Path.map((p) => toNativePoint3(anchor, p));
  const origin = path[0];
  const local = path.map((p) => sub(p, origin));
  const spacing = params.PostSpacing === undefined ? undefined : toNativeLength(anchor, params.PostSpacing);

  // Lay the railing record out before the first emit so a bad PredefinedType
  // or a missing IFC2X3 OwnerHistory refuses cleanly.
  const globalId = productGuid(params, anchor.guidRandom);
  const railingValues = (placement: string | null, shape: string | null) => ({
    GlobalId: globalId,
    OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
    Name: params.Name ?? 'Railing',
    Description: params.Description,
    ObjectType: params.ObjectType,
    ObjectPlacement: placement,
    Representation: shape,
    Tag: params.Tag,
    PredefinedType: params.PredefinedType ?? 'HANDRAIL',
  });
  schemaAttributes(registry, 'IfcRailing', railingValues(null, null), op);

  // Placement at the first path point, explicit axes so it can be turned later.
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, origin, [0, 0, 1], [1, 0, 0]);

  // Handrail: a disk swept along the path lifted to the rail's centreline.
  const directrixPoints = local.map((p) => editor.addEntity('IfcCartesianPoint', [[p[0], p[1], p[2] + railAxisHeight]]).expressId);
  const directrix = editor.addEntity('IfcPolyline', [directrixPoints.map((id) => `#${id}`)]).expressId;
  const railSolidId = editor.addEntity('IfcSweptDiskSolid', schemaAttributes(registry, 'IfcSweptDiskSolid', {
    Directrix: `#${directrix}`,
    Radius: railRadius,
    // IfcPolyline's parameter is the point index; IFC2X3 requires the range.
    ...(isIfc2x3 ? { StartParam: 0, EndParam: local.length - 1 } : {}),
  }, op) as Attrs).expressId;

  // Posts: circular, from the path up to the rail's centreline. One shared
  // profile and extrusion direction.
  const postOriginPt = editor.addEntity('IfcCartesianPoint', [[0, 0]]).expressId;
  const postProfilePos = editor.addEntity('IfcAxis2Placement2D', [`#${postOriginPt}`, null]).expressId;
  const postProfile = editor.addEntity('IfcCircleProfileDef', schemaAttributes(registry, 'IfcCircleProfileDef', {
    ProfileType: 'AREA',
    Position: `#${postProfilePos}`,
    Radius: postRadius,
  }, op) as Attrs).expressId;
  const up = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  const postSolidIds = railingPostPoints(local, spacing).map((p) => {
    const pt = editor.addEntity('IfcCartesianPoint', [p]).expressId;
    const position = editor.addEntity('IfcAxis2Placement3D', [`#${pt}`, null, null]).expressId;
    return editor.addEntity('IfcExtrudedAreaSolid', [`#${postProfile}`, `#${position}`, `#${up}`, railAxisHeight]).expressId;
  });

  const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
    `#${anchor.bodyContextId}`,
    'Body',
    'SolidModel',
    [railSolidId, ...postSolidIds].map((id) => `#${id}`),
  ]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [null, null, [`#${shapeRepId}`]]).expressId;

  const railingId = editor.addEntity(
    'IfcRailing',
    schemaAttributes(registry, 'IfcRailing', railingValues(`#${placementId}`, `#${productShapeId}`), op) as Attrs,
  ).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(
    editor, anchor.ownerHistoryId, railingId, anchor.storeyId, anchor.guidRandom,
  );

  return { railingId, placementId, railSolidId, postSolidIds, shapeRepId, productShapeId, relContainedId };
}
