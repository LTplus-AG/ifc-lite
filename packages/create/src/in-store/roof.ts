/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcRoof — a flat roof slab. Same geometry shape
 * as IfcSlab (rectangle or polygon, extruded by Thickness) but emits
 * an IfcRoof entity with `.FLAT_ROOF.` PredefinedType. Pitched roofs
 * (gable / hip / mono-pitch) are out of scope for v1; users who need
 * them can drop a placeholder roof here and refine via Raw STEP, or
 * use `IfcCreator.addIfcGableRoof` for the from-scratch path.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import {
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitPolygonProfile,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ifcElementHeader,
} from './_emit-helpers.js';

export type RoofInStoreParams = RoofRectangleParams | RoofPolygonParams;

export interface RoofRectangleParams {
  Position: [number, number, number];
  Width: number;
  Depth: number;
  Thickness: number;
  Profile?: 'rectangle';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface RoofPolygonParams {
  Profile: 'polygon';
  OuterCurve: Array<[number, number]>;
  Position?: [number, number, number];
  Thickness: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface RoofBuildResult {
  roofId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

function isPolygonParams(p: RoofInStoreParams): p is RoofPolygonParams {
  return p.Profile === 'polygon';
}

export function addRoofToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: RoofInStoreParams,
): RoofBuildResult {
  const polygon = isPolygonParams(params);
  const placementOrigin: [number, number, number] = polygon
    ? params.Position ?? [0, 0, 0]
    : params.Position;

  if (params.Thickness <= 0) {
    throw new Error('addRoofToStore: Thickness must be positive');
  }
  if (!polygon && (params.Width <= 0 || params.Depth <= 0)) {
    throw new Error('addRoofToStore: Width and Depth must be positive');
  }

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, placementOrigin);
  const profileId = polygon
    ? emitPolygonProfile(editor, params.OuterCurve)
    : emitRectangleProfile(editor, params.Width, params.Depth, params.Width / 2, params.Depth / 2);
  const solidId = emitExtrudedSolid(editor, profileId, params.Thickness);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Roof');
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    attrs.push('.FLAT_ROOF.');
  }
  const roofId = editor.addEntity('IfcRoof', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, roofId, anchor.storeyId);

  return { roofId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}
