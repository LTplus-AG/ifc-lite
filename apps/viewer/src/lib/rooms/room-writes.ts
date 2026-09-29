/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Room tool's writes (charter #6232 M4), run inside `room.place`'s
 * transaction so each action is one undo step.
 *
 * A room is an IfcSpace extruded from its storey-local outline (`addSpace`).
 * Decision D5: the outline is a SNAPSHOT of the walls at commit — no live
 * link, no IfcRelSpaceBoundary. "Update rooms" re-derives a selected room's
 * outline from the current walls and rewrites its profile in place, the way
 * a slab split rewrites the piece it keeps (`emitClippedProfile` +
 * `reshapeSource`): same express id, GlobalId, name, psets and relations.
 */

import { QuantityType } from '@ifc-lite/data';
import { GENERATED_SPACE_OBJECTTYPE } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveSplitTarget } from '@/lib/split-target';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { emitClippedProfile } from '@/store/slices/mutation-split-slab';
import { reshapeSource } from '@/store/slices/mutation-split';
import { roomAt, interiorPoint, roomOutline, type Pt, type RoomBoundary, type RoomCandidate } from './storey-rooms';

type Get = () => ViewerState;

export interface NewRoom {
  outline: Pt[];
  height: number;
  /** Storey-local height of the floor it stands on (the workplane offset). */
  z: number;
  name: string;
  grossArea: number;
  netArea: number;
  /** Derived from walls (Auto, a picked face) rather than drawn freehand. */
  derived: boolean;
}

/** Add one room as an IfcSpace; throws the builder's refusal so the transaction rolls back. */
export function addRoom(get: Get, modelId: string, storeyId: number, room: NewRoom): number {
  const made = get().addSpace(modelId, storeyId, {
    Profile: 'polygon',
    OuterCurve: room.outline.map(([x, y]) => [x, y]),
    Position: [0, 0, room.z],
    Height: room.height,
    Name: room.name,
    ...(room.derived ? { ObjectType: GENERATED_SPACE_OBJECTTYPE } : {}),
    grossFloorArea: room.grossArea,
    netFloorArea: room.netArea,
  });
  if ('error' in made) throw new Error(`Couldn't add the room: ${made.error}`);
  return made.expressId;
}

/** The outline and areas a candidate is written with at `boundary`. */
export function candidateRoom(room: RoomCandidate, boundary: RoomBoundary): Pick<NewRoom, 'outline' | 'grossArea' | 'netArea'> {
  return { outline: roomOutline(room, boundary), grossArea: room.grossArea, netArea: room.netArea };
}

/**
 * The selected IfcSpace entities of `modelId`, as express ids: the primary
 * selection and the multi-selection together (a single-entity select leaves
 * the multi-selection as it was), deleted ones dropped.
 */
export function selectedRooms(s: ViewerState, modelId: string): number[] {
  const ids = new Set(s.selectedEntityIds);
  if (s.selectedEntityId !== null) ids.add(s.selectedEntityId);
  const view = s.mutationViews.get(modelId);
  const store = s.models.get(modelId)?.ifcDataStore;
  const out: number[] = [];
  for (const globalId of ids) {
    const ref = s.resolveGlobalIdFromModels(globalId);
    if (!ref || ref.modelId !== modelId || view?.isDeleted(ref.expressId)) continue;
    const type = view?.getNewEntity(ref.expressId)?.type ?? store?.entities.getTypeName(ref.expressId);
    if (type?.toUpperCase() === 'IFCSPACE') out.push(ref.expressId);
  }
  return out;
}

export type RoomUpdate =
  | { ok: true; outline: Pt[] }
  | { ok: false; reason: 'shape' | 'storey' | 'noRoom' };

/**
 * Re-derive room `expressId`'s outline from its storey's current walls and
 * rewrite its profile in place. `roomsOn` derives a storey's candidates
 * (`storeyRooms` through that storey's workplane). The room follows the face
 * that holds its old footprint's interior point, so a moved wall drags the
 * outline with it and a removed one merges it into the face beyond.
 */
export function updateRoomOutline(
  get: Get,
  modelId: string,
  expressId: number,
  boundary: RoomBoundary,
  roomsOn: (storeyId: number) => readonly RoomCandidate[],
): RoomUpdate {
  // Any read action creates the model's store editor on first use.
  get().readSplitTarget(modelId, expressId);
  const s = get();
  const view = s.mutationViews.get(modelId);
  const editor = s.storeEditors.get(modelId);
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  if (!view || !editor || !dataStore) return { ok: false, reason: 'shape' };
  const k = getModelLengthUnitScale(dataStore);
  // The split predicate: a vertical extrusion of a plan profile, on a storey.
  const target = resolveSplitTarget(dataStore, view, editor, expressId, k);
  if (!target.ok) return { ok: false, reason: target.code === 'storey' || target.code === 'container' ? 'storey' : 'shape' };
  if (target.kind !== 'slab' || target.chain.elementType !== 'IfcSpace') return { ok: false, reason: 'shape' };
  const storeyId = effectiveStoreyId(dataStore, view, expressId);
  if (storeyId === undefined) return { ok: false, reason: 'storey' };
  const { chain } = target;
  const room = roomAt(roomsOn(storeyId), interiorPoint(chain.footprint));
  if (!room) return { ok: false, reason: 'noRoom' };
  const outline = roomOutline(room, boundary);
  const origin = chain.placementOrigin;
  const emitted = emitClippedProfile(editor, outline, origin, chain.baseElevation - origin[2], k);
  reshapeSource(get, modelId, [
    { entityId: chain.extrudedSolidId, index: 0, value: `#${emitted.profile}` },
    { entityId: chain.extrudedSolidId, index: 1, value: `#${emitted.solidPosition}` },
    { entityId: chain.extrudedSolidId, index: 2, value: `#${emitted.up}` },
  ]);
  // The quantities describe the outline; a stale area would outlive the edit.
  const qto = 'Qto_SpaceBaseQuantities';
  get().setQuantity(modelId, expressId, qto, 'GrossFloorArea', room.grossArea, QuantityType.Area);
  get().setQuantity(modelId, expressId, qto, 'NetFloorArea', room.netArea, QuantityType.Area);
  get().setQuantity(modelId, expressId, qto, 'GrossVolume', room.grossArea * chain.thickness, QuantityType.Volume);
  return { ok: true, outline };
}
