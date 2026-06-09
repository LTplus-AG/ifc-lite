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
  /** Express ids of the building elements bounding this space → one
   *  IfcRelSpaceBoundary each (PHYSICAL/INTERNAL). */
  boundaryElementIds?: number[];
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
  /** Express ids of the building elements bounding this space → one
   *  IfcRelSpaceBoundary each (PHYSICAL/INTERNAL). */
  boundaryElementIds?: number[];
}

export interface SpaceBuildResult {
  spaceId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relAggregatesId: number;
  /** IfcElementQuantity (Qto_SpaceBaseQuantities) emitted for the space. */
  elementQuantityId: number;
  /** IfcRelDefinesByProperties linking the space to its quantities. */
  relQuantityId: number;
  /** One IfcRelSpaceBoundary per bounding element (empty if none supplied). */
  spaceBoundaryIds: number[];
}

/** Absolute polygon area (shoelace), m². */
function polygonArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    acc += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(acc) / 2;
}

/** Polygon perimeter, m. */
function polygonPerimeter(pts: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return s;
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

  // Qto_SpaceBaseQuantities — every derived space carries base quantities for
  // downstream schedules / energy / FM. Area is the centreline (gross)
  // footprint; NetFloorArea == gross until we inset by wall thickness.
  const area = polygon ? polygonArea(params.OuterCurve) : params.Width * params.Depth;
  const perimeter = polygon
    ? polygonPerimeter(params.OuterCurve)
    : 2 * (params.Width + params.Depth);
  const ifc4 = (anchor.schema ?? 'IFC4') !== 'IFC2X3';
  const quantity = (type: string, name: string, value: number): number => {
    // IfcQuantityArea/Length/Volume: (Name, Description, Unit, *Value[, Formula]).
    // The trailing Formula slot exists only in IFC4+.
    const qattrs: unknown[] = [name, null, null, value];
    if (ifc4) qattrs.push(null);
    return editor.addEntity(type, qattrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  };
  const quantityIds = [
    quantity('IfcQuantityArea', 'GrossFloorArea', area),
    quantity('IfcQuantityArea', 'NetFloorArea', area),
    quantity('IfcQuantityLength', 'GrossPerimeter', perimeter),
    quantity('IfcQuantityLength', 'Height', params.Height),
    quantity('IfcQuantityVolume', 'GrossVolume', area * params.Height),
  ];
  const elementQuantityId = editor.addEntity('IfcElementQuantity', [
    generateIfcGuid(),
    `#${anchor.ownerHistoryId}`,
    'Qto_SpaceBaseQuantities',
    null,
    null,
    quantityIds.map((id) => `#${id}`),
  ] as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relQuantityId = editor.addEntity('IfcRelDefinesByProperties', [
    generateIfcGuid(),
    `#${anchor.ownerHistoryId}`,
    null,
    null,
    [`#${spaceId}`],
    `#${elementQuantityId}`,
  ] as Parameters<StoreEditor['addEntity']>[1]).expressId;

  // Space boundaries — one IfcRelSpaceBoundary per bounding element. Attribute
  // order is stable across IFC2X3/IFC4: GlobalId, OwnerHistory, Name,
  // Description, RelatingSpace, RelatedBuildingElement, ConnectionGeometry,
  // PhysicalOrVirtualBoundary, InternalOrExternalBoundary. Connection geometry
  // + internal/external classification are future refinements.
  const spaceBoundaryIds: number[] = [];
  for (const elementId of params.boundaryElementIds ?? []) {
    const boundaryId = editor.addEntity('IfcRelSpaceBoundary', [
      generateIfcGuid(),
      `#${anchor.ownerHistoryId}`,
      null,
      null,
      `#${spaceId}`,
      `#${elementId}`,
      null,
      '.PHYSICAL.',
      '.INTERNAL.',
    ] as Parameters<StoreEditor['addEntity']>[1]).expressId;
    spaceBoundaryIds.push(boundaryId);
  }

  return {
    spaceId,
    placementId,
    profileId,
    solidId,
    shapeRepId,
    productShapeId,
    relAggregatesId,
    elementQuantityId,
    relQuantityId,
    spaceBoundaryIds,
  };
}
