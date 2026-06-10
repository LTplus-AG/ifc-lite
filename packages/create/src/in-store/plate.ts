/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcPlate — a thin flat element (steel plate,
 * gusset plate, etc.). Geometry-wise identical to a slab; the
 * distinction is the IFC type and the `.NOTDEFINED.` PredefinedType
 * default (callers can override).
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

export type PlateInStoreParams = PlateRectangleParams | PlatePolygonParams;

export interface PlateRectangleParams {
  Position: [number, number, number];
  Width: number;
  Depth: number;
  Thickness: number;
  Profile?: 'rectangle';
  PredefinedType?: 'CURTAIN_PANEL' | 'SHEET' | 'USERDEFINED' | 'NOTDEFINED';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface PlatePolygonParams {
  Profile: 'polygon';
  OuterCurve: Array<[number, number]>;
  Position?: [number, number, number];
  Thickness: number;
  PredefinedType?: 'CURTAIN_PANEL' | 'SHEET' | 'USERDEFINED' | 'NOTDEFINED';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface PlateBuildResult {
  plateId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

function isPolygonParams(p: PlateInStoreParams): p is PlatePolygonParams {
  return p.Profile === 'polygon';
}

export function addPlateToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: PlateInStoreParams,
): PlateBuildResult {
  if (params.Thickness <= 0) {
    throw new Error('addPlateToStore: Thickness must be positive');
  }
  if (!isPolygonParams(params) && (params.Width <= 0 || params.Depth <= 0)) {
    throw new Error('addPlateToStore: Width and Depth must be positive');
  }
  // Params are metres; convert dimensioned fields to the file's native
  // length unit before emit (see SpatialAnchor.lengthUnitScale). A new
  // `const` binding (not a `params` reassignment) keeps TS's aliased
  // discriminator narrowing intact for the union type.
  const p: PlateInStoreParams = isPolygonParams(params)
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

  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Plate');
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    attrs.push(`.${params.PredefinedType ?? 'NOTDEFINED'}.`);
  }
  const plateId = editor.addEntity('IfcPlate', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, plateId, anchor.storeyId);

  return { plateId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}
