/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for a straight-run stair (#6232): an IfcStair contained in
 * the storey, aggregating one IfcStairFlight that carries the body.
 *
 * Same footprint as `IfcCreator.addIfcStair` (`Position` is the foot of the
 * first riser, the run goes along local +X rotated by `Direction`, the width
 * spans local +Y, step i covers x in [i·T, (i+1)·T] and rises to (i+1)·R), but
 * the body is one extruded stepped profile instead of one box per riser: a
 * single IfcArbitraryClosedProfileDef in the stair's XZ plane, extruded across
 * the width. With `WaistThickness` the underside follows the pitch line (a
 * cast-in-place flight); without it the flight is solid down to its base, the
 * volume IfcCreator's stacked treads enclose.
 *
 * The IfcStair itself has no representation: its geometry is its flight's,
 * which is how IFC4 decomposes a stair (IfcRelAggregates, stair -> flight).
 * The flight's placement is relative to the stair's, so moving the stair
 * moves the flight.
 *
 * Schema gating (D2): attributes are laid out from the target schema's
 * registry, so IFC2X3 gets `IfcStair.ShapeType` and
 * `IfcStairFlight.NumberOfRiser` (its spelling) with no flight PredefinedType,
 * IFC4/IFC4X3 get `PredefinedType`s, and IFC5 is refused.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitBodyRepresentation,
  emitLocalPlacement,
  emitPolygonProfile,
  emitRelContainedInSpatialStructure,
  ownerHistoryRef,
  productGuid,
} from './_emit-helpers.js';
import { schemaAttributes, schemaRegistry } from './schema-attributes.js';

type Attrs = Parameters<StoreEditor['addEntity']>[1];

