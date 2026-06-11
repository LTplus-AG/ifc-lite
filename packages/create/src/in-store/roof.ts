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
import { toNativeLength, toNativePoint2, toNativePoint3, type SpatialAnchor } from './anchor.js';
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
  if (params.Thickness <= 0) {
    throw new Error('addRoofToStore: Thickness must be positive');
  }
  if (!isPolygonParams(params) && (params.Width <= 0 || params.Depth <= 0)) {
    throw new Error('addRoofToStore: Width and Depth must be positive');
  }
  // Params are metres; convert dimensioned fields to the file's native
  // length unit before emit (see SpatialAnchor.lengthUnitScale). A new
  // `const` binding (not a `params` reassignment) keeps TS's aliased
  // discriminator narrowing intact for the union type.
  const p: RoofInStoreParams = isPolygonParams(params)
    ? {
        ...params,
        OuterCurve: params.OuterCurve.map((pt) => toNativePoint2(anchor, pt)),
        Position: params.Position ? toNativePoint3(anchor, params.Position) : params.Position,
        Thickness: toNativeLength(anchor, params.Thickness),
      }
    : {
        ...params,
        Position: toNativePoint3(anchor, params.Position),
        Width: toNativeLength(anchor, params.Width),
        Depth: toNativeLength(anchor, params.Depth),
        Thickness: toNativeLength(anchor, params.Thickness),
      };
  const placementOrigin: [number, number, number] = isPolygonParams(p)
    ? p.Position ?? [0, 0, 0]
    : p.Position;

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, placementOrigin);
  const profileId = isPolygonParams(p)
    ? emitPolygonProfile(editor, p.OuterCurve)
    : emitRectangleProfile(editor, p.Width, p.Depth, p.Width / 2, p.Depth / 2);
  const solidId = emitExtrudedSolid(editor, profileId, p.Thickness);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Roof');
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    attrs.push('.FLAT_ROOF.');
  }
  const roofId = editor.addEntity('IfcRoof', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, roofId, anchor.storeyId);

  return { roofId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}
