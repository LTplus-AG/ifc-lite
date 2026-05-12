/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcDoor — a free-standing rectangular leaf.
 *
 * v1 places a door without cutting an opening in any wall (callers
 * who need a wall-hosted door can use `IfcCreator.addIfcWallDoor`
 * for now). Geometry is a thin solid: `Width × FrameThickness ×
 * Height` extruded up.
 *
 * The IFC4 IfcDoor entity adds `OverallHeight`, `OverallWidth`,
 * `PredefinedType`, `OperationType`, `UserDefinedOperationType` to
 * the IfcElement header. IFC2X3 stops at OverallHeight + OverallWidth
 * (no PredefinedType / OperationType slots).
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import {
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ifcElementHeader,
} from './_emit-helpers.js';

/**
 * IfcDoorTypeOperationEnum (IFC4). Anything outside this set is
 * normalised to USERDEFINED + UserDefinedOperationType so the exported
 * STEP carries a valid enum token.
 */
const DOOR_OPERATION_ENUM = new Set([
  'SINGLE_SWING_LEFT',
  'SINGLE_SWING_RIGHT',
  'DOUBLE_DOOR_SINGLE_SWING',
  'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_LEFT',
  'DOUBLE_DOOR_SINGLE_SWING_OPPOSITE_RIGHT',
  'DOUBLE_SWING_LEFT',
  'DOUBLE_SWING_RIGHT',
  'DOUBLE_DOOR_DOUBLE_SWING',
  'SLIDING_TO_LEFT',
  'SLIDING_TO_RIGHT',
  'DOUBLE_DOOR_SLIDING',
  'FOLDING_TO_LEFT',
  'FOLDING_TO_RIGHT',
  'DOUBLE_DOOR_FOLDING',
  'REVOLVING',
  'ROLLINGUP',
  'SWING_FIXED_LEFT',
  'SWING_FIXED_RIGHT',
  'USERDEFINED',
  'NOTDEFINED',
]);

export interface DoorInStoreParams {
  /** Bottom-centre of the door leaf, in storey-local coordinates. */
  Position: [number, number, number];
  Width: number;
  Height: number;
  /** Door leaf depth along storey-local +Y (metres). Defaults to 0.05. */
  FrameThickness?: number;
  /** IFC4 PredefinedType enum (without the dots). Defaults to NOTDEFINED. */
  PredefinedType?: 'DOOR' | 'GATE' | 'TRAPDOOR' | 'USERDEFINED' | 'NOTDEFINED';
  /** IFC4 OperationType enum (without the dots). Defaults to SINGLE_SWING_LEFT. */
  OperationType?: string;
  /** Free-text label when OperationType === 'USERDEFINED'. Ignored otherwise. */
  UserDefinedOperationType?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
}

export interface DoorBuildResult {
  doorId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

export function addDoorToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: DoorInStoreParams,
): DoorBuildResult {
  if (params.Width <= 0 || params.Height <= 0) {
    throw new Error('addDoorToStore: Width and Height must be positive');
  }
  const thickness = params.FrameThickness ?? 0.05;
  if (thickness <= 0) {
    throw new Error('addDoorToStore: FrameThickness must be positive');
  }

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, params.Position);
  // Profile centred at the placement origin so the leaf is bottom-
  // centred — matches IfcCreator's free-standing door convention.
  const profileId = emitRectangleProfile(editor, params.Width, thickness);
  const solidId = emitExtrudedSolid(editor, profileId, params.Height);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const isIFC2X3 = (anchor.schema ?? 'IFC4') === 'IFC2X3';
  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Door');
  // OverallHeight / OverallWidth are present on IfcDoor in both schemas.
  attrs.push(params.Height, params.Width);
  if (!isIFC2X3) {
    // Free-form values outside IfcDoorTypeOperationEnum are normalised
    // to USERDEFINED + UserDefinedOperationType so the exported STEP
    // carries a valid enum token rather than `.<value>.`.
    const requested = params.OperationType ?? 'SINGLE_SWING_LEFT';
    const isKnownEnum = DOOR_OPERATION_ENUM.has(requested);
    const operationType = isKnownEnum ? requested : 'USERDEFINED';
    const userDefined = operationType === 'USERDEFINED'
      ? (isKnownEnum ? params.UserDefinedOperationType ?? null : requested)
      : null;
    attrs.push(`.${params.PredefinedType ?? 'NOTDEFINED'}.`);
    attrs.push(`.${operationType}.`);
    attrs.push(userDefined);
  }

  const doorId = editor.addEntity('IfcDoor', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, doorId, anchor.storeyId);

  return { doorId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}