export interface StairInStoreParams {
  /** Foot of the first riser, storey-local (metres). */
  Position: [number, number, number];
  /** Run direction in the XY plane, radians (0 = +X). Default 0. */
  Direction?: number;
  /** Number of risers (a positive integer). */
  NumberOfRisers: number;
  /** Riser height (metres). */
  RiserHeight: number;
  /** Tread length / going (metres). */
  TreadLength: number;
  /** Clear width across the run (metres). */
  Width: number;
  /**
   * Waist thickness measured perpendicular to the pitch line (metres). When
   * set the flight's underside follows the pitch; omitted, the flight is solid
   * down to its base. Must leave material under the top tread.
   */
  WaistThickness?: number;
  /** IfcStair PredefinedType / ShapeType. Default `STRAIGHT_RUN_STAIR`. */
  PredefinedType?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId for the IfcStair (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
  /** Explicit GlobalId for the IfcStairFlight; generated when omitted. */
  FlightGlobalId?: string;
}

export interface StairBuildResult {
  stairId: number;
  flightId: number;
  placementId: number;
  flightPlacementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relAggregatesId: number;
  relContainedId: number;
}

/**
 * The flight's side outline in (run, rise) coordinates, native units: the
 * stepped top, then the underside. Counter-clockwise.
 */
export function stairFlightOutline(
  risers: number,
  riser: number,
  tread: number,
  waist?: number,
): Array<[number, number]> {
  const top: Array<[number, number]> = [[0, 0]];
  for (let i = 0; i < risers; i++) {
    top.push([i * tread, (i + 1) * riser], [(i + 1) * tread, (i + 1) * riser]);
  }
  const run = risers * tread;
  const rise = risers * riser;
  if (waist === undefined) {
    // Solid to the base: down the back, along the floor.
    return [...top, [run, 0] as [number, number]].reverse();
  }
  // Underside parallel to the pitch line z = x·R/T, `waist` below it
  // (perpendicular), i.e. a vertical drop of waist / cos(pitch).
  const drop = waist * Math.hypot(riser, tread) / tread;
  const foot = drop * tread / riser; // where the underside meets the floor
  const underside: Array<[number, number]> = [[run, rise - drop], [foot, 0]];
  return [...top, ...underside].reverse();
}

/** Package-private validation shared by creation and occurrence edits. */
export function assertStairParams(params: StairInStoreParams, op: string): void {
  assertFinitePoint3({ Position: params.Position }, op);
  if (!Number.isInteger(params.NumberOfRisers) || params.NumberOfRisers < 1) {
    throw new Error(`${op}: NumberOfRisers must be a positive integer`);
  }
  assertPositiveFinite(
    [params.RiserHeight, params.TreadLength, params.Width],
    `${op}: RiserHeight, TreadLength and Width must be finite positive numbers`,
  );
  if (params.Direction !== undefined && !Number.isFinite(params.Direction)) {
    throw new Error(`${op}: Direction must be a finite number (radians)`);
  }
  if (params.WaistThickness !== undefined) {
    assertPositiveFinite([params.WaistThickness], `${op}: WaistThickness must be a finite positive number`);
    const drop = params.WaistThickness * Math.hypot(params.RiserHeight, params.TreadLength) / params.TreadLength;
    if (drop >= params.NumberOfRisers * params.RiserHeight) {
      throw new Error(`${op}: WaistThickness is too thick for a flight of this height`);
    }
  }
}

export function addStairToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: StairInStoreParams,
): StairBuildResult {
  const op = 'addStairToStore';
  assertStairParams(params, op);
  const registry = schemaRegistry(anchor.schema, op);
  const isIfc2x3 = registry.name.toUpperCase() === 'IFC2X3';
  const shapeType = params.PredefinedType ?? 'STRAIGHT_RUN_STAIR';
  const stairGuid = productGuid(params, anchor.guidRandom);
  const flightGuid = productGuid({ GlobalId: params.FlightGlobalId }, anchor.guidRandom);
  const stairValues = (placement: string | null) => ({
    GlobalId: stairGuid,
    OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
    Name: params.Name ?? 'Stair',
    Description: params.Description,
    ObjectType: params.ObjectType,
    ObjectPlacement: placement,
    Tag: params.Tag,
    [isIfc2x3 ? 'ShapeType' : 'PredefinedType']: shapeType,
  });
  // Lay the stair record out once before the first emit, so a bad
  // PredefinedType or a missing IFC2X3 OwnerHistory refuses cleanly.
  schemaAttributes(registry, 'IfcStair', stairValues(null), op);

  const riser = toNativeLength(anchor, params.RiserHeight);
  const tread = toNativeLength(anchor, params.TreadLength);
  const width = toNativeLength(anchor, params.Width);
  const waist = params.WaistThickness === undefined ? undefined : toNativeLength(anchor, params.WaistThickness);
  const direction = params.Direction ?? 0;

  // Stair placement: at Position, local X along the run. Written with
  // explicit axes so the stair can be turned later (rotateEntity edits the
  // RefDirection).
  const placementId = emitLocalPlacement(
    editor,
    anchor.storeyPlacementId,
    toNativePoint3(anchor, params.Position),
    [0, 0, 1],
    [Math.cos(direction), Math.sin(direction), 0],
  );
  const flightPlacementId = emitLocalPlacement(editor, placementId, [0, 0, 0]);

  const { profileId, solidId } = emitStairFlightBody(editor, params.NumberOfRisers, riser, tread, width, waist);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const stairId = editor.addEntity(
    'IfcStair',
    schemaAttributes(registry, 'IfcStair', stairValues(`#${placementId}`), op) as Attrs,
  ).expressId;

  const flightId = editor.addEntity('IfcStairFlight', schemaAttributes(registry, 'IfcStairFlight', {
    GlobalId: flightGuid,
    OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
    Name: `${params.Name ?? 'Stair'} Flight`,
    ObjectPlacement: `#${flightPlacementId}`,
    Representation: `#${productShapeId}`,
    [isIfc2x3 ? 'NumberOfRiser' : 'NumberOfRisers']: params.NumberOfRisers,
    NumberOfTreads: params.NumberOfRisers,
    RiserHeight: riser,
    TreadLength: tread,
    ...(isIfc2x3 ? {} : { PredefinedType: 'STRAIGHT' }),
  }, op) as Attrs).expressId;

  const relAggregatesId = editor.addEntity('IfcRelAggregates', schemaAttributes(registry, 'IfcRelAggregates', {
    GlobalId: generateIfcGuid(anchor.guidRandom),
    OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
    RelatingObject: `#${stairId}`,
    RelatedObjects: [`#${flightId}`],
  }, op) as Attrs).expressId;

  const relContainedId = emitRelContainedInSpatialStructure(
    editor, anchor.ownerHistoryId, stairId, anchor.storeyId, anchor.guidRandom,
  );

  return {
    stairId,
    flightId,
    placementId,
    flightPlacementId,
    profileId,
    solidId,
    shapeRepId,
    productShapeId,
    relAggregatesId,
    relContainedId,
  };
}

/** The canonical stepped solid, in native units; package-private. */
export function emitStairFlightBody(editor: StoreEditor, risers: number, riser: number, tread: number, width: number, waist?: number) {
  // The stepped side outline lies in the solid's XY plane. The solid's frame
  // maps profile X -> stair +X (run) and profile Y -> stair +Z (rise) with
  // extrusion along -Y, from y = width, so the flight spans y in [0, width].
  const profileId = emitPolygonProfile(editor, stairFlightOutline(risers, riser, tread, waist));
  const solidOrigin = editor.addEntity('IfcCartesianPoint', [[0, width, 0]]).expressId;
  const solidAxis = editor.addEntity('IfcDirection', [[0, -1, 0]]).expressId;
  const solidRef = editor.addEntity('IfcDirection', [[1, 0, 0]]).expressId;
  const solidPosition = editor.addEntity('IfcAxis2Placement3D', [
    `#${solidOrigin}`, `#${solidAxis}`, `#${solidRef}`,
  ]).expressId;
  const extrusion = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  const solidId = editor.addEntity('IfcExtrudedAreaSolid', [
    `#${profileId}`, `#${solidPosition}`, `#${extrusion}`, width,
  ]).expressId;
  return { profileId, solidId };
}
