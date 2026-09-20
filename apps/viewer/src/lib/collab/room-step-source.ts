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

import { IfcParser, unwrapIfcZipWithResources, type IfcDataStore } from '@ifc-lite/parser';
import type { BlobStore, LocalPlacement, ModelSlotRef, PropertyValue as CollabPropertyValue } from '@ifc-lite/collab';
import { roomSlotPath } from './model-slot-ref';
import type { RoomSymbolicSource } from './room-symbolic-source';

const CONTENT_HASH = /^[0-9a-f]{32}$/;
const MAX_PORTABLE_STEP_SOURCE_BYTES = 96 * 1024 * 1024;

async function fetchSource(store: BlobStore, hash: string): Promise<Uint8Array> {
  if (!CONTENT_HASH.test(hash)) throw new Error('Room model has an invalid portable IFC source reference.');
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await store.get(hash);
    } catch (error) {
      lastError = error;
    }
    if (bytes) {
      if (bytes.byteLength > MAX_PORTABLE_STEP_SOURCE_BYTES) {
        throw new Error('The room\'s portable IFC source exceeds the 96 MiB safety limit.');
      }
      if (!store.hashBytes) {
        throw new Error('The room blob store cannot verify portable IFC content identity.');
      }
      if (store.hashBytes(bytes) !== hash) {
        throw new Error('The room\'s portable IFC source failed its content identity check.');
      }
      return bytes;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 150 : 600));
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`The room's portable IFC source is unavailable after 3 attempts. Reconnect to retry.${detail}`, {
    cause: lastError,
  });
}

export type ParsedRoomStepSource = Omit<RoomSymbolicSource, 'ownerIds' | 'placements' | 'baselines' | 'structuredPsets' | 'structuredQuantities' | 'structuredAttributes'>;

interface StructuredEntityState {
  attributes: Record<string, unknown>;
  psets: Record<string, Record<string, CollabPropertyValue>>;
  quantities: Record<string, Record<string, number>>;
}

/** Fetch and parse immutable portable STEP bytes; safe to cache by blob hash. */
export async function loadRoomStepSource(
  store: BlobStore,
  hash: string,
  format: 'step' | 'ifczip' = 'step',
): Promise<ParsedRoomStepSource> {
  const uploaded = await fetchSource(store, hash);
  let bytes = uploaded;
  let resources: ParsedRoomStepSource['resources'];
  if (format === 'ifczip') {
    const archiveBuffer = uploaded.buffer.slice(
      uploaded.byteOffset, uploaded.byteOffset + uploaded.byteLength,
    ) as ArrayBuffer;
    const archive = await unwrapIfcZipWithResources(archiveBuffer, MAX_PORTABLE_STEP_SOURCE_BYTES);
    bytes = new Uint8Array(archive.model);
    if (bytes.byteLength > MAX_PORTABLE_STEP_SOURCE_BYTES) {
      throw new Error('The room\'s extracted portable IFC source exceeds the 96 MiB safety limit.');
    }
    if (archive.resourcesIncomplete) {
      throw new Error('The room IFCZIP sidecar exceeds the texture extraction safety limits.');
    }
    resources = {
      modelPath: archive.modelPath,
      resources: archive.originalResources,
    };
  }
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
  return { dataStore, source: dataStore.source, seededIds, resources };
}

/** Bind cached portable rows to one current reconstruction's synthetic ids. */
export function bindRoomStepSource(
  parsed: ParsedRoomStepSource,
  slot: ModelSlotRef,
  roomPathToId: ReadonlyMap<string, number>,
  placementForPath?: (path: string) => LocalPlacement | null | undefined,
  baselineForPath?: (path: string) => LocalPlacement | null | undefined,
  structuredForPath?: (path: string) => StructuredEntityState | null | undefined,
): RoomSymbolicSource {
  const ownerIds = new Map<number, number>();
  const placements = new Map<number, LocalPlacement>();
  const baselines = new Map<number, LocalPlacement>();
  const structuredPsets = new Map<number, StructuredEntityState['psets']>();
  const structuredQuantities = new Map<number, StructuredEntityState['quantities']>();
  const structuredAttributes = new Map<number, StructuredEntityState['attributes']>();
  for (const expressId of parsed.seededIds) {
    const guid = parsed.dataStore.entities.getGlobalId(expressId)!;
    const path = roomSlotPath(slot, guid);
    const targetId = roomPathToId.get(path);
    if (targetId !== undefined) ownerIds.set(expressId, targetId);
    const placement = placementForPath?.(path);
    if (placement) placements.set(expressId, placement);
    const baseline = baselineForPath?.(path);
    if (baseline) baselines.set(expressId, baseline);
    const structured = structuredForPath?.(path);
    if (structured) {
      structuredPsets.set(expressId, structured.psets);
      structuredQuantities.set(expressId, structured.quantities);
      structuredAttributes.set(expressId, structured.attributes);
    }
  }
  return { ...parsed, ownerIds, placements, baselines, structuredPsets, structuredQuantities, structuredAttributes };
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
