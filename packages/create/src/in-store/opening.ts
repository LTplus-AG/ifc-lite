/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for IfcOpeningElement + IfcRelVoidsElement — a rectangular
 * void cut into an existing wall or slab (the in-store counterpart of
 * `IfcCreator`'s private `addWallOpening` / `addSlabOpening`).
 *
 * The opening is placed relative to the HOST's IfcLocalPlacement, so it moves
 * with the host, and it is NOT contained in the storey: IFC places an opening
 * in the spatial structure only through the element it voids.
 *
 *   - wall host: the profile sits in the wall's XZ plane (X along the axis,
 *     Z up) and is extruded across the wall's local Y, centred on the wall's
 *     body, by `CutDepth` (default: body thickness plus 50 mm per side)
 *   - slab host: the profile sits in the slab's XY plane and is extruded along
 *     +Z from 50 mm below the body to 50 mm above it
 *
 * All params are metres, converted to the file's native unit on emit.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { toNativeLength, type HostAnchor } from './anchor.js';
import {
  assertPositiveFinite,
  emitBodyRepresentation,
  emitExtrudedSolid,
  emitLocalPlacement,
  emitRectangleProfile,
  ifcElementHeader,
  ownerHistoryRef,
} from './_emit-helpers.js';

/** Metres the default cut overshoots each face of the host, so no skin survives. */
const CUT_CLEARANCE_M = 0.05;

