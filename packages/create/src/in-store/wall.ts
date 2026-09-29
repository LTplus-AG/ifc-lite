/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcWall — emits the full sub-graph (start
 * placement with direction, offset rectangle profile, extruded solid,
 * representation, IfcRelContainedInSpatialStructure) into a
 * `StoreEditor` overlay. Mirrors `IfcCreator.addIfcWall` semantics:
 *
 *   - placement origin at `Start`, local X = wall direction
 *   - profile = rectangle(wallLen × Thickness) centred at (wallLen/2, 0)
 *     so the solid spans `Start → End` along local X and is centred
 *     on the thickness axis
 *   - extruded upward (local +Z) by `Height`
 *   - with `Axis: true`, an `Axis` representation (`Curve2D` IfcPolyline,
 *     Start -> End in the wall's frame) beside the `Body`: the centreline
 *     other tools and `extractWallSegmentsForStorey` read
 *
 * `Alignment`/`Offset` shift the body across the axis, and `StartCut`/`EndCut`
 * reach past or stop short of the axis ends (see `./wall-join.ts`). Square
 * ends keep the rectangle profile; a slanted end, as a join at an angle other
 * than 90 degrees leaves, needs a four-point IfcArbitraryClosedProfileDef.
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { vecNorm, assertFinitePoint3 } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitLocalPlacement,
  emitPolygonProfile,
  emitRectangleProfile,
  ownerHistoryRef,
  productGuid,
} from './_emit-helpers.js';
import { wallBodyOutline, type WallAlignment, type WallEndCut, type WallJoinWall } from './wall-join.js';

export interface WallInStoreParams {
  /** Start of the wall axis, in storey-local coordinates (metres). */
  Start: [number, number, number];
  /** End of the wall axis, in storey-local coordinates (metres). */
  End: [number, number, number];
  /** Wall thickness along the local cross-section axis (metres). */
  Thickness: number;
  /** Extrusion height along +Z (metres). */
  Height: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
  /** Which face the axis runs along (`left`/`right` of Start -> End). Default `center`. */
  Alignment?: WallAlignment;
  /** Extra shift of the body across the axis, metres, positive to the left. Default 0. */
  Offset?: number;
  /** Body end at Start (metres past the axis end at each face). Default square at Start. */
  StartCut?: WallEndCut;
  /** Body end at End. Default square at End. */
  EndCut?: WallEndCut;
  /**
   * Write an `Axis` representation beside the Body. Default false: an editor
   * that moves the wall by its placement and profile alone (the viewer's
   * endpoint resize) would leave the axis behind, and readers prefer the axis.
   * `applyWallJoinToStore` always writes one, since a joined body no longer
   * tells where the axis ends.
   */
  Axis?: boolean;
}

export interface WallBuildResult {
  wallId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  /** The `Body` IfcShapeRepresentation (first in the product shape). */
  shapeRepId: number;
  /** The `Axis` IfcShapeRepresentation (second in the product shape), or null without `Axis: true`. */
  axisRepId: number | null;
  productShapeId: number;
  relContainedId: number;
}

