/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcSlab — emits a floor slab into a `StoreEditor`
 * overlay. Two profile modes:
 *
 *   - **Rectangle (default)**: placement origin at `Position` (the
 *     minimum corner); profile = rectangle(Width × Depth) centred at
 *     (Width/2, Depth/2) so the slab spans `[Position … Position+(W,D,0)]`.
 *
 *   - **Polygon**: pass `OuterCurve` as a closed list of 2D points in
 *     storey-local coordinates. Emits an IfcArbitraryClosedProfileDef
 *     backed by an IfcPolyline. Placement origin sits at `Position`
 *     (defaults to `[0, 0, 0]`); the points are interpreted relative
 *     to that origin. The polyline is closed automatically — duplicate
 *     last-point-of-first-point is appended only if the input doesn't
 *     already end where it started.
 *
 * Both modes extrude upward along local +Z by `Thickness`. Pure: no
 * I/O, no parser access.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';

export type SlabInStoreParams = SlabRectangleParams | SlabPolygonParams;

export interface SlabRectangleParams {
  Position: [number, number, number];
  Width: number;
  Depth: number;
  Thickness: number;
  /** Discriminator — omit (or `'rectangle'`) to use the rectangle path. */
  Profile?: 'rectangle';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface SlabPolygonParams {
  /** `'polygon'` discriminator selects the IfcArbitraryClosedProfileDef path. */
  Profile: 'polygon';
  /**
   * Closed outline as a list of 2D storey-local points. Must contain at
   * least 3 points. The polyline is auto-closed: if the last point
   * doesn't equal the first, a closing edge back to the first point is
   * inserted at emit time (matches the IfcPolyline convention).
   */
  OuterCurve: Array<[number, number]>;
  /** Local placement origin (metres). Defaults to `[0, 0, 0]`. */
  Position?: [number, number, number];
  Thickness: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface SlabBuildResult {
  slabId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

const POINT_EPSILON = 1e-6;

function isPolygonParams(p: SlabInStoreParams): p is SlabPolygonParams {
  return p.Profile === 'polygon';
}

/** Emit the rectangle profile + return its expressId. */
function emitRectangleProfile(editor: StoreEditor, width: number, depth: number): number {
  const profileOriginPt = editor.addEntity('IfcCartesianPoint', [[width / 2, depth / 2]]).expressId;
  const profilePos = editor.addEntity('IfcAxis2Placement2D', [`#${profileOriginPt}`, null]).expressId;
  return editor.addEntity('IfcRectangleProfileDef', [
    '.AREA.',
    null,
    `#${profilePos}`,
    width,
    depth,
  ]).expressId;
}

/**
 * Emit an `IfcArbitraryClosedProfileDef` from a 2D outer curve. Handles
 * auto-closure (appends the first point if the input doesn't already
 * end where it started — IFC requires the polyline to be closed).
 */
function emitPolygonProfile(editor: StoreEditor, curve: Array<[number, number]>): number {
  if (curve.length < 3) {
    throw new Error('addSlabToStore: polygon OuterCurve needs at least 3 points');
  }
  const first = curve[0];
  const last = curve[curve.length - 1];
  const closed =
    Math.abs(first[0] - last[0]) < POINT_EPSILON &&
    Math.abs(first[1] - last[1]) < POINT_EPSILON;
  const sequence = closed ? curve : [...curve, first];

  const pointIds = sequence.map((pt) => editor.addEntity('IfcCartesianPoint', [pt]).expressId);
  const polylineId = editor.addEntity('IfcPolyline', [pointIds.map((id) => `#${id}`)]).expressId;
  return editor.addEntity('IfcArbitraryClosedProfileDef', [
    '.AREA.',
    null,
    `#${polylineId}`,
  ]).expressId;
}

export function addSlabToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: SlabInStoreParams,
): SlabBuildResult {
  const { ownerHistoryId, bodyContextId, storeyId, storeyPlacementId } = anchor;
  const polygon = isPolygonParams(params);
  const placementOrigin: [number, number, number] = polygon
    ? params.Position ?? [0, 0, 0]
    : params.Position;

  if (params.Thickness <= 0) {
    throw new Error('addSlabToStore: Thickness must be positive');
  }
  if (!polygon && (params.Width <= 0 || params.Depth <= 0)) {
    throw new Error('addSlabToStore: Width and Depth must be positive');
  }

  // Placement at the chosen origin (no rotation).
  const slabOriginPt = editor.addEntity('IfcCartesianPoint', [placementOrigin]).expressId;
  const slabAxis = editor.addEntity('IfcAxis2Placement3D', [
    `#${slabOriginPt}`,
    null,
    null,
  ]).expressId;
  const placementId = editor.addEntity('IfcLocalPlacement', [
    `#${storeyPlacementId}`,
    `#${slabAxis}`,
  ]).expressId;

  const profileId = polygon
    ? emitPolygonProfile(editor, params.OuterCurve)
    : emitRectangleProfile(editor, params.Width, params.Depth);

  // Extruded along +Z by Thickness.
  const solidOriginPt = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const solidAxis = editor.addEntity('IfcAxis2Placement3D', [`#${solidOriginPt}`, null, null]).expressId;
  const extrudeDirection = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  const solidId = editor.addEntity('IfcExtrudedAreaSolid', [
    `#${profileId}`,
    `#${solidAxis}`,
    `#${extrudeDirection}`,
    params.Thickness,
  ]).expressId;

  const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
    `#${bodyContextId}`,
    'Body',
    'SweptSolid',
    [`#${solidId}`],
  ]).expressId;
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [
    null,
    null,
    [`#${shapeRepId}`],
  ]).expressId;

  // `IfcSlab.PredefinedType` only exists from IFC4 onward.
  const slabAttrs: Array<unknown> = [
    generateIfcGuid(),
    `#${ownerHistoryId}`,
    params.Name ?? 'Slab',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    params.Tag ?? null,
  ];
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    slabAttrs.push('.FLOOR.');
  }
  const slabId = editor.addEntity('IfcSlab', slabAttrs as Parameters<StoreEditor['addEntity']>[1]).expressId;

  const relContainedId = editor.addEntity('IfcRelContainedInSpatialStructure', [
    generateIfcGuid(),
    `#${ownerHistoryId}`,
    null,
    null,
    [`#${slabId}`],
    `#${storeyId}`,
  ]).expressId;

  return {
    slabId,
    placementId,
    profileId,
    solidId,
    shapeRepId,
    productShapeId,
    relContainedId,
  };
}
