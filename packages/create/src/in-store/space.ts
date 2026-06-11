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
import { toNativeLength, type SpatialAnchor } from './anchor.js';
import {
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitPolygonProfile,
  emitRectangleProfile,
  ownerHistoryRef,
} from './_emit-helpers.js';

export type SpaceInStoreParams = SpaceRectangleParams | SpacePolygonParams;

/** A bounding element for a space → one IfcRelSpaceBoundary. */
export interface SpaceBoundaryInput {
  /** Express id of the bounding building element (e.g. a wall). */
  elementId: number;
  /** INTERNAL (other side is another space) / EXTERNAL (building exterior) /
   *  NOTDEFINED. Defaults to NOTDEFINED. */
  internalOrExternal?: 'INTERNAL' | 'EXTERNAL' | 'NOTDEFINED';
  /** PHYSICAL (a real element) / VIRTUAL. Defaults to PHYSICAL. */
  physicalOrVirtual?: 'PHYSICAL' | 'VIRTUAL';
}

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
  /** Bounding elements → one IfcRelSpaceBoundary each. */
  boundaries?: SpaceBoundaryInput[];
  /** Net (inner-face) floor area in m²; defaults to the OuterCurve area. */
  netFloorArea?: number;
  /** Gross (centreline) floor area in m² for the GrossFloorArea quantity +
   *  GrossVolume; defaults to the OuterCurve area when omitted. */
  grossFloorArea?: number;
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
  /** Bounding elements → one IfcRelSpaceBoundary each. */
  boundaries?: SpaceBoundaryInput[];
  /** Net (inner-face) floor area in m² for Qto_SpaceBaseQuantities; defaults
   *  to the gross/centreline area when omitted. */
  netFloorArea?: number;
  /** Gross (centreline) floor area in m² for GrossFloorArea + GrossVolume;
   *  defaults to the OuterCurve area when omitted. */
  grossFloorArea?: number;
}

export interface SpaceBuildResult {
  spaceId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relAggregatesId: number;
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

  // Geometry coordinates must land in the file's native length unit —
  // params are metres, the file may be millimetres (a space baked into a
  // mm model used to export 1000× too small). Quantities keep their own
  // units below (AREAUNIT/VOLUMEUNIT are typically SI m²/m³ regardless).
  const n = (metres: number) => toNativeLength(anchor, metres);
  const placementId = emitLocalPlacement(
    editor,
    anchor.storeyPlacementId,
    [n(placementOrigin[0]), n(placementOrigin[1]), n(placementOrigin[2])],
  );
  const profileId = polygon
    ? emitPolygonProfile(editor, params.OuterCurve.map(([x, y]): [number, number] => [n(x), n(y)]))
    : emitRectangleProfile(editor, n(params.Width), n(params.Depth), n(params.Width / 2), n(params.Depth / 2));
  const solidId = emitExtrudedSolid(editor, profileId, n(params.Height));
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  // IfcSpace attribute order:
  //   GlobalId, OwnerHistory, Name, Description, ObjectType,
  //   ObjectPlacement, Representation, LongName, CompositionType,
  //   PredefinedType (IFC4 IfcSpaceTypeEnum) / InteriorOrExteriorSpace
  //   (IFC2X3 IfcInternalOrExternalEnum), ElevationWithFlooring
  // INTERNAL is a valid value in both enums, so it makes a safe default.
  const attrs: Array<unknown> = [
    generateIfcGuid(),
    ownerHistoryRef(anchor.ownerHistoryId),
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
    ownerHistoryRef(anchor.ownerHistoryId),
    null,
    null,
    `#${anchor.storeyId}`,
    [`#${spaceId}`],
  ]).expressId;

  // Qto_SpaceBaseQuantities — attached via the property view (createQuantitySet)
  // rather than as raw IfcElementQuantity entities, so they surface in the
  // properties panel (getQuantitiesForEntity) AND export, from one source.
  // `area` is the OuterCurve (net when generated from walls) footprint;
  // GrossFloorArea/GrossVolume take the supplied centreline measure.
  const area = polygon ? polygonArea(params.OuterCurve) : params.Width * params.Depth;
  const perimeter = polygon
    ? polygonPerimeter(params.OuterCurve)
    : 2 * (params.Width + params.Depth);
  const grossArea = params.grossFloorArea ?? area;
  // LENGTH quantities follow the project length unit (mm in a mm file);
  // AREA/VOLUME have their own units which are SI m²/m³ in practice.
  editor.addQuantitySet(spaceId, 'Qto_SpaceBaseQuantities', [
    { name: 'GrossFloorArea', value: grossArea, quantityType: 'AREA' },
    { name: 'NetFloorArea', value: params.netFloorArea ?? area, quantityType: 'AREA' },
    { name: 'GrossPerimeter', value: n(perimeter), quantityType: 'LENGTH' },
    { name: 'Height', value: n(params.Height), quantityType: 'LENGTH' },
    { name: 'GrossVolume', value: grossArea * params.Height, quantityType: 'VOLUME' },
  ]);

  // Pset_SpaceCommon — the standard IfcSpace pset, so the space carries real
  // properties (not just an empty schema template). Planned areas mirror the
  // measured ones; interior space ⇒ not external by default.
  editor.addPropertySet(spaceId, 'Pset_SpaceCommon', [
    { name: 'Reference', value: params.Name ?? '', type: 'LABEL' },
    { name: 'IsExternal', value: false, type: 'BOOLEAN' },
    { name: 'GrossPlannedArea', value: grossArea, type: 'REAL' },
    { name: 'NetPlannedArea', value: params.netFloorArea ?? area, type: 'REAL' },
  ]);

  // Space boundaries — one IfcRelSpaceBoundary per bounding element. Attribute
  // order is stable across IFC2X3/IFC4: GlobalId, OwnerHistory, Name,
  // Description, RelatingSpace, RelatedBuildingElement, ConnectionGeometry,
  // PhysicalOrVirtualBoundary, InternalOrExternalBoundary. Connection geometry
  // + internal/external classification are future refinements.
  const spaceBoundaryIds: number[] = [];
  for (const boundary of params.boundaries ?? []) {
    const boundaryId = editor.addEntity('IfcRelSpaceBoundary', [
      generateIfcGuid(),
      ownerHistoryRef(anchor.ownerHistoryId),
      null,
      null,
      `#${spaceId}`,
      `#${boundary.elementId}`,
      null,
      `.${boundary.physicalOrVirtual ?? 'PHYSICAL'}.`,
      `.${boundary.internalOrExternal ?? 'NOTDEFINED'}.`,
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
    spaceBoundaryIds,
  };
}
