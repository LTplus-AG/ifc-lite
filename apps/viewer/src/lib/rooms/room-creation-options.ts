/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Room creation options, shared by the command and its HUD. */
export interface RoomCreationOptions {
  readonly minArea: number;
  readonly namePattern: string;
  readonly PredefinedType: string;
  readonly ObjectType: string;
}

export const DEFAULT_ROOM_CREATION: RoomCreationOptions = {
  minArea: 0.3, namePattern: 'Room {n}', PredefinedType: 'INTERNAL', ObjectType: '',
};

