/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcRoof. Without footprint fields it is a flat roof
 * slab: the same geometry as IfcSlab (rectangle or polygon, extruded by
 * Thickness) on an IfcRoof with `.FLAT_ROOF.` PredefinedType. With
 * `EdgeSlopes` or `Overhang` it is a roof by footprint (`roof-footprint.ts`):
 * hip, gable, mono-pitch and L-shaped roofs from a slope per footprint edge.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
import { toNativeLength, toNativePoint2, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitPolygonProfile,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ifcElementHeader,
} from './_emit-helpers.js';
import { emitFootprintRoofBody, footprintDefinition, writeFootprintDefinition, type RoofFootprintFields } from './roof-footprint.js';

export type RoofInStoreParams = RoofRectangleParams | RoofPolygonParams;

export interface RoofRectangleParams extends RoofFootprintFields {
  Position: [number, number, number];
  Width: number;
  Depth: number;
  Thickness: number;
  Profile?: 'rectangle';
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface RoofPolygonParams extends RoofFootprintFields {
  Profile: 'polygon';
  OuterCurve: Array<[number, number]>;
  Position?: [number, number, number];
  Thickness: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface RoofBuildResult {
  roofId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
  /** Every plane's solid of a roof by footprint (its first is `solidId`). */
  solidIds?: number[];
}

function isPolygonParams(p: RoofInStoreParams): p is RoofPolygonParams {
  return p.Profile === 'polygon';
}

export function addRoofToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: RoofInStoreParams,
): RoofBuildResult {
  if (params.EdgeSlopes !== undefined || params.Overhang !== undefined) return addFootprintRoofToStore(editor, anchor, params);
  assertPositiveFinite([params.Thickness], 'addRoofToStore: Thickness must be positive');
  if (params.Position !== undefined) {
    assertFinitePoint3({ Position: params.Position }, 'addRoofToStore');
  }
  if (!isPolygonParams(params)) {
    assertPositiveFinite(
      [params.Width, params.Depth],
      'addRoofToStore: Width and Depth must be positive',
    );
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

  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Roof', anchor.guidRandom);
  if ((anchor.schema ?? 'IFC4') !== 'IFC2X3') {
    attrs.push('.FLAT_ROOF.');
  }
  const roofId = editor.addEntity('IfcRoof', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, roofId, anchor.storeyId, anchor.guidRandom);

  return { roofId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}

/**
 * A roof by footprint: the outline is the polygon (or the rectangle from its
 * Position corner) in the placement's plan, the underside passes through every
 * sloped edge at the placement's height, and the definition is recorded on the
 * roof so an edit can rebuild it.
 */
function addFootprintRoofToStore(editor: StoreEditor, anchor: SpatialAnchor, params: RoofInStoreParams): RoofBuildResult {
  assertPositiveFinite([params.Thickness], 'addRoofToStore: Thickness must be positive');
  if (params.Position !== undefined) assertFinitePoint3({ Position: params.Position }, 'addRoofToStore');
  let footprint: Array<[number, number]>;
  if (isPolygonParams(params)) {
    footprint = params.OuterCurve.map((p) => [p[0], p[1]]);
  } else {
    assertPositiveFinite([params.Width, params.Depth], 'addRoofToStore: Width and Depth must be positive');
    footprint = [[0, 0], [params.Width, 0], [params.Width, params.Depth], [0, params.Depth]];
  }
  const definition = footprintDefinition(footprint, params, params.Thickness);
  const body = emitFootprintRoofBody(editor, anchor, anchor.bodyContextId, definition);
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, toNativePoint3(anchor, params.Position ?? [0, 0, 0]));
  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, body.productShapeId, params, 'Roof', anchor.guidRandom);
  // IFC4 PredefinedType and IFC2X3 ShapeType share the slot and these values.
  attrs.push(`.${body.plan.shapeType}.`);
  const roofId = editor.addEntity('IfcRoof', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, roofId, anchor.storeyId, anchor.guidRandom);
  writeFootprintDefinition(editor.getMutationView(), roofId, { ...definition, PredefinedType: body.plan.shapeType });
  return {
    roofId, placementId, profileId: body.profileIds[0], solidId: body.solidIds[0], solidIds: body.solidIds,
    shapeRepId: body.shapeRepId, productShapeId: body.productShapeId, relContainedId,
  };
}
