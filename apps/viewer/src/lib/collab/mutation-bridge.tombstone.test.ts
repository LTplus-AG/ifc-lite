/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A peer's write to a LOCALLY DELETED entity must be refused at the inbound
 * dispatch, for every handler that writes the room model's
 * `MutablePropertyView` (#5187; the attribute case first landed with #5063).
 *
 * WHY: `MutablePropertyView` records property and attribute writes regardless
 * of tombstone state, and `restoreFromTombstone` — what undoing the local
 * delete calls — clears only the tombstone. A write accepted while the entity
 * was deleted therefore comes back live on the restored entity, in a slot the
 * local user never edited. Executed on #5187: `deleteEntity(42)`, a remote
 * `setProperty`, `restoreFromTombstone(42)`, and the peer's value reads back.
 *
 * WHY AT THE DISPATCH and not in `setProperty` / `setPositionalAttribute`:
 * undo/redo replay calls those view primitives unconditionally by design, and
 * a blanket refusal there would break replay. Before #5187 the check lived in
 * ONE handler's helper (`applyRemoteAttribute`), so the property,
 * property-delete and pset-delete handlers each wrote through with no check.
 * `attachRemoteApply` now guards all four before dispatching.
 *
 * Driven end to end: a real collab Y.Doc, a genuine remote transaction
 * (`txn.local === false`, produced only by update decode), the real
 * `attachRemoteApply`, and handlers that write the view exactly as
 * `collabSlice`'s do. No `@ifc-lite/export` import, so no wasm is needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import {
  createCollabDoc,
  createEntity,
  hasEntity,
  setAttribute,
  setEntityPlacement,
  deleteEntity,
  setPropertyValue,
  deletePropertyValue,
  matrixToPlacement,
  USD_XFORMOP,
  PROPERTY_TYPE_NAMES,
} from '@ifc-lite/collab';
import type { CollabSession } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import { applyRemoteAttribute, attachRemoteApply, type CollabDocApi, type RemoteApplyHandlers } from './mutation-bridge.js';
import { registerEntityMaps } from './entity-paths.js';

// yjs is only a transitive dependency; load the same ESM build collab uses
// (see mutation-bridge.test.ts for why the CJS build cannot be mixed in).
const collabCjsResolve = createRequire(import.meta.resolve('@ifc-lite/collab'));
const yjsEsmPath = collabCjsResolve.resolve('yjs').replace(/dist[\\/]yjs\.cjs$/, 'dist/yjs.mjs');
type YDoc = ReturnType<typeof createCollabDoc>;
const Y: {
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  encodeStateAsUpdate(doc: YDoc, encodedTargetStateVector?: Uint8Array): Uint8Array;
  encodeStateVector(doc: YDoc): Uint8Array;
  Doc: new () => YDoc;
} = await import(pathToFileURL(yjsEsmPath).href);

const api: CollabDocApi = {
  hasEntity: (doc, path) => hasEntity(doc, path),
  setPropertyValue: (doc, path, pset, prop, value) =>
    setPropertyValue(doc, path, pset, prop, { type: value.type, value: value.value, source: value.source }),
  deletePropertyValue: (doc, path, pset, prop) => deletePropertyValue(doc, path, pset, prop),
  setAttribute: (doc, path, name, value) => setAttribute(doc, path, name, value),
  setEntityPlacement: (doc, path, placement) => setEntityPlacement(doc, path, placement),
  deleteEntity: (doc, path) => deleteEntity(doc, path),
  createEntity: (doc, path, options) => { createEntity(doc, path, options); },
  XFORMOP_KEY: USD_XFORMOP,
  placementFromXformOp: (value) => {
    const xform = value as { transform?: number[][] } | undefined;
    return xform && Array.isArray(xform.transform) ? matrixToPlacement(xform.transform) : null;
  },
  PROPERTY_TYPE_NAMES,
};

const MODEL = 'room:r1:m0';
const WALL = 42;
const WALL_PATH = '/wall';

