/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Complete STEP source carried beside a room's IFCX collaboration snapshot.
 *
 * The snapshot deliberately stores only IfcRoot-shaped structure. A STEP
 * source retains resource-level representation rows, which are required by
 * the symbolic 2D extractor (notably IfcAnnotationFillArea). Geometry still
 * hydrates from the room's content-addressed mesh blobs.
 */

import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { BlobStore, ModelSlotRef } from '@ifc-lite/collab';
import { roomSlotPath } from './model-slot-ref';
import type { RoomSymbolicSource } from './room-symbolic-source';

const CONTENT_HASH = /^[0-9a-f]{32}$/;
const MAX_PORTABLE_STEP_SOURCE_BYTES = 96 * 1024 * 1024;

async function fetchSource(store: BlobStore, hash: string): Promise<Uint8Array> {
  if (!CONTENT_HASH.test(hash)) throw new Error('Room model has an invalid portable IFC source reference.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const bytes = await store.get(hash);
    if (bytes) {
      if (bytes.byteLength > MAX_PORTABLE_STEP_SOURCE_BYTES) {
        throw new Error('The room\'s portable IFC source exceeds the 96 MiB safety limit.');
      }
      return bytes;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 150 : 600));
  }
  throw new Error('The room\'s portable IFC source is unavailable after 3 attempts. Reconnect to retry.');
}

export type ParsedRoomStepSource = Omit<RoomSymbolicSource, 'ownerIds'>;

/** Fetch and parse immutable portable STEP bytes; safe to cache by blob hash. */
export async function loadRoomStepSource(store: BlobStore, hash: string): Promise<ParsedRoomStepSource> {
  const bytes = await fetchSource(store, hash);
  const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer.slice(0)
    : bytes.slice().buffer;
  const dataStore: IfcDataStore = await new IfcParser().parseColumnar(copy);
  const seededIds = new Set<number>();
  for (const [expressId] of dataStore.entityIndex.byId.entries()) {
    // Match buildStepSeedSource exactly. Some synthetic/test sources use
    // non-canonical GlobalId strings, and the seeder deliberately preserves
    // those paths instead of rejecting an otherwise shareable model.
    if (dataStore.entities.getGlobalId(expressId)) seededIds.add(expressId);
  }
  return { dataStore, source: dataStore.source, seededIds };
}

/** Bind cached portable rows to one current reconstruction's synthetic ids. */
export function bindRoomStepSource(
  parsed: ParsedRoomStepSource,
  slot: ModelSlotRef,
  roomPathToId: ReadonlyMap<string, number>,
): RoomSymbolicSource {
  const ownerIds = new Map<number, number>();
  for (const expressId of parsed.seededIds) {
    const guid = parsed.dataStore.entities.getGlobalId(expressId)!;
    const path = roomSlotPath(slot, guid);
    const targetId = roomPathToId.get(path);
    if (targetId !== undefined) ownerIds.set(expressId, targetId);
  }
  return { ...parsed, ownerIds };
}

/** Parse one portable source and key its GUID-bearing roots to this room slot. */
export async function parseRoomStepSource(
  store: BlobStore,
  hash: string,
  slot: ModelSlotRef,
  roomPathToId: ReadonlyMap<string, number>,
): Promise<RoomSymbolicSource> {
  return bindRoomStepSource(await loadRoomStepSource(store, hash), slot, roomPathToId);
}
