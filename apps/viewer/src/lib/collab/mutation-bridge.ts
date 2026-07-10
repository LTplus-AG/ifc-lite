/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property/attribute mutation bridge (plan §4.3, §7.5).
 *
 * Mirrors the viewer's local property + attribute edits into the collab CRDT
 * and replays remote peers' edits back into the local model:
 *
 *   local edit ─▶ mutationSlice ─▶ mirror* () ─▶ session.transact(setPropertyValue)
 *                                                       │  (y-websocket)
 *   peer's Y.Doc update ─▶ observeDeep (txn.local=false) ─▶ apply to MutablePropertyView
 *
 * Entities are addressed by GUID path (`/<guid>`), matching `seedFromStep`.
 * Inbound apply writes straight to the `MutablePropertyView` (not the slice's
 * undo-tracked actions) so remote edits don't pollute the local undo stack and
 * can't echo back to the doc. The collab runtime is injected (the module the
 * caller already lazy-loaded) so this file pulls no collab code eagerly.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { CollabSession, LocalPlacement } from '@ifc-lite/collab';

/** The slice of the collab runtime this bridge needs (injected, never eager-imported). */
export interface CollabDocApi {
  hasEntity(doc: CollabSession['doc'], path: string): boolean;
  setPropertyValue(
    doc: CollabSession['doc'],
    path: string,
    pset: string,
    prop: string,
    value: { type: string; value: string | number | boolean | null; source?: string },
  ): void;
  deletePropertyValue(doc: CollabSession['doc'], path: string, pset: string, prop: string): boolean;
  setAttribute(doc: CollabSession['doc'], path: string, name: string, value: unknown): void;
  /** Write an entity's local placement (the IFCX-native `usd::xformop` attribute). */
  setEntityPlacement(doc: CollabSession['doc'], path: string, placement: LocalPlacement): void;
  /** Tombstone an entity (Yjs preserves it as a delete; observers see a `delete`). */
  deleteEntity(doc: CollabSession['doc'], path: string): boolean;
  /** Create an entity node (idempotent). Used to mirror a local addElement. */
  createEntity(
    doc: CollabSession['doc'],
    path: string,
    options?: { ifcClass?: string; attributes?: Record<string, unknown> },
  ): void;
  /** The `usd::xformop` attribute key, so the inbound observer can route it to `onPlacement`. */
  XFORMOP_KEY: string;
  /** Decode a `usd::xformop` attribute value back to a normalized placement (null if malformed). */
  placementFromXformOp(value: unknown): LocalPlacement | null;
  PROPERTY_TYPE_NAMES: Record<number, string>;
}

const guidPath = (guid: string): string => `/${guid}`;

// ── expressId ↔ GUID-path maps (cached per store) ───────────────────────────