/** One wall, known to the path maps and typed so attribute names resolve. */
function roomFixture() {
  const doc = createCollabDoc();
  createEntity(doc, WALL_PATH, { ifcClass: 'IfcWall' });
  setPropertyValue(doc, WALL_PATH, 'Pset_Remote', 'Status', { type: 'IfcLabel', value: 'original' });
  setPropertyValue(doc, WALL_PATH, 'Pset_Remote', 'Keep', { type: 'IfcLabel', value: 'kept' });
  const store = {
    schemaVersion: 'IFC4',
    entities: { getTypeName: (id: number) => (id === WALL ? 'IfcWall' : 'Unknown') },
  } as unknown as IfcDataStore;
  registerEntityMaps(store, new Map([[WALL, WALL_PATH]]), new Map([[WALL_PATH, WALL]]));

  const view = new MutablePropertyView(null, MODEL);
  view.setProperty(WALL, 'Pset_Remote', 'Status', 'original', PropertyValueType.Label);
  view.setProperty(WALL, 'Pset_Remote', 'Keep', 'kept', PropertyValueType.Label);
  const rejected: string[] = [];

  // The same writes collabSlice's handlers make into the room model's view.
  const handlers: RemoteApplyHandlers = {
    isLocallyDeleted: (_modelId, id) => view.isDeleted(id),
    onRejectedWrite: (reason) => rejected.push(reason),
    onProperty: (_m, id, pset, prop, value, type) => view.setProperty(id, pset, prop, value, type),
    onPropertyDelete: (_m, id, pset, prop) => { view.deleteProperty(id, pset, prop); },
    onPsetDelete: (_m, id, pset) => { view.deletePropertySet(id, pset); },
    onAttribute: (_m, id, name, value) => {
      const reason = applyRemoteAttribute(view, store, id, name, value);
      if (reason) rejected.push(reason);
    },
  };
  const session = { doc, transact: (fn: () => void) => doc.transact(fn) } as unknown as CollabSession;
  const teardown = attachRemoteApply(api, session, () => ({ modelId: MODEL, store }), handlers);

  const remoteEdit = (mutate: (remote: YDoc) => void) => {
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    mutate(remote);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));
  };
  return { view, rejected, remoteEdit, teardown };
}

const status = (view: MutablePropertyView) => view.getPropertyValue(WALL, 'Pset_Remote', 'Status');

describe('#5187: a remote write to a locally deleted entity is refused, then stays refused after undo', () => {
  it('property write: not recorded, reported, and not resurrected by restoreFromTombstone', () => {
    const { view, rejected, remoteEdit, teardown } = roomFixture();
    view.deleteEntity(WALL);

    remoteEdit((r) => setPropertyValue(r, WALL_PATH, 'Pset_Remote', 'Status', { type: 'IfcLabel', value: 'LIVE_FROM_PEER' }));
    view.restoreFromTombstone(WALL); // the local user undoes their delete
    teardown();

    assert.strictEqual(status(view), 'original');
    assert.deepStrictEqual(rejected, [`entity ${WALL} is locally deleted`]);
  });

  it('property delete: not recorded, so the property survives the undo', () => {
    const { view, rejected, remoteEdit, teardown } = roomFixture();
    view.deleteEntity(WALL);

    remoteEdit((r) => deletePropertyValue(r, WALL_PATH, 'Pset_Remote', 'Status'));
    view.restoreFromTombstone(WALL);
    teardown();

    assert.strictEqual(status(view), 'original');
    assert.strictEqual(rejected.length, 1);
  });

  it('whole-pset delete: not recorded, so the pset survives the undo', () => {
    const { view, rejected, remoteEdit, teardown } = roomFixture();
    view.deleteEntity(WALL);

    remoteEdit((r) => {
      deletePropertyValue(r, WALL_PATH, 'Pset_Remote', 'Status');
      deletePropertyValue(r, WALL_PATH, 'Pset_Remote', 'Keep'); // last property: the pset goes
    });
    view.restoreFromTombstone(WALL);
    teardown();

    assert.strictEqual(status(view), 'original');
    assert.strictEqual(view.getPropertyValue(WALL, 'Pset_Remote', 'Keep'), 'kept');
    assert.ok(rejected.length >= 1);
  });

  it('attribute write: not recorded, so no positional override is resurrected', () => {
    const { view, rejected, remoteEdit, teardown } = roomFixture();
    view.deleteEntity(WALL);

    remoteEdit((r) => setAttribute(r, WALL_PATH, 'Description', 'peer value'));
    view.restoreFromTombstone(WALL);
    teardown();

    assert.strictEqual(view.getPositionalMutationsForEntity(WALL), null);
    assert.deepStrictEqual(rejected, [`entity ${WALL} is locally deleted`]);
  });

  it('guards only the deleted id: a live entity still takes every remote write', () => {
    const { view, rejected, remoteEdit, teardown } = roomFixture();
    view.deleteEntity(7);

    remoteEdit((r) => {
      setPropertyValue(r, WALL_PATH, 'Pset_Remote', 'Status', { type: 'IfcLabel', value: 'LIVE_FROM_PEER' });
      setAttribute(r, WALL_PATH, 'Description', 'peer value');
    });
    teardown();

    assert.strictEqual(status(view), 'LIVE_FROM_PEER');
    assert.strictEqual(view.getPositionalMutationsForEntity(WALL)?.get(3), 'peer value');
    assert.deepStrictEqual(rejected, []);
  });
});
