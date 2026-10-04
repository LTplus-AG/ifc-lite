/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { roomAt, roomOutline, type RoomBoundary, type RoomCandidate } from './room-candidates.js';
import type { NewRoom } from './room-store.js';

export interface RoomCreationPlan {
  readonly action: 'auto' | 'pick';
  readonly point?: readonly [number, number];
  readonly boundary: RoomBoundary;
  readonly height: number;
  readonly z: number;
  readonly existingCount: number;
  readonly namePattern: string;
  readonly PredefinedType?: string;
  readonly ObjectType?: string;
}

/** Native faces, occupancy and one naming policy drive both public commands and previews. */
export function planRoomCreation(rooms: readonly RoomCandidate[], options: RoomCreationPlan): NewRoom[] {
  let chosen: readonly RoomCandidate[];
  if (options.action === 'auto') chosen = rooms.filter(room => !room.taken);
  else {
    if (!options.point) throw new Error('Room pick requires a storey-local point');
    const room = roomAt(rooms, options.point);
    if (!room) throw new Error('No room at this point');
    if (room.taken) throw new Error('This room already has an IfcSpace');
    chosen = [room];
  }
  return chosen.map((room, i) => ({
    outline: roomOutline(room, options.boundary), height: options.height, z: options.z,
    Name: options.namePattern.replaceAll('{n}', String(options.existingCount + i + 1)),
    ...(options.PredefinedType !== undefined ? { PredefinedType: options.PredefinedType } : {}),
    ...(options.ObjectType !== undefined ? { ObjectType: options.ObjectType } : {}),
    grossArea: room.grossArea, netArea: room.netArea, derived: true,
  }));
}