/** Round away the float noise sums of metre values pick up (0.05 + 0.1 - 0.2 = -0.05000000000000001). */
function roundLength(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/** The plan view of a wall's params, in metres, as `computeWallJoin` takes it. */
export function wallJoinWallFromParams(params: WallInStoreParams): WallJoinWall {
  return {
    start: [params.Start[0], params.Start[1]],
    end: [params.End[0], params.End[1]],
    thickness: params.Thickness,
    alignment: params.Alignment,
    offset: params.Offset,
    startCut: params.StartCut,
    endCut: params.EndCut,
  };
}

/**
 * Emit the body profile of `wall` (metres) in a wall frame whose origin sits
 * `startX` metres before the wall's Start along the axis (0 when the placement
 * origin is Start). Coordinates are converted to the anchor's native unit.
 */
export function emitWallBodyProfile(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'lengthUnitScale'>,
  wall: WallJoinWall,
  startX = 0,
): number {
  const outline = wallBodyOutline(wall);
  const native = (v: number) => roundLength(toNativeLength(anchor, v));
  if (outline.rectangular) {
    const [x0, y0] = outline.corners[0];
    const [x1, y1] = outline.corners[2];
    // YDim straight from the thickness: y1 - y0 can pick up float noise.
    return emitRectangleProfile(
      editor,
      native(x1 - x0),
      native(wall.thickness),
      native(startX + (x0 + x1) / 2),
      native((y0 + y1) / 2),
    );
  }
  return emitPolygonProfile(editor, outline.corners.map(([x, y]) => [native(startX + x), native(y)] as const));
}

/**
 * Emit the `Axis` representation: a 2D IfcPolyline from `fromX` to `toX`
 * (metres) along the wall frame's X.
 */
export function emitWallAxisRepresentation(
  editor: StoreEditor,
  anchor: Pick<SpatialAnchor, 'axisContextId' | 'lengthUnitScale'>,
  fromX: number,
  toX: number,
): number {
  const from = editor.addEntity('IfcCartesianPoint', [[roundLength(toNativeLength(anchor, fromX)), 0]]).expressId;
  const to = editor.addEntity('IfcCartesianPoint', [[roundLength(toNativeLength(anchor, toX)), 0]]).expressId;
  const polyline = editor.addEntity('IfcPolyline', [[`#${from}`, `#${to}`]]).expressId;
  return editor.addEntity('IfcShapeRepresentation', [
    `#${anchor.axisContextId}`,
    'Axis',
    'Curve2D',
    [`#${polyline}`],
  ]).expressId;
}

export function addWallToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: WallInStoreParams,
): WallBuildResult {
  const { ownerHistoryId, bodyContextId, storeyId, storeyPlacementId } = anchor;

  assertPositiveFinite(
    [params.Thickness, params.Height],
    'addWallToStore: Thickness and Height must be positive',
  );
  // A non-finite Start/End coordinate makes the derived wallLen NaN, and
  // `NaN <= 0` is false, so the distinct-points check below never fires.
  // Validate the source coordinates instead of trusting the derived value.
  assertFinitePoint3({ Start: params.Start, End: params.End }, 'addWallToStore');
  const cuts = [params.Offset ?? 0, params.StartCut?.left ?? 0, params.StartCut?.right ?? 0, params.EndCut?.left ?? 0, params.EndCut?.right ?? 0];
  if (cuts.some((v) => !Number.isFinite(v))) {
    throw new Error('addWallToStore: Offset, StartCut and EndCut must be finite');
  }
  // The plan outline in metres, before the unit conversion below; throws when
  // the cuts leave the body with no length.
  const plan = wallJoinWallFromParams(params);
  if (Math.hypot(plan.end[0] - plan.start[0], plan.end[1] - plan.start[1]) > 0) wallBodyOutline(plan);
  // Params are metres; convert dimensioned fields to the file's native
  // length unit so the emitted STEP coordinates are correctly scaled
  // (see SpatialAnchor.lengthUnitScale). Directions normalise the scale
  // away and the validation checks are scale-invariant.
  params = {
    ...params,
    Start: toNativePoint3(anchor, params.Start),
    End: toNativePoint3(anchor, params.End),
    Thickness: toNativeLength(anchor, params.Thickness),
    Height: toNativeLength(anchor, params.Height),
  };
  const dx = params.End[0] - params.Start[0];
  const dy = params.End[1] - params.Start[1];
  const dz = params.End[2] - params.Start[2];
  const wallLen = Math.hypot(dx, dy);
  if (wallLen <= 0) {
    throw new Error('addWallToStore: Start and End must be distinct points');
  }
  // Walls are extruded along the placement +Z axis (storey up). Sloped
  // endpoints would silently emit invalid geometry, so reject them.
  // Use a length-relative epsilon so float-derived noise on nominally
  // flat coordinates doesn't trip the guard for long walls.
  if (Math.abs(dz) > Math.max(1e-6 * wallLen, 1e-9)) {
    throw new Error('addWallToStore: Start and End must lie on the same storey plane (Z must match)');
  }
  const dir: Point3D = vecNorm([dx, dy, 0]);

  // Placement at Start with local X = wall direction and local Z up. The
  // Axis is written explicitly: IFC forbids a RefDirection without it (#5469).
  const placementId = emitLocalPlacement(editor, storeyPlacementId, params.Start, undefined, dir);

  // Body profile in the wall frame: by default a rectangle centred at
  // (wallLen/2, 0), so the solid spans 0..wallLen along local X and
  // -thickness/2..+thickness/2 on Y; alignment, offset and end cuts move it.
  const profileId = emitWallBodyProfile(editor, anchor, plan);

  // Extruded along +Z by Height.
  const solidOriginPt = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const solidAxis = editor.addEntity('IfcAxis2Placement3D', [`#${solidOriginPt}`, null, null]).expressId;
  const extrudeDirection = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  const solidId = editor.addEntity('IfcExtrudedAreaSolid', [
    `#${profileId}`,
    `#${solidAxis}`,
    `#${extrudeDirection}`,
    params.Height,
  ]).expressId;

  const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
    `#${bodyContextId}`,
    'Body',
    'SweptSolid',
    [`#${solidId}`],
  ]).expressId;
  // Axis in metres (the emitter converts): Start is the frame origin.
  const axisRepId = params.Axis
    ? emitWallAxisRepresentation(editor, anchor, 0, Math.hypot(plan.end[0] - plan.start[0], plan.end[1] - plan.start[1]))
    : null;
  // Body first: readers such as the viewer's wall edit take Representations[0] as the body.
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [
    null,
    null,
    axisRepId === null ? [`#${shapeRepId}`] : [`#${shapeRepId}`, `#${axisRepId}`],
  ]).expressId;

  // `IfcWall.PredefinedType` only exists from IFC4 onward.
  const wallAttrs: Array<unknown> = [
    productGuid(params, anchor.guidRandom),
    ownerHistoryRef(ownerHistoryId),
    params.Name ?? 'Wall',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    params.Tag ?? null,
  ];
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    // Default to NOTDEFINED so we don't make a semantic claim about
    // the wall's classification — matches addDoorToStore /
    // addWindowToStore and lets callers override via Raw STEP.
    wallAttrs.push('.NOTDEFINED.');
  }
  const wallId = editor.addEntity('IfcWall', wallAttrs as Parameters<StoreEditor['addEntity']>[1]).expressId;

  const relContainedId = editor.addEntity('IfcRelContainedInSpatialStructure', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(ownerHistoryId),
    null,
    null,
    [`#${wallId}`],
    `#${storeyId}`,
  ]).expressId;

  return {
    wallId,
    placementId,
    profileId,
    solidId,
    shapeRepId,
    axisRepId,
    productShapeId,
    relContainedId,
  };
}
