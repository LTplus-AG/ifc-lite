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
 * Entities are addressed by slot-qualified GUID path (`slotPath(slot, guid)`
 * — `/<slotId>/<guid>`, or the legacy `/<guid>` of a single-model room),
 * matching `seedFromStep` (#4444); the per-store expressId↔path registry
 * lives in `entity-paths.ts`. Inbound, the path itself names the slot, so the
 * observer resolves the store BY PATH and hands every handler the model the
 * edit belongs to. Inbound apply writes straight to the `MutablePropertyView`
 * (not the slice's undo-tracked actions) so remote edits don't pollute the
 * local undo stack and can't echo back to the doc. The collab runtime is
 * injected (the module the caller already lazy-loaded) so this file pulls no
 * collab code eagerly.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { CollabSession, LocalPlacement } from '@ifc-lite/collab';
import { entityForPath, pathForEntity } from './entity-paths';

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
export function propertyValueTypeFor(ifcType: string): PropertyValueType {
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

/**
 * Every inbound handler is told WHICH model the edit belongs to: a room holds
 * one model per slot (#4444) and an expressId is meaningless without its
 * model. `modelId` is the viewer model whose store the path resolved against;
 * `entityId` is an expressId in that model's id space.
 */
export interface RemoteApplyHandlers {
  /** Apply a remote property write to the local view (no undo tracking). */
  onProperty(modelId: string, entityId: number, pset: string, prop: string, value: ScalarValue, type: PropertyValueType): void;
  /** Apply a remote property deletion. */
  onPropertyDelete(modelId: string, entityId: number, pset: string, prop: string): void;
  /** Apply a remote attribute write. */
  onAttribute(modelId: string, entityId: number, attrName: string, value: ScalarValue): void;
  /**
   * Apply a remote placement (move / rotate) write. Receives the entity's full
   * new local placement decoded from `usd::xformop`; the handler reconciles it
   * against the entity's baseline to move the rendered mesh. Optional so older
   * callers keep working.
   */
  onPlacement?(modelId: string, entityId: number, placement: LocalPlacement): void;
  /** A peer tombstoned an entity — hide/remove its rendered mesh locally. */
  onEntityDelete?(modelId: string, entityId: number): void;
  /** The whole Pset vanished. Property names are unavailable by design: Yjs
   *  detaches the map before the event is observed, so `forEach` yields 0
   *  entries. The consumer drops the entire set for (entityId, pset). */
  onPsetDelete?(modelId: string, entityId: number, pset: string): void;
}

/** The model an inbound room path resolved to: its viewer id and its store. */
export interface RoomEntityTarget {
  modelId: string;
  store: IfcDataStore;
}

/**
 * Resolves a room entity path to the model it belongs to — the ROOM's model
 * for that path's slot, never whatever is active. A function, not a value,
 * because the target can change or not exist yet: a recipient's room models
 * are registered by the first reconstruct, which can land after the observer
 * is attached, and a captured store would keep resolving room paths against a
 * stale — possibly entirely unrelated — model. Returning `null` drops the
 * event.
 */
export type RoomEntityResolver = (entityPath: string) => RoomEntityTarget | null;

/**
 * Observe remote (non-local) Y.Doc edits and dispatch property/attribute
 * changes to `handlers`. Returns a teardown. Yjs deep-observe `path` is keyed
 * from the `entities` map root: `[entityPath, 'attributes']` for attributes and
 * `[entityPath, 'psets', psetName]` for property sets.
 */
export function attachRemoteApply(
  api: CollabDocApi,
  session: CollabSession,
  resolve: RoomEntityResolver,
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
          const hit = resolve(entityPath);
          if (!hit) continue;
          const id = entityForPath(hit.store, entityPath);
          if (id !== null) handlers.onEntityDelete(hit.modelId, id);
        }
        continue;
      }
      const entityPath = typeof path[0] === 'string' ? path[0] : undefined;
      if (!entityPath) continue;
      const hit = resolve(entityPath);
      if (!hit) continue;
      const { modelId, store } = hit;
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
            if (placement && handlers.onPlacement) handlers.onPlacement(modelId, entityId, placement);
            continue;
          }
          handlers.onAttribute(modelId, entityId, attrName, toScalar(target.get(attrName)));
        }
      } else if (path[1] === 'psets' && path.length === 3 && typeof path[2] === 'string') {
        const psetName = path[2];
        for (const [prop, change] of ev.changes.keys) {
          if (change.action === 'delete') {
            handlers.onPropertyDelete(modelId, entityId, psetName, prop);
            continue;
          }
          const pv = target.get(prop) as { type?: string; value?: ScalarValue } | undefined;
          if (!pv) continue;
          handlers.onProperty(modelId, entityId, psetName, prop, pv.value ?? null, propertyValueTypeFor(pv.type ?? 'IfcLabel'));
        }
      } else if (path[1] === 'psets' && path.length === 2) {
        // A pset appearing (or vanishing) wholesale. When a remote peer writes
        // the FIRST property of a brand-new pset, Yjs reports it as a single
        // `add` on the `psets` map itself — the nested pset map does not exist
        // yet when the transaction is observed, so no `path.length === 3`
        // event is ever emitted. Without this branch that first property lands
        // in the Y.Doc but never reaches the live view until a full
        // reconstruct.
        //
        // The mirror case — deleting a pset's LAST property, which cascades to
        // removing the pset entry — reports as a single `delete` here too. By
        // the time the event is observed the removed map is already detached
        // — `oldValue.forEach` yields nothing, `size` is 0 and `toJSON()` is
        // `{}` — so the property names are unrecoverable. `onPsetDelete` tells
        // the consumer to drop the whole set for (entityId, pset) rather than
        // trying to replay per-property deletes it has no names for.
        for (const [psetName, change] of ev.changes.keys) {
          if (change.action === 'delete') {
            if (handlers.onPsetDelete) handlers.onPsetDelete(modelId, entityId, psetName);
            continue;
          }
          const added = target.get(psetName) as
            | { forEach?(fn: (v: unknown, k: string) => void): void }
            | undefined;
          added?.forEach?.((v, prop) => {
            const pv = v as { type?: string; value?: ScalarValue } | undefined;
            if (!pv) return;
            handlers.onProperty(
              modelId,
              entityId,
              psetName,
              prop,
              pv.value ?? null,
              propertyValueTypeFor(pv.type ?? 'IfcLabel'),
            );
          });
        }
      }
    }
  };

  entities.observeDeep(observer);
  return () => entities.unobserveDeep(observer);
}
