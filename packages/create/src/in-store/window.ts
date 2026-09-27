/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcWindow — a free-standing rectangular sash.
 * Same shape as IfcDoor (thin extruded box) but a different IFC type +
 * a different attribute tail (`PartitioningType` / `UserDefinedPartitioningType`).
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertFinitePoint3 } from '../ifc-creator-math.js';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ifcElementHeader,
} from './_emit-helpers.js';

/**
 * IfcWindowTypePartitioningEnum (IFC4). Anything outside this set is
 * normalised to USERDEFINED + UserDefinedPartitioningType so the
 * exported STEP carries a valid enum token.
 */
const WINDOW_PARTITIONING_ENUM = new Set([
  'SINGLE_PANEL',
  'DOUBLE_PANEL_VERTICAL',
  'DOUBLE_PANEL_HORIZONTAL',
  'TRIPLE_PANEL_VERTICAL',
  'TRIPLE_PANEL_BOTTOM',
  'TRIPLE_PANEL_TOP',
  'TRIPLE_PANEL_LEFT',
  'TRIPLE_PANEL_RIGHT',
  'TRIPLE_PANEL_HORIZONTAL',
  'USERDEFINED',
  'NOTDEFINED',
]);

export interface WindowInStoreParams {
  /** Sill-centre of the window, in storey-local coordinates. */
  Position: [number, number, number];
  Width: number;
  Height: number;
  /** Sash thickness along storey-local +Y. Defaults to 0.05 m. */
  FrameThickness?: number;
  /** IFC4 PredefinedType. Defaults to NOTDEFINED. */
  PredefinedType?: 'WINDOW' | 'SKYLIGHT' | 'LIGHTDOME' | 'USERDEFINED' | 'NOTDEFINED';
  /** IFC4 PartitioningType. Defaults to NOTDEFINED. */
  PartitioningType?: string;
  /** Free-text label when PartitioningType === 'USERDEFINED'. Ignored otherwise. */
  UserDefinedPartitioningType?: string;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface WindowBuildResult {
  windowId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
}

export function addWindowToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: WindowInStoreParams,
): WindowBuildResult {
  assertFinitePoint3({ Position: params.Position }, 'addWindowToStore');
  assertPositiveFinite([params.Width, params.Height], 'addWindowToStore: Width and Height must be positive');
  assertPositiveFinite(
    [params.FrameThickness ?? 0.05],
    'addWindowToStore: FrameThickness must be positive',
  );
  // Params are metres; convert dimensioned fields (incl. the OverallWidth/
  // OverallHeight attributes emitted below) to the file's native length
  // unit before emit (see SpatialAnchor.lengthUnitScale).
  params = {
    ...params,
    Position: toNativePoint3(anchor, params.Position),
    Width: toNativeLength(anchor, params.Width),
    Height: toNativeLength(anchor, params.Height),
    FrameThickness: toNativeLength(anchor, params.FrameThickness ?? 0.05),
  };
  const thickness = params.FrameThickness as number;

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, params.Position);
  const profileId = emitRectangleProfile(editor, params.Width, thickness);
  const solidId = emitExtrudedSolid(editor, profileId, params.Height);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Window', anchor.guidRandom);
  attrs.push(...windowAttributeTail(anchor.schema, params));

  const windowId = editor.addEntity('IfcWindow', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, windowId, anchor.storeyId, anchor.guidRandom);

  return { windowId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}

/**
 * IfcWindow's attributes after the IfcElement header: OverallHeight and
 * OverallWidth in every schema, then PredefinedType / PartitioningType /
 * UserDefinedPartitioningType from IFC4 on. Shared by the hosted window
 * builder. `Height`/`Width` must already be in the native length unit.
 */
export function windowAttributeTail(
  schema: SpatialAnchor['schema'],
  params: Pick<WindowInStoreParams, 'Height' | 'Width' | 'PredefinedType' | 'PartitioningType' | 'UserDefinedPartitioningType'>,
): unknown[] {
  const tail: unknown[] = [params.Height, params.Width];
  if ((schema ?? 'IFC4') === 'IFC2X3') return tail;
  // Free-form values that aren't part of IfcWindowTypePartitioningEnum
  // are normalised to .USERDEFINED. + UserDefinedPartitioningType so
  // they round-trip through STEP without producing invalid `.<value>.`
  // enum tokens.
  const requested = params.PartitioningType ?? 'NOTDEFINED';
  const isKnownEnum = WINDOW_PARTITIONING_ENUM.has(requested);
  const partitioningType = isKnownEnum ? requested : 'USERDEFINED';
  const userDefined = partitioningType === 'USERDEFINED'
    ? (isKnownEnum ? params.UserDefinedPartitioningType ?? null : requested)
    : null;
  tail.push(`.${params.PredefinedType ?? 'NOTDEFINED'}.`, `.${partitioningType}.`, userDefined);
  return tail;
}
