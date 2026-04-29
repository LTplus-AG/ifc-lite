/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcSlab — emits a rectangular floor slab into a
 * `StoreEditor` overlay. Mirrors `IfcCreator.addIfcSlab` semantics:
 *
 *   - placement origin at `Position` (the minimum corner)
 *   - profile = rectangle(Width × Depth) centred at (Width/2, Depth/2)
 *     so the slab spans (Position) → (Position + [Width, Depth, 0])
 *   - extruded upward (local +Z) by `Thickness`
 *
 * Pure: no I/O, no parser access — operates entirely through the editor.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';

export interface SlabInStoreParams {
  /** Minimum corner of the slab, in storey-local coordinates (metres). */
  Position: [number, number, number];
  /** Slab extent along storey-local +X (metres). */
  Width: number;
  /** Slab extent along storey-local +Y (metres). */
  Depth: number;
  /** Slab thickness, extruded along +Z (metres). */
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

export function addSlabToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: SlabInStoreParams,
): SlabBuildResult {
  const { ownerHistoryId, bodyContextId, storeyId, storeyPlacementId } = anchor;

  if (params.Width <= 0 || params.Depth <= 0 || params.Thickness <= 0) {
    throw new Error('addSlabToStore: Width, Depth, Thickness must all be positive');
  }

  // Placement at the minimum corner (no rotation).
  const slabOriginPt = editor.addEntity('IfcCartesianPoint', [params.Position]).expressId;
  const slabAxis = editor.addEntity('IfcAxis2Placement3D', [
    `#${slabOriginPt}`,
    null,
    null,
  ]).expressId;
  const placementId = editor.addEntity('IfcLocalPlacement', [
    `#${storeyPlacementId}`,
    `#${slabAxis}`,
  ]).expressId;

  // Profile centred at (W/2, D/2) so the rectangle spans 0..W × 0..D.
  const profileOriginPt = editor.addEntity('IfcCartesianPoint', [[params.Width / 2, params.Depth / 2]]).expressId;
  const profilePos = editor.addEntity('IfcAxis2Placement2D', [`#${profileOriginPt}`, null]).expressId;
  const profileId = editor.addEntity('IfcRectangleProfileDef', [
    '.AREA.',
    null,
    `#${profilePos}`,
    params.Width,
    params.Depth,
  ]).expressId;

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
