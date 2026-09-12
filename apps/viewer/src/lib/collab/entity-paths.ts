/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a store's entities live in the room: the per-store registry that
 * turns a local expressId into a room entity path and back.
 *
 * A room entity is addressed by slot-qualified GUID path (`slotPath(slot,
 * guid)` — `/<slotId>/<guid>`, or the legacy `/<guid>` of a room shared
 * before slots existed), matching `seedFromStep` (#4444). Which slot a store
 * belongs to is registered per store (`registerStoreSlot`); STEP stores derive
 * their expressId↔path maps lazily from the entity table under that slot,
 * while IFCX-origin and reconstructed stores pre-register the maps the
 * importer produced (`registerEntityMaps`, already slot-qualified).
 *
 * Split out of `mutation-bridge.ts`, which owns the mirror/apply protocol on
 * top of these lookups: the outbound mirror (`pathForEntity`) and the inbound
 * apply observer (`entityForPath`) are the two consumers, and the seed and
 * reconstruct paths register into it.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { ModelSlotRef } from '@ifc-lite/collab';

// ── model slot per store (#4444) ─────────────────────────────────────────────

/** The implicit slot of a single-model room: unqualified `/<guid>` paths. */
const LEGACY_SLOT: ModelSlotRef = { slotId: 'm0', pathPrefix: '' };
const slotCache = new WeakMap<IfcDataStore, ModelSlotRef>();

/**
 * Bind a store to the room slot its entities live in, so `pathForEntity` and
 * `pathForGuid` qualify paths for THAT model. Unregistered stores resolve to
 * the legacy single-model scheme, which is what every pre-slot room uses. A
 * map already derived under another slot is dropped and rebuilt on the next
 * lookup; pre-registered IFCX maps (`registerEntityMaps`) are already
 * slot-qualified and are kept.
 */
export function registerStoreSlot(store: IfcDataStore, slot: ModelSlotRef): void {
  slotCache.set(store, slot);
  const cached = mapCache.get(store);
  if (cached?.derived) mapCache.delete(store);
}

/** The room path of a GUID-keyed entity of `store`, in the store's slot. */
export function pathForGuid(store: IfcDataStore, guid: string): string {
  const slot = slotCache.get(store) ?? LEGACY_SLOT;
  return `${slot.pathPrefix}/${guid}`;
}

// ── expressId ↔ GUID-path maps (cached per store) ───────────────────────────

interface EntityMaps {
  toPath: Map<number, string>;
  toExpressId: Map<string, number>;
  /** True when derived from the STEP entity table (vs pre-registered IFCX maps). */
  derived: boolean;
}
const mapCache = new WeakMap<IfcDataStore, EntityMaps>();

function entityMaps(store: IfcDataStore): EntityMaps {
  const cached = mapCache.get(store);
  if (cached) return cached;
  const toPath = new Map<number, string>();
  const toExpressId = new Map<string, number>();
  for (const [expressId] of store.entityIndex.byId.entries()) {
    // Resolve the GUID from the entity TABLE, not on-demand attribute extraction:
    // the compact index can't decode attributes for many geometric products on
    // large models, so extraction returned no GUID and those products were absent
    // from both maps — breaking geometry seeding AND inbound/outbound edit sync
    // for them. The table carries their GlobalId reliably (see step-seed.ts).
    const guid = store.entities?.getGlobalId?.(expressId);
    if (!guid) continue;
    const path = pathForGuid(store, guid);
    toPath.set(expressId, path);
    toExpressId.set(path, expressId);
  }
  const maps: EntityMaps = { toPath, toExpressId, derived: true };
  mapCache.set(store, maps);
  return maps;
}

export function pathForEntity(store: IfcDataStore, entityId: number): string | null {
  const cached = entityMaps(store).toPath.get(entityId);
  if (cached) return cached;
  // The compact `entityIndex.byId` (and on-demand attribute extraction) omits
  // many geometric products on large models, so the pre-built map misses them —
  // which dropped the vast majority of meshes at seed time. The entity *table*
  // still carries their GlobalId, so fall back to it. (No-op for IFCX stores,
  // whose maps are pre-registered via `registerEntityMaps`.)
  const guid = store.entities?.getGlobalId?.(entityId);
  return guid ? pathForGuid(store, guid) : null;
}
/** Inbound counterpart to `pathForEntity` — used by the apply observer. */
export function entityForPath(store: IfcDataStore, path: string): number | null {
  return entityMaps(store).toExpressId.get(path) ?? null;
}

/**
 * Pre-register expressId↔path maps for a store whose `entityIndex.byId` isn't
 * STEP-populated — i.e. an IFCX-origin store or a recipient's reconstructed
 * store. Without this, `entityMaps` derives an empty map from `byId`, so the
 * outbound mirror (`pathForEntity`) and inbound apply (`entityForPath`) both
 * resolve `null` and edits silently don't sync. Pass the `idToPath`/`pathToId`
 * maps that `parseIfcxViewerModel` returns. STEP stores need no registration —
 * their lazy `byId`-derived maps work.
 */
export function registerEntityMaps(
  store: IfcDataStore,
  idToPath: Map<number, string>,
  pathToId: Map<string, number>,
): void {
  mapCache.set(store, { toPath: idToPath, toExpressId: pathToId, derived: false });
}

/**
 * Add a single expressId↔path mapping to a store's cache. Needed for entities
 * created at runtime (StoreEditor overlay entities), which are intentionally
 * absent from `entityIndex.byId` and the entity table — so `pathForEntity`
 * can't derive their path. Without this, a created entity (and any later edit
 * to it) wouldn't resolve a path and wouldn't sync.
 */
export function registerEntityPath(store: IfcDataStore, expressId: number, path: string): void {
  const maps = entityMaps(store);
  maps.toPath.set(expressId, path);
  maps.toExpressId.set(path, expressId);
}