interface EntityMaps {
  toPath: Map<number, string>;
  toExpressId: Map<string, number>;
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
    const path = guidPath(guid);
    toPath.set(expressId, path);
    toExpressId.set(path, expressId);
  }
  const maps: EntityMaps = { toPath, toExpressId };
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
  return guid ? guidPath(guid) : null;
}
/** Inbound counterpart to `pathForEntity` — internal to the apply observer. */
function entityForPath(store: IfcDataStore, path: string): number | null {
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
  mapCache.set(store, { toPath: idToPath, toExpressId: pathToId });
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

// ── value conversion ─────────────────────────────────────────────────────────

function toScalar(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // Lists / refs collapse to a stable string form (full list CRDT is a follow-up).
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

/** Map a collab IFC type string back to the closest `PropertyValueType`. */
function propertyValueTypeFor(ifcType: string): PropertyValueType {
  switch (ifcType) {
    case 'IfcBoolean':
    case 'IfcLogical':
      return PropertyValueType.Boolean;
    case 'IfcInteger':
      return PropertyValueType.Integer;
    case 'IfcReal':
      return PropertyValueType.Real;
    case 'IfcIdentifier':
      return PropertyValueType.Identifier;
    case 'IfcText':
      return PropertyValueType.Text;
    default:
      return PropertyValueType.Label;
  }
}

// ── outbound: local edit → CRDT ──────────────────────────────────────────────

export function mirrorProperty(
  api: CollabDocApi,
  session: CollabSession,
  store: IfcDataStore,
  entityId: number,
  pset: string,
  prop: string,
  value: unknown,
  valueType: PropertyValueType,
): void {
  const path = pathForEntity(store, entityId);
  if (!path || !api.hasEntity(session.doc, path)) return;
  const type = api.PROPERTY_TYPE_NAMES[valueType] ?? 'IfcLabel';
  session.transact(() => {
    api.setPropertyValue(session.doc, path, pset, prop, { type, value: toScalar(value), source: 'manual' });
  });
}

export function mirrorPropertyDelete(
  api: CollabDocApi,
  session: CollabSession,
  store: IfcDataStore,
  entityId: number,
  pset: string,
  prop: string,
): void {
  const path = pathForEntity(store, entityId);
  if (!path || !api.hasEntity(session.doc, path)) return;
  session.transact(() => {
    api.deletePropertyValue(session.doc, path, pset, prop);
  });
}

export function mirrorAttribute(
  api: CollabDocApi,
  session: CollabSession,
  store: IfcDataStore,
  entityId: number,
  attrName: string,
  value: unknown,
): void {
  const path = pathForEntity(store, entityId);
  if (!path || !api.hasEntity(session.doc, path)) return;
  session.transact(() => {
    api.setAttribute(session.doc, path, attrName, toScalar(value));
  });
}

/**
 * Mirror a geometry placement edit (move / rotate) to the CRDT as the entity's
 * canonical `usd::xformop` attribute. Unlike property/attribute edits this is
 * the IFCX-native transform, so it round-trips through `snapshotToIfcx` and is
 * read back by `parseIfcxViewerModel` with no writer/parser change.
 */
export function mirrorPlacement(
  api: CollabDocApi,
  session: CollabSession,
  store: IfcDataStore,
  entityId: number,
  placement: LocalPlacement,
): void {
  const path = pathForEntity(store, entityId);
  if (!path || !api.hasEntity(session.doc, path)) return;
  session.transact(() => {
    api.setEntityPlacement(session.doc, path, placement);
  });
}

/** Mirror an entity deletion (tombstone) to the CRDT. */
export function mirrorEntityDelete(
  api: CollabDocApi,
  session: CollabSession,
  store: IfcDataStore,
  entityId: number,
): void {
  const path = pathForEntity(store, entityId);
  if (!path || !api.hasEntity(session.doc, path)) return;
  session.transact(() => {
    api.deleteEntity(session.doc, path);
  });
}

// ── inbound: remote CRDT change → local model ────────────────────────────────

export type ScalarValue = string | number | boolean | null;

export interface RemoteApplyHandlers {
  /** Apply a remote property write to the local view (no undo tracking). */
  onProperty(entityId: number, pset: string, prop: string, value: ScalarValue, type: PropertyValueType): void;
  /** Apply a remote property deletion. */
  onPropertyDelete(entityId: number, pset: string, prop: string): void;
  /** Apply a remote attribute write. */
  onAttribute(entityId: number, attrName: string, value: ScalarValue): void;
  /**
   * Apply a remote placement (move / rotate) write. Receives the entity's full
   * new local placement decoded from `usd::xformop`; the handler reconciles it
   * against the entity's baseline to move the rendered mesh. Optional so older
   * callers keep working.
   */
  onPlacement?(entityId: number, placement: LocalPlacement): void;
  /** A peer tombstoned an entity — hide/remove its rendered mesh locally. */
  onEntityDelete?(entityId: number): void;
}

/**
 * Observe remote (non-local) Y.Doc edits and dispatch property/attribute
 * changes to `handlers`. Returns a teardown. Yjs deep-observe `path` is keyed
 * from the `entities` map root: `[entityPath, 'attributes']` for attributes and
 * `[entityPath, 'psets', psetName]` for property sets.
 */
export function attachRemoteApply(
  api: CollabDocApi,
  session: CollabSession,
  store: IfcDataStore,
  handlers: RemoteApplyHandlers,
): () => void {
  // `entities` is inferred as Y.Map<unknown>; deriving the observer type from
  // its method signature avoids importing yjs (not a direct viewer dep).
  const entities = session.doc.getMap('entities');
  type DeepObserver = Parameters<typeof entities.observeDeep>[0];

  const observer: DeepObserver = (events, txn) => {
    if (txn.local) return; // ignore our own writes (seed + outbound mirror)
    for (const ev of events) {
      const path = ev.path;
      // Top-level entity add/remove on the `entities` map root (path === []).
      // We only act on deletes here; additions are picked up by the recipient's
      // full reconstruct. `entityForPath` resolves the removed path's expressId.
      if (path.length === 0) {
        if (!handlers.onEntityDelete) continue;
        for (const [entityPath, change] of ev.changes.keys) {
          if (change.action !== 'delete') continue;
          const id = entityForPath(store, entityPath);
          if (id !== null) handlers.onEntityDelete(id);
        }
        continue;
      }
      const entityPath = typeof path[0] === 'string' ? path[0] : undefined;
      if (!entityPath) continue;
      const entityId = entityForPath(store, entityPath);
      if (entityId === null) continue;
      const target = ev.target as { get(key: string): unknown };

      if (path[1] === 'attributes' && path.length === 2) {
        for (const [attrName, change] of ev.changes.keys) {
          if (change.action === 'delete') continue;
          // Placement (`usd::xformop`) is a structured matrix, not a scalar
          // attribute — route it to the dedicated placement handler so the
          // mesh moves, and skip the generic stringifying attribute path.
          if (attrName === api.XFORMOP_KEY) {
            const placement = api.placementFromXformOp(target.get(attrName));
            if (placement && handlers.onPlacement) handlers.onPlacement(entityId, placement);
            continue;
          }
          handlers.onAttribute(entityId, attrName, toScalar(target.get(attrName)));
        }
      } else if (path[1] === 'psets' && path.length === 3 && typeof path[2] === 'string') {
        const psetName = path[2];
        for (const [prop, change] of ev.changes.keys) {
          if (change.action === 'delete') {
            handlers.onPropertyDelete(entityId, psetName, prop);
            continue;
          }
          const pv = target.get(prop) as { type?: string; value?: ScalarValue } | undefined;
          if (!pv) continue;
          handlers.onProperty(entityId, psetName, prop, pv.value ?? null, propertyValueTypeFor(pv.type ?? 'IfcLabel'));
        }
      }
    }
  };

  entities.observeDeep(observer);
  return () => entities.unobserveDeep(observer);
}
