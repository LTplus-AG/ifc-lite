/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { getWholeSourceForWorker, parseSymbolicFlat } from '@/lib/overlay-parse';
import { buildSymbolicDrawingLines } from '@/lib/overlay-parse/symbolic-drawing-lines';
import { placeRoomSymbolic, roomSymbolicSource } from './room-symbolic-source';
import {
  overlayRtcContextFor,
  type OverlayRtcContext,
} from '@/lib/overlay-parse/rtc-context';

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
export async function roomDrawingSymbolic(
  store: { source: IfcSourceBytes },
  rtc: OverlayRtcContext = roomDrawingRtcContext(store),
) {
  const roomSource = roomSymbolicSource(store);
  if (rtc.mode === 'pending') {
    throw new Error('RTC frame is still pending');
  }
  let flat = await parseSymbolicFlat(
    getWholeSourceForWorker({ source: roomSource?.source ?? store.source }),
    false,
    'all',
    rtc.frame,
  );
  if (roomSource) flat = placeRoomSymbolic(flat, roomSource);
  return buildSymbolicDrawingLines(flat, 0);
}

/** Snapshot the source/frame authority once for both a drawing key and parse. */
export function roomDrawingRtcContext(store: object): OverlayRtcContext {
  return roomSymbolicSource(store)
    ? { mode: 'standalone', key: 'standalone', frame: undefined }
    : overlayRtcContextFor(store);
}

/** Stable drawing-cache identity including the exact producer frame. */
export function roomDrawingContextKey(
  store: object,
  rtc: OverlayRtcContext = roomDrawingRtcContext(store),
): string | null {
  const roomSource = roomSymbolicSource(store);
  if (roomSource) {
    // Placement/owner bindings live on RoomSymbolicSource, not its portable
    // byte source. A reconstructed binding may reuse the bytes but must not
    // reuse drawing lines placed for the previous binding.
    return `${drawingStoreIdentity(roomSource)}|standalone`;
  }
  return rtc.mode === 'pending' ? null : `${drawingStoreIdentity(store)}|${rtc.key}`;
}