interface OpeningCommonParams {
  /** Length of the cut through the host (metres). Defaults to the host's body thickness + 2 × 50 mm. */
  CutDepth?: number;
  Name?: string;
  Description?: string;
  ObjectType?: string;
  Tag?: string;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

/** Opening in a wall, in the wall's own placement frame. */
export interface WallOpeningInStoreParams extends OpeningCommonParams {
  /** Distance along the wall's local X axis from its placement origin to the opening centre (metres). */
  Offset: number;
  /** Height of the opening's bottom edge above the wall's placement origin (metres). Defaults to 0. */
  Sill?: number;
  Width: number;
  Height: number;
}

/** Opening in a slab, in the slab's own placement frame. */
export interface SlabOpeningInStoreParams extends OpeningCommonParams {
  /** Centre of the opening in the slab's local XY (metres). */
  Position: [number, number];
  /** Size along the slab's local X (metres). */
  Width: number;
  /** Size along the slab's local Y (metres). */
  Depth: number;
}

export type OpeningInStoreParams = WallOpeningInStoreParams | SlabOpeningInStoreParams;

export interface OpeningBuildResult {
  openingId: number;
  placementId: number;
  profileId: number;
  solidId: number;
  shapeRepId: number;
  productShapeId: number;
  relVoidsId: number;
  /** Native-unit cut length actually emitted. */
  cutDepth: number;
}

export function addOpeningToStore(
  editor: StoreEditor,
  host: HostAnchor,
  params: OpeningInStoreParams,
): OpeningBuildResult {
  const geometry = host.hostKind === 'wall'
    ? wallOpeningGeometry(editor, host, params)
    : slabOpeningGeometry(editor, host, params);
  const { shapeRepId, productShapeId } = emitBodyRepresentation(editor, host.bodyContextId, geometry.solidId);

  const attrs = ifcElementHeader(host.ownerHistoryId, geometry.placementId, productShapeId, params, 'Opening', host.guidRandom);
  // IfcOpeningElement.PredefinedType exists from IFC4 on (IFC4X3 keeps it).
  if ((host.schema ?? 'IFC4') !== 'IFC2X3') attrs.push('.OPENING.');
  const openingId = editor.addEntity('IfcOpeningElement', attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;

  const relVoidsId = editor.addEntity('IfcRelVoidsElement', [
    generateIfcGuid(host.guidRandom),
    ownerHistoryRef(host.ownerHistoryId),
    null,
    null,
    `#${host.hostId}`,
    `#${openingId}`,
  ]).expressId;

  return { openingId, shapeRepId, productShapeId, relVoidsId, ...geometry };
}

interface OpeningGeometry {
  placementId: number;
  profileId: number;
  solidId: number;
  cutDepth: number;
}

/** Native-unit cut depth: the caller's, or the host thickness plus clearance. Never shallower than the host. */
function resolveCutDepth(host: HostAnchor, thickness: number | null, requested: number | undefined, op: string): number {
  if (requested !== undefined) {
    assertPositiveFinite([requested], `${op}: CutDepth must be positive`);
    const cut = toNativeLength(host, requested);
    if (thickness !== null && cut < thickness) {
      throw new Error(`${op}: CutDepth ${requested} is shallower than the host #${host.hostId} body; the opening would not cut through`);
    }
    return cut;
  }
  if (thickness === null) {
    throw new Error(`${op}: cannot read the thickness of host #${host.hostId} from its Body geometry; pass CutDepth`);
  }
  return thickness + 2 * toNativeLength(host, CUT_CLEARANCE_M);
}

function wallOpeningGeometry(editor: StoreEditor, host: HostAnchor, params: OpeningInStoreParams): OpeningGeometry {
  const op = 'addOpeningToStore';
  if (!('Offset' in params)) throw new Error(`${op}: host #${host.hostId} is a wall; pass Offset/Width/Height (wall opening params)`);
  assertPositiveFinite([params.Width, params.Height], `${op}: Width and Height must be positive`);
  const sill = params.Sill ?? 0;
  if (!Number.isFinite(params.Offset) || !Number.isFinite(sill)) throw new Error(`${op}: Offset and Sill must be finite`);

  const bounds = host.hostBounds;
  const thickness = bounds ? bounds.max[1] - bounds.min[1] : null;
  const cutDepth = resolveCutDepth(host, thickness, params.CutDepth, op);
  const centreY = bounds ? (bounds.min[1] + bounds.max[1]) / 2 : 0;
  const width = toNativeLength(host, params.Width);
  const height = toNativeLength(host, params.Height);

  // Local Z (extrusion) = wall -Y, local X = wall X, so local Y = wall Z (up)
  // and the profile is drawn as Width × Height in the wall's elevation. The
  // origin sits on the +Y side so the extrusion runs through the body.
  const placementId = emitLocalPlacement(
    editor,
    host.hostPlacementId,
    [toNativeLength(host, params.Offset), centreY + cutDepth / 2, toNativeLength(host, sill)],
    [0, -1, 0],
    [1, 0, 0],
  );
  const profileId = emitRectangleProfile(editor, width, height, 0, height / 2);
  const solidId = emitExtrudedSolid(editor, profileId, cutDepth);
  return { placementId, profileId, solidId, cutDepth };
}

function slabOpeningGeometry(editor: StoreEditor, host: HostAnchor, params: OpeningInStoreParams): OpeningGeometry {
  const op = 'addOpeningToStore';
  if (!('Position' in params)) throw new Error(`${op}: host #${host.hostId} is a slab; pass Position/Width/Depth (slab opening params)`);
  assertPositiveFinite([params.Width, params.Depth], `${op}: Width and Depth must be positive`);
  if (!params.Position.every(Number.isFinite)) throw new Error(`${op}: Position must be finite`);

  const bounds = host.hostBounds;
  const thickness = bounds ? bounds.max[2] - bounds.min[2] : null;
  const cutDepth = resolveCutDepth(host, thickness, params.CutDepth, op);
  // Centre the cut on the body so the clearance is split between both faces.
  const centreZ = bounds ? (bounds.min[2] + bounds.max[2]) / 2 : cutDepth / 2 - toNativeLength(host, CUT_CLEARANCE_M);
  const placementId = emitLocalPlacement(editor, host.hostPlacementId, [
    toNativeLength(host, params.Position[0]),
    toNativeLength(host, params.Position[1]),
    centreZ - cutDepth / 2,
  ]);
  const profileId = emitRectangleProfile(editor, toNativeLength(host, params.Width), toNativeLength(host, params.Depth));
  const solidId = emitExtrudedSolid(editor, profileId, cutDepth);
  return { placementId, profileId, solidId, cutDepth };
}
