/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcWindow — a free-standing rectangular sash.
 * Same shape as IfcDoor (thin extruded box) but a different IFC type +
 * a different attribute tail (`PartitioningType` / `UserDefinedPartitioningType`).
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
  if (params.Width <= 0 || params.Height <= 0) {
    throw new Error('addWindowToStore: Width and Height must be positive');
  }
  const thickness = params.FrameThickness ?? 0.05;
  if (thickness <= 0) {
    throw new Error('addWindowToStore: FrameThickness must be positive');
  }

  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, params.Position);
  const profileId = emitRectangleProfile(editor, params.Width, thickness);
  const solidId = emitExtrudedSolid(editor, profileId, params.Height);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, anchor.bodyContextId, solidId);

  const isIFC2X3 = (anchor.schema ?? 'IFC4') === 'IFC2X3';
  const attrs = ifcElementHeader(anchor.ownerHistoryId, placementId, productShapeId, params, 'Window');
  attrs.push(params.Height, params.Width);
  if (!isIFC2X3) {
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
    attrs.push(`.${params.PredefinedType ?? 'NOTDEFINED'}.`);
    attrs.push(`.${partitioningType}.`);
    attrs.push(userDefined);
  }

  const windowId = editor.addEntity('IfcWindow', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, anchor.ownerHistoryId, windowId, anchor.storeyId);

  return { windowId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId };
}
