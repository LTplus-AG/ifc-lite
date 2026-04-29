/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcBeam — emits a beam between two points
 * (Start → End) into a `StoreEditor` overlay. Mirrors
 * `IfcCreator.addIfcBeam` semantics:
 *
 *   - placement origin at `Start`, local Z = beam axis (so the
 *     extrusion runs along the beam)
 *   - local X = a stable perpendicular to the beam axis (chosen via
 *     cross product against world up, falling back to world X for
 *     near-vertical beams to avoid degenerate placements)
 *   - cross-section = rectangle(Width × Height) centred on the axis
 *   - extruded along local Z by the beam length
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { vecCross, vecNorm } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import type { SpatialAnchor } from './anchor.js';

export interface BeamInStoreParams {
  Start: [number, number, number];
  End: [number, number, number];
  /** Cross-section width along local X (metres). */
  Width: number;
  /** Cross-section height along local Y (metres). */
  Height: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface BeamBuildResult {
  beamId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

/**
 * Stable perpendicular to a beam axis. Mirrors IfcCreator.computeRefDirection.
 */
function computeRefDirection(axis: Point3D): Point3D {
  const up: Point3D = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return vecNorm(vecCross(up, axis));
}

export function addBeamToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: BeamInStoreParams,
): BeamBuildResult {
  const { ownerHistoryId, bodyContextId, storeyId, storeyPlacementId } = anchor;

  const dx = params.End[0] - params.Start[0];
  const dy = params.End[1] - params.Start[1];
  const dz = params.End[2] - params.Start[2];
  const beamLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (beamLen <= 0) {
    throw new Error('addBeamToStore: Start and End must be distinct points');
  }
  if (params.Width <= 0 || params.Height <= 0) {
    throw new Error('addBeamToStore: Width and Height must be positive');
  }
  const dir: Point3D = vecNorm([dx, dy, dz]);
  const refDir = computeRefDirection(dir);

  // Placement at Start with local Z along the beam axis.
  const beamOriginPt = editor.addEntity('IfcCartesianPoint', [params.Start]).expressId;
  const axisVec = editor.addEntity('IfcDirection', [dir]).expressId;
  const refDirVec = editor.addEntity('IfcDirection', [refDir]).expressId;
  const beamAxis = editor.addEntity('IfcAxis2Placement3D', [
    `#${beamOriginPt}`,
    `#${axisVec}`,
    `#${refDirVec}`,
  ]).expressId;
  const placementId = editor.addEntity('IfcLocalPlacement', [
    `#${storeyPlacementId}`,
    `#${beamAxis}`,
  ]).expressId;

  // Cross-section centred on the axis.
  const profileOriginPt = editor.addEntity('IfcCartesianPoint', [[0, 0]]).expressId;
  const profilePos = editor.addEntity('IfcAxis2Placement2D', [`#${profileOriginPt}`, null]).expressId;
  const profileId = editor.addEntity('IfcRectangleProfileDef', [
    '.AREA.',
    null,
    `#${profilePos}`,
    params.Width,
    params.Height,
  ]).expressId;

  // Extrude along local Z (= beam direction) for the beam length.
  const solidOriginPt = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const solidAxis = editor.addEntity('IfcAxis2Placement3D', [`#${solidOriginPt}`, null, null]).expressId;
  const extrudeDirection = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  const solidId = editor.addEntity('IfcExtrudedAreaSolid', [
    `#${profileId}`,
    `#${solidAxis}`,
    `#${extrudeDirection}`,
    beamLen,
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

  // `IfcBeam.PredefinedType` only exists from IFC4 onward.
  const beamAttrs: Array<unknown> = [
    generateIfcGuid(),
    `#${ownerHistoryId}`,
    params.Name ?? 'Beam',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    params.Tag ?? null,
  ];
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    beamAttrs.push('.BEAM.');
  }
  const beamId = editor.addEntity('IfcBeam', beamAttrs as Parameters<StoreEditor['addEntity']>[1]).expressId;

  const relContainedId = editor.addEntity('IfcRelContainedInSpatialStructure', [
    generateIfcGuid(),
    `#${ownerHistoryId}`,
    null,
    null,
    [`#${beamId}`],
    `#${storeyId}`,
  ]).expressId;

  return {
    beamId,
    placementId,
    profileId,
    solidId,
    shapeRepId,
    productShapeId,
    relContainedId,
  };
}
