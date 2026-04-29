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
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { vecNorm } from '../ifc-creator-math.js';
import type { Point3D } from '../types.js';
import type { SpatialAnchor } from './anchor.js';

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
}

export interface WallBuildResult {
  wallId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

export function addWallToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: WallInStoreParams,
): WallBuildResult {
  const { ownerHistoryId, bodyContextId, storeyId, storeyPlacementId } = anchor;

  if (params.Thickness <= 0 || params.Height <= 0) {
    throw new Error('addWallToStore: Thickness and Height must be positive');
  }
  const dx = params.End[0] - params.Start[0];
  const dy = params.End[1] - params.Start[1];
  const dz = params.End[2] - params.Start[2];
  // Walls are extruded along the placement +Z axis (storey up). Sloped
  // endpoints would silently emit invalid geometry, so reject them.
  if (Math.abs(dz) > 1e-9) {
    throw new Error('addWallToStore: Start and End must lie on the same storey plane (Z must match)');
  }
  const wallLen = Math.hypot(dx, dy);
  if (wallLen <= 0) {
    throw new Error('addWallToStore: Start and End must be distinct points');
  }
  const dir: Point3D = vecNorm([dx, dy, 0]);

  // Placement at Start with local X = wall direction. Z stays default
  // (up); STEP's IfcAxis2Placement3D fills the missing axis from there.
  const wallOriginPt = editor.addEntity('IfcCartesianPoint', [params.Start]).expressId;
  const refDirVec = editor.addEntity('IfcDirection', [dir]).expressId;
  const wallAxis = editor.addEntity('IfcAxis2Placement3D', [
    `#${wallOriginPt}`,
    null,
    `#${refDirVec}`,
  ]).expressId;
  const placementId = editor.addEntity('IfcLocalPlacement', [
    `#${storeyPlacementId}`,
    `#${wallAxis}`,
  ]).expressId;

  // Rectangle profile centred at (wallLen/2, 0) so the swept solid
  // spans 0..wallLen along local X and -thickness/2..+thickness/2 on Y.
  const profileOriginPt = editor.addEntity('IfcCartesianPoint', [[wallLen / 2, 0]]).expressId;
  const profilePos = editor.addEntity('IfcAxis2Placement2D', [`#${profileOriginPt}`, null]).expressId;
  const profileId = editor.addEntity('IfcRectangleProfileDef', [
    '.AREA.',
    null,
    `#${profilePos}`,
    wallLen,
    params.Thickness,
  ]).expressId;

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
  const productShapeId = editor.addEntity('IfcProductDefinitionShape', [
    null,
    null,
    [`#${shapeRepId}`],
  ]).expressId;

  // `IfcWall.PredefinedType` only exists from IFC4 onward.
  const wallAttrs: Array<unknown> = [
    generateIfcGuid(),
    `#${ownerHistoryId}`,
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
    generateIfcGuid(),
    `#${ownerHistoryId}`,
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
    productShapeId,
    relContainedId,
  };
}
