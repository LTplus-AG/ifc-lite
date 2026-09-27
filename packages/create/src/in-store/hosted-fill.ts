/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall-hosted IfcDoor / IfcWindow: cut an IfcOpeningElement into the host
 * wall (`addOpeningToStore`), then place the filling in it and link the two
 * with IfcRelFillsElement — the in-store counterpart of
 * `IfcCreator.addIfcWallDoor` / `addIfcWallWindow`.
 *
 * The filling's ObjectPlacement is relative to the OPENING's placement, so
 * moving the opening along its host carries the door or window with it. Its
 * own frame is the conventional one for a door or window: X along the wall,
 * Y across the wall, Z up. The leaf is `Width × FrameThickness` centred in
 * the wall's body and extruded up by `Height`. The filling is contained in
 * the host's storey; the opening, per IFC, is not.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { toNativeLength, type HostAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitRectangleProfile,
  emitRelContainedInSpatialStructure,
  ifcElementHeader,
  ownerHistoryRef,
} from './_emit-helpers.js';
import { addOpeningToStore, type OpeningBuildResult } from './opening.js';
import { doorAttributeTail, type DoorInStoreParams } from './door.js';
import { windowAttributeTail, type WindowInStoreParams } from './window.js';

interface HostedPlacementParams {
  /** Distance along the host wall's local X from its placement origin to the filling's centre (metres). */
  Offset: number;
  /** Length of the opening cut through the wall (metres). Defaults to the wall's body thickness + 2 × 50 mm. */
  CutDepth?: number;
}

export interface HostedDoorInStoreParams extends Omit<DoorInStoreParams, 'Position'>, HostedPlacementParams {
  /** Height of the door's bottom above the wall's placement origin (metres). Defaults to 0. */
  Sill?: number;
}

export interface HostedWindowInStoreParams extends Omit<WindowInStoreParams, 'Position'>, HostedPlacementParams {
  /** Height of the window's bottom edge above the wall's placement origin (metres). */
  Sill: number;
}

export interface HostedFillBuildResult {
  /** The IfcDoor or IfcWindow. */
  fillingId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relContainedId: number;
  relFillsId: number;
  opening: OpeningBuildResult;
}

export function addHostedDoorToStore(
  editor: StoreEditor,
  host: HostAnchor,
  params: HostedDoorInStoreParams,
): HostedFillBuildResult {
  return addHostedFill(editor, host, 'IfcDoor', params.Sill ?? 0, params, (native) => doorAttributeTail(host.schema, { ...params, ...native }));
}

export function addHostedWindowToStore(
  editor: StoreEditor,
  host: HostAnchor,
  params: HostedWindowInStoreParams,
): HostedFillBuildResult {
  return addHostedFill(editor, host, 'IfcWindow', params.Sill, params, (native) => windowAttributeTail(host.schema, { ...params, ...native }));
}

function addHostedFill(
  editor: StoreEditor,
  host: HostAnchor,
  type: 'IfcDoor' | 'IfcWindow',
  sill: number,
  params: HostedPlacementParams & Pick<DoorInStoreParams, 'Width' | 'Height' | 'FrameThickness' | 'Name' | 'Description' | 'ObjectType' | 'Tag' | 'GlobalId'>,
  tail: (native: { Width: number; Height: number }) => unknown[],
): HostedFillBuildResult {
  const op = type === 'IfcDoor' ? 'addHostedDoorToStore' : 'addHostedWindowToStore';
  if (host.hostKind !== 'wall') throw new Error(`${op}: host #${host.hostId} is a ${host.hostKind}; doors and windows are hosted in walls`);
  assertPositiveFinite([params.Width, params.Height], `${op}: Width and Height must be positive`);
  const frameThickness = params.FrameThickness ?? 0.05;
  assertPositiveFinite([frameThickness], `${op}: FrameThickness must be positive`);
  if (!Number.isFinite(params.Offset) || !Number.isFinite(sill)) throw new Error(`${op}: Offset and Sill must be finite`);

  const label = type === 'IfcDoor' ? 'Door' : 'Window';
  const opening = addOpeningToStore(editor, host, {
    Offset: params.Offset,
    Sill: sill,
    Width: params.Width,
    Height: params.Height,
    CutDepth: params.CutDepth,
    Name: `${params.Name ?? label} Opening`,
  });

  // The opening's frame is X = wall X, Y = wall Z, Z = wall -Y, with its
  // origin on the cut's +Y face. Axis = opening Y and RefDirection = opening
  // X turn that back into X along the wall, Z up; the origin moves half the
  // cut into the wall, i.e. onto the body's centre plane.
  const placementId = emitLocalPlacement(editor, opening.placementId, [0, 0, opening.cutDepth / 2], [0, 1, 0], [1, 0, 0]);
  const width = toNativeLength(host, params.Width);
  const height = toNativeLength(host, params.Height);
  const profileId = emitRectangleProfile(editor, width, toNativeLength(host, frameThickness));
  const solidId = emitExtrudedSolid(editor, profileId, height);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, host.bodyContextId, solidId);

  const attrs = ifcElementHeader(host.ownerHistoryId, placementId, productShapeId, params, label, host.guidRandom);
  attrs.push(...tail({ Width: width, Height: height }));
  const fillingId = editor.addEntity(type, attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;

  const relFillsId = editor.addEntity('IfcRelFillsElement', [
    generateIfcGuid(host.guidRandom),
    ownerHistoryRef(host.ownerHistoryId),
    null,
    null,
    `#${opening.openingId}`,
    `#${fillingId}`,
  ]).expressId;
  const relContainedId = emitRelContainedInSpatialStructure(editor, host.ownerHistoryId, fillingId, host.storeyId, host.guidRandom);

  return { fillingId, placementId, profileId, solidId, shapeRepId, productShapeId, relContainedId, relFillsId, opening };
}
