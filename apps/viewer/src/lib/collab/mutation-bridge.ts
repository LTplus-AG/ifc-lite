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
import { extractEntityAttributesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { CollabSession } from '@ifc-lite/collab';

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
    const guid = extractEntityAttributesOnDemand(store, expressId).globalId;
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
  return entityMaps(store).toPath.get(entityId) ?? null;
}
export function entityForPath(store: IfcDataStore, path: string): number | null {
  return entityMaps(store).toExpressId.get(path) ?? null;
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

// ── inbound: remote CRDT change → local model ────────────────────────────────

export type ScalarValue = string | number | boolean | null;

export interface RemoteApplyHandlers {
  /** Apply a remote property write to the local view (no undo tracking). */
  onProperty(entityId: number, pset: string, prop: string, value: ScalarValue, type: PropertyValueType): void;
  /** Apply a remote property deletion. */
  onPropertyDelete(entityId: number, pset: string, prop: string): void;
  /** Apply a remote attribute write. */
  onAttribute(entityId: number, attrName: string, value: ScalarValue): void;
}

/**
 * Observe remote (non-local) Y.Doc edits and dispatch property/attribute
 * changes to `handlers`. Returns a teardown. Yjs deep-observe `path` is keyed
 * from the `entities` map root: `[entityPath, 'attributes']` for attributes and
 * `[entityPath, 'psets', psetName]` for property sets.
 */
export function attachRemoteApply(
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
      const entityPath = typeof path[0] === 'string' ? path[0] : undefined;
      if (!entityPath) continue;
      const entityId = entityForPath(store, entityPath);
      if (entityId === null) continue;
      const target = ev.target as { get(key: string): unknown };

      if (path[1] === 'attributes' && path.length === 2) {
        for (const [attrName, change] of ev.changes.keys) {
          if (change.action === 'delete') continue;
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
