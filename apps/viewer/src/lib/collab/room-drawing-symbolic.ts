/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { getWholeSourceForWorker, parseSymbolicFlat } from '@/lib/overlay-parse';
import { buildSymbolicDrawingLines } from '@/lib/overlay-parse/symbolic-drawing-lines';
import { placeRoomSymbolic, roomSymbolicSource } from './room-symbolic-source';

const STORE_IDENTITIES = new WeakMap<object, number>();
let nextStoreIdentity = 1;

export function drawingStoreIdentity(store: object | null | undefined): string {
  if (!store) return '';
  let id = STORE_IDENTITIES.get(store);
  if (id === undefined) {
    id = nextStoreIdentity++;
    STORE_IDENTITIES.set(store, id);
  }
  return String(id);
}

/** Parse native symbolic rows for the current room binding into 2D drawing lines. */
export async function roomDrawingSymbolic(store: { source: IfcSourceBytes }) {
  const roomSource = roomSymbolicSource(store);
  let flat = await parseSymbolicFlat(
    getWholeSourceForWorker({ source: roomSource?.source ?? store.source }),
    false,
    'all',
  );
  if (roomSource) flat = placeRoomSymbolic(flat, roomSource);
  return buildSymbolicDrawingLines(flat, 0);
}
