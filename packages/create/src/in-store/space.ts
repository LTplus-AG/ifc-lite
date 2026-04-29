/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcSpace — a 3D room volume defined by an
 * outer polyline and a height. The user-facing flow is the slab
 * polygon flow plus a Height for the vertical extrusion.
 *
 * IfcSpace is an IfcSpatialStructureElement (not an IfcElement), so:
 *   - it doesn't slot into IfcRelContainedInSpatialStructure (which
 *     contains products); instead use IfcRelAggregates with the
 *     parent storey
 *   - the attribute tail differs: LongName at index 7, then
 *     CompositionType (.ELEMENT.), InteriorOrExteriorSpace
 *     (.INTERNAL.), ElevationWithFlooring
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import {
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitPolygonProfile,
  emitRectangleProfile,
} from './_emit-helpers.js';

export type SpaceInStoreParams = SpaceRectangleParams | SpacePolygonParams;

export interface SpaceRectangleParams {
  Position: [number, number, number];
  Width: number;
  Depth: number;
  Height: number;
  Profile?: 'rectangle';
  Name?: string;
  LongName?: string;
  Description?: string;
  ObjectType?: string;
  /**
   * Slot 9 enum (without dots). IFC4 IfcSpaceTypeEnum
   * (e.g. INTERNAL/EXTERNAL/USERDEFINED/NOTDEFINED), or the IFC2X3
   * IfcInternalOrExternalEnum. Defaults to INTERNAL.
   */
  PredefinedType?: string;
}

export interface SpacePolygonParams {
  Profile: 'polygon';
  OuterCurve: Array<[number, number]>;
  Position?: [number, number, number];
  Height: number;
  Name?: string;
  LongName?: string;
  Description?: string;
  ObjectType?: string;
  /** See SpaceRectangleParams.PredefinedType. */
  PredefinedType?: string;
}

export interface SpaceBuildResult {
  spaceId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relAggregatesId: number;
}

function isPolygonParams(p: SpaceInStoreParams): p is SpacePolygonParams {
  return p.Profile === 'polygon';
}

export function addSpaceToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: SpaceInStoreParams,
): SpaceBuildResult {
  const polygon = isPolygonParams(params);
  const placementOrigin: [number, number, number] = polygon
    ? params.Position ?? [0, 0, 0]
    : params.Position;

  if (params.Height <= 0) {
    throw new Error('addSpaceToStore: Height must be positive');
  }
  if (!polygon && (params.Width <= 0 || params.Depth <= 0)) {
    throw new Error('addSpaceToStore: Width and Depth must be positive');
  }

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, placementOrigin);
  const profileId = polygon
    ? emitPolygonProfile(editor, params.OuterCurve)
    : emitRectangleProfile(editor, params.Width, params.Depth, params.Width / 2, params.Depth / 2);
  const solidId = emitExtrudedSolid(editor, profileId, params.Height);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  // IfcSpace attribute order:
  //   GlobalId, OwnerHistory, Name, Description, ObjectType,
  //   ObjectPlacement, Representation, LongName, CompositionType,
  //   PredefinedType (IFC4 IfcSpaceTypeEnum) / InteriorOrExteriorSpace
  //   (IFC2X3 IfcInternalOrExternalEnum), ElevationWithFlooring
  // INTERNAL is a valid value in both enums, so it makes a safe default.
  const attrs: Array<unknown> = [
    generateIfcGuid(),
    `#${anchor.ownerHistoryId}`,
    params.Name ?? 'Space',
    params.Description ?? null,
    params.ObjectType ?? null,
    `#${placementId}`,
    `#${productShapeId}`,
    params.LongName ?? null,
    '.ELEMENT.',
    `.${params.PredefinedType ?? 'INTERNAL'}.`,
    null,
  ];
  const spaceId = editor.addEntity('IfcSpace', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;

  // Spatial-structure parents use IfcRelAggregates, not the
  // ContainedInSpatialStructure rel that IfcElement subtypes use.
  const relAggregatesId = editor.addEntity('IfcRelAggregates', [
    generateIfcGuid(),
    `#${anchor.ownerHistoryId}`,
    null,
    null,
    `#${anchor.storeyId}`,
    [`#${spaceId}`],
  ]).expressId;

  return { spaceId, placementId, profileId, solidId, shapeRepId, productShapeId, relAggregatesId };
}
