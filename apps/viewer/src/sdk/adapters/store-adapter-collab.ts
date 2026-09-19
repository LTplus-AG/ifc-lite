/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { attributeNamesForStore, referenceAttributeSlotsForStore } from '@/lib/collab/schema-attribute-names.js';
import {
  encodeRoomAttributeValue,
  referencedExpressIds,
  type ReferenceTraversalBudget,
} from '@/lib/collab/entity-reference-wire.js';
import { entityForPath, pathForEntity, pathForGuid, unregisterEntityPath } from '@/lib/collab/entity-paths.js';
import { getMutationViewForModel } from './mutation-view.js';
import type { StoreApi } from './types.js';

const MAX_SOURCE_REFERENCE_ENTITIES = 10_000;
const MAX_SOURCE_REFERENCE_WORK = 10_000;

export function initialRoomAttributes(
  dataStore: IfcDataStore,
  type: string,
  names: string[],
  values: unknown[],
  resolvePath?: (expressId: number) => string | null,
  budget?: ReferenceTraversalBudget,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const referenceSlots = referenceAttributeSlotsForStore(dataStore, type);
  values.forEach((value, index) => {
    const name = names[index];
    if (name && name !== 'GlobalId' && value !== undefined) {
      attributes[`bsi::ifc::prop::${name}`] = encodeRoomAttributeValue(
        dataStore, value, referenceSlots[index] ?? false, resolvePath, budget,
      );
    }
  });
  return attributes;
}

interface MaterializedEntry {
  expressId: number;
  type: string;
  names: string[];
  values: unknown[];
  roomKey: string;
}

function availableSyntheticRoomKey(
  dataStore: IfcDataStore,
  expressId: number,
  claimedPaths: ReadonlySet<string>,
): string {
  for (let suffix = 0; suffix <= MAX_SOURCE_REFERENCE_ENTITIES; suffix++) {
    const roomKey = `ifc-lite-ref-${expressId}${suffix === 0 ? '' : `-${suffix}`}`;
    const path = pathForGuid(dataStore, roomKey);
    const owner = entityForPath(dataStore, path);
    if (dataStore.entities.getExpressIdByGlobalId(roomKey) < 0
      && (owner === null || owner === expressId) && !claimedPaths.has(path)) return roomKey;
  }
  throw new Error(`bim.store: no source room path available after ${MAX_SOURCE_REFERENCE_ENTITIES} attempts`);
}

function roomKeyForOverlay(
  dataStore: IfcDataStore,
  entry: Omit<MaterializedEntry, 'roomKey'>,
  claimedPaths: ReadonlySet<string>,
): string {
  const globalId = entry.names[0] === 'GlobalId' && typeof entry.values[0] === 'string'
    ? entry.values[0]
    : null;
  if (!globalId) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const roomKey = `ifc-lite-store-${crypto.randomUUID()}`;
      const path = pathForGuid(dataStore, roomKey);
      if (entityForPath(dataStore, path) === null && !claimedPaths.has(path)) return roomKey;
    }
    throw new Error('bim.store: could not allocate a unique room identity');
  }
  const owner = entityForPath(dataStore, pathForGuid(dataStore, globalId));
  if ((owner !== null && owner !== entry.expressId) || claimedPaths.has(pathForGuid(dataStore, globalId))) {
    throw new Error(`bim.store: room path for GlobalId "${globalId}" is already owned`);
  }
  return globalId;
}

/** Materialize every unregistered reference before an outbound store mutation is published. */
export function ensureSourceRoomEntities(
  store: StoreApi,
  modelId: string,
  editor: StoreEditor,
  roots: Iterable<number>,
  dataStore: IfcDataStore,
  pendingOverride?: {
    expressId: number;
    index: number;
    value: Parameters<StoreEditor['setPositionalAttribute']>[2];
  },
): boolean {
  const pending = Array.from(roots);
  const visited = new Set<number>();
  const candidates = new Map<number, string>();
  const claimedPaths = new Set<string>();
  const entries: MaterializedEntry[] = [];
  const budget: ReferenceTraversalBudget = { remainingNodes: MAX_SOURCE_REFERENCE_WORK };
  const mutationView = getMutationViewForModel(store, modelId);
  while (pending.length > 0) {
    const expressId = pending.pop();
    if (expressId === undefined || visited.has(expressId)) continue;
    visited.add(expressId);
    if (visited.size > MAX_SOURCE_REFERENCE_ENTITIES) {
      throw new Error(`bim.store: source reference graph exceeds ${MAX_SOURCE_REFERENCE_ENTITIES} entities`);
    }
    if (pathForEntity(dataStore, expressId) || dataStore.entities.getGlobalId(expressId)) continue;
    const overlay = editor.getNewEntity(expressId);
    const entity = overlay ?? dataStore.getEntity?.(expressId);
    if (!entity) continue;
    const names = attributeNamesForStore(dataStore, entity.type);
    const values = [...entity.attributes];
    for (const [index, value] of mutationView?.getPositionalMutationsForEntity(expressId) ?? []) {
      values[index] = value;
    }
    if (pendingOverride?.expressId === expressId) values[pendingOverride.index] = pendingOverride.value;
    const base = { expressId, type: entity.type, names, values };
    const roomKey = overlay
      ? roomKeyForOverlay(dataStore, base, claimedPaths)
      : availableSyntheticRoomKey(dataStore, expressId, claimedPaths);
    const path = pathForGuid(dataStore, roomKey);
    candidates.set(expressId, path);
    claimedPaths.add(path);
    entries.push({ ...base, roomKey });
    const referenceSlots = referenceAttributeSlotsForStore(dataStore, entity.type);
    values.forEach((value, index) => {
      pending.push(...referencedExpressIds(value, referenceSlots[index] ?? false, new Set(), budget));
    });
  }
  const resolvePath = (expressId: number) => candidates.get(expressId) ?? pathForEntity(dataStore, expressId);
  // Encode every value before publishing any shell. A budget failure cannot
  // leave a partially materialized room graph behind.
  const encoded = entries.map((entry) => initialRoomAttributes(
    dataStore, entry.type, entry.names, entry.values, resolvePath, budget,
  ));
  const registered: number[] = [];
  entries.forEach((entry) => {
    store.getState().mirrorEntityCreate(modelId, entry.expressId, entry.type, entry.roomKey, null, {});
    if (pathForEntity(dataStore, entry.expressId) === candidates.get(entry.expressId)) {
      registered.push(entry.expressId);
    }
  });
  if (registered.length !== entries.length) {
    for (const expressId of registered) unregisterEntityPath(dataStore, expressId);
    return false;
  }
  entries.forEach((entry, index) => {
    for (const [name, value] of Object.entries(encoded[index])) {
      store.getState().mirrorAttributeEdit(modelId, entry.expressId, name, value);
    }
  });
  return true;
}
