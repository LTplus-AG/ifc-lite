/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PropertyValueType } from '@ifc-lite/data';
import {
  createCollabDoc,
  createEntity,
  hasEntity,
  setAttribute,
  getAttribute,
  setEntityPlacement,
  getEntityPlacement,
  deleteEntity,
  setPropertyValue,
  getPropertyValue,
  deletePropertyValue,
  matrixToPlacement,
  USD_XFORMOP,
  PROPERTY_TYPE_NAMES,
} from '@ifc-lite/collab';
import type { CollabSession } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  mirrorPlacement,
  mirrorProperty,
  mirrorPropertyDelete,
  mirrorAttribute,
  mirrorEntityDelete,
  attachRemoteApply,
  registerEntityMaps,
  registerEntityPath,
  type CollabDocApi,
  type RemoteApplyHandlers,
} from './mutation-bridge.js';

/**
 * `yjs` is a transitive dependency (via `@ifc-lite/collab`), not a direct
 * dependency of the viewer package, so a bare `import 'yjs'` here fails
 * module resolution. Resolve it through collab's own `node_modules` instead
 * — only `attachRemoteApply`'s inbound tests need raw `Y.applyUpdate` to
 * simulate a genuine remote (`txn.local === false`) transaction, which Yjs
 * only produces via update decode, never via `doc.transact()`.
 *
 * Must load the exact same ESM build (`dist/yjs.mjs`) that `@ifc-lite/collab`
 * itself imports, NOT the CJS build `require('yjs')` would give us — yjs's
 * internal type checks are `instanceof`-based, and the CJS and ESM bundles
 * are distinct module instances with distinct classes, so mixing them throws
 * ("Unexpected content type") the moment a doc synced via the ESM build is
 * mutated through CJS `Y.Map`/`Y.Doc`.
 */
const collabCjsResolve = createRequire(import.meta.resolve('@ifc-lite/collab'));
const yjsEsmPath = collabCjsResolve.resolve('yjs').replace(/dist[\\/]yjs\.cjs$/, 'dist/yjs.mjs');
const Y: {
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  encodeStateAsUpdate(doc: YDoc, encodedTargetStateVector?: Uint8Array): Uint8Array;
  encodeStateVector(doc: YDoc): Uint8Array;
  Doc: new () => YDoc;
} = await import(pathToFileURL(yjsEsmPath).href);
type YDoc = ReturnType<typeof createCollabDoc>;

// Minimal CollabDocApi backed by the real collab doc helpers (the viewer wires
// the same shape from the lazy-loaded runtime in `collabSlice`).
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
    if (!xform || !Array.isArray(xform.transform)) return null;
    return matrixToPlacement(xform.transform);
  },
  PROPERTY_TYPE_NAMES,
};

/** A fake session — only `.doc` and `.transact` are exercised by the bridge. */
function fakeSession(doc: ReturnType<typeof createCollabDoc>): CollabSession {
  return { doc, transact: (fn: () => void) => doc.transact(fn) } as unknown as CollabSession;
}

/** A store with no STEP index — placement paths come from the injected maps. */
function fakeStore(idToPath: Map<number, string>): IfcDataStore {
  const store = {} as IfcDataStore;
  const pathToId = new Map<string, number>();
  for (const [id, path] of idToPath) pathToId.set(path, id);
  registerEntityMaps(store, idToPath, pathToId);
  return store;
}

describe('mutation-bridge entity-map registration', () => {
  it('registerEntityPath adds a runtime-created entity to both directions of the cache', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/newWall', { ifcClass: 'IfcWall' });
    // A store with an EMPTY pre-registered map (as if it had no STEP index at
    // all) — registerEntityPath must be able to add to it after the fact,
    // and the new mapping must work in both directions (id→path AND
    // path→id), since outbound mirroring uses one and inbound apply the other.
    const store = fakeStore(new Map());

    registerEntityPath(store, 42, '/newWall');

    mirrorPlacement(api, fakeSession(doc), store, 42, { location: [7, 8, 9] });
    const placed = getEntityPlacement(doc, '/newWall');
    assert.ok(placed, 'registerEntityPath must make the id resolvable outbound (pathForEntity)');
    assert.deepEqual(placed!.location, [7, 8, 9]);

    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);
    applyAsRemoteEdit(doc, (remote) => {
      setAttribute(remote, '/newWall', 'bsi::ifc::prop::Name', 'New Wall');
    });
    teardown();
    assert.strictEqual(handlers.calls.length, 1, 'registerEntityPath must make the path resolvable inbound (entityForPath)');
    assert.deepEqual(handlers.calls[0], { fn: 'onAttribute', args: [42, 'bsi::ifc::prop::Name', 'New Wall'] });
  });
});

describe('mutation-bridge placement (outbound)', () => {
  it('mirrorPlacement writes the entity placement as usd::xformop', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));

    mirrorPlacement(api, fakeSession(doc), store, 1, { location: [2, 3, 4] });

    const placed = getEntityPlacement(doc, '/wallA');
    assert.ok(placed, 'placement should be written');
    assert.deepEqual(placed!.location, [2, 3, 4]);
  });

  it('mirrorPlacement no-ops when the entity is not in the doc', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    // Map points expressId 2 at a path the doc does not have.
    const store = fakeStore(new Map([[2, '/ghost']]));

    mirrorPlacement(api, fakeSession(doc), store, 2, { location: [9, 9, 9] });

    assert.equal(getEntityPlacement(doc, '/ghost'), null);
  });

  it('mirrorPlacement no-ops when the store has no path for the entity', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map()); // no maps at all

    // Should not throw and should not write a placement.
    mirrorPlacement(api, fakeSession(doc), store, 1, { location: [1, 1, 1] });
    assert.equal(getEntityPlacement(doc, '/wallA'), null);
  });
});

describe('mutation-bridge property/attribute/delete (outbound)', () => {
  it('mirrorProperty writes a pset property with the mapped IFCX type name', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));

    mirrorProperty(api, fakeSession(doc), store, 1, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const pv = getPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal');
    assert.ok(pv, 'property should be written');
    assert.strictEqual(pv!.value, true);
    // Pinned against the literal wire type name, not just "truthy" — this is
    // the exact shape `propertyValueTypeFor` must decode back on the inbound
    // side, so a swapped type constant would silently corrupt round-tripping.
    assert.strictEqual(pv!.type, 'IfcBoolean');
    assert.strictEqual(pv!.source, 'manual');
  });

  it('mirrorProperty no-ops when the entity is not in the doc', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[2, '/ghost']]));

    mirrorProperty(api, fakeSession(doc), store, 2, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    assert.strictEqual(getPropertyValue(doc, '/ghost', 'Pset_WallCommon', 'IsExternal'), undefined);
  });

  it('mirrorPropertyDelete removes an existing pset property', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    setPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal', { type: 'IfcBoolean', value: true });
    const store = fakeStore(new Map([[1, '/wallA']]));

    mirrorPropertyDelete(api, fakeSession(doc), store, 1, 'Pset_WallCommon', 'IsExternal');

    assert.strictEqual(getPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal'), undefined);
  });

  it('mirrorPropertyDelete no-ops when the entity is not in the doc', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    setPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal', { type: 'IfcBoolean', value: true });
    const store = fakeStore(new Map([[2, '/ghost']]));

    mirrorPropertyDelete(api, fakeSession(doc), store, 2, 'Pset_WallCommon', 'IsExternal');

    // The real entity's property must survive untouched.
    assert.deepEqual(getPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal'), {
      type: 'IfcBoolean',
      value: true,
    });
  });

  it('mirrorAttribute writes a flat attribute, converting the value with toScalar', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));

    mirrorAttribute(api, fakeSession(doc), store, 1, 'bsi::ifc::prop::Name', 'Wall-A');

    assert.strictEqual(getAttribute(doc, '/wallA', 'bsi::ifc::prop::Name'), 'Wall-A');
  });

  it('mirrorAttribute collapses a list/ref value to its stable JSON string form (toScalar)', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));

    mirrorAttribute(api, fakeSession(doc), store, 1, 'bsi::ifc::prop::Layers', ['a', 'b', 3]);

    // Pinned against the literal JSON string, not just "truthy" — toScalar's
    // array branch must specifically produce `JSON.stringify`, not the
    // generic `String(value)` fallback (which would yield "a,b,3" and lose
    // round-trip fidelity through the CRDT's flat-attribute wire shape).
    assert.strictEqual(getAttribute(doc, '/wallA', 'bsi::ifc::prop::Layers'), '["a","b",3]');
  });

  it('mirrorAttribute no-ops when the entity is not in the doc', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[2, '/ghost']]));

    mirrorAttribute(api, fakeSession(doc), store, 2, 'bsi::ifc::prop::Name', 'Ghost');

    assert.strictEqual(getAttribute(doc, '/ghost', 'bsi::ifc::prop::Name'), undefined);
  });

  it('mirrorEntityDelete tombstones the entity', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));
    assert.ok(hasEntity(doc, '/wallA'));

    mirrorEntityDelete(api, fakeSession(doc), store, 1);

    assert.strictEqual(hasEntity(doc, '/wallA'), false);
  });

  it('mirrorEntityDelete no-ops when the entity is not in the doc', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[2, '/ghost']]));

    mirrorEntityDelete(api, fakeSession(doc), store, 2);

    // The real entity must survive untouched.
    assert.ok(hasEntity(doc, '/wallA'));
  });
});

// ── inbound: remote CRDT change → local model ────────────────────────────────

/**
 * Simulate a peer's edit landing on `doc`: fork a second Y.Doc from `doc`'s
 * current state, mutate the fork, then apply the diff back onto `doc`. Yjs
 * marks transactions built from `applyUpdate` as non-local (`txn.local ===
 * false`), exactly like a real y-websocket sync — unlike calling
 * `doc.transact()` directly, which is what the bridge's own outbound mirror
 * does and must be ignored by `attachRemoteApply`'s echo guard.
 */
function applyAsRemoteEdit(doc: YDoc, mutate: (remote: YDoc) => void): void {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  mutate(remote);
  const diff = Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc));
  Y.applyUpdate(doc, diff);
}

function recordingHandlers(): RemoteApplyHandlers & {
  calls: { fn: string; args: unknown[] }[];
} {
  const calls: { fn: string; args: unknown[] }[] = [];
  return {
    calls,
    onProperty: (...args) => calls.push({ fn: 'onProperty', args }),
    onPropertyDelete: (...args) => calls.push({ fn: 'onPropertyDelete', args }),
    onAttribute: (...args) => calls.push({ fn: 'onAttribute', args }),
    onPlacement: (...args) => calls.push({ fn: 'onPlacement', args }),
    onEntityDelete: (...args) => calls.push({ fn: 'onEntityDelete', args }),
  };
}

describe('mutation-bridge attachRemoteApply (inbound)', () => {
  it('dispatches a remote pset property write to onProperty (pset already exists)', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    // Seed the pset with an unrelated property first — Yjs's deep-observe
    // only fires a `[entityPath, 'psets', psetName]` event (what the bridge
    // listens for) when the pset's Y.Map already existed before the remote
    // transaction. See the sibling "brand-new pset" test below for the case
    // where it doesn't.
    setPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'Reference', { type: 'IfcIdentifier', value: 'seed' });
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      setPropertyValue(remote, '/wallA', 'Pset_WallCommon', 'IsExternal', { type: 'IfcBoolean', value: true });
    });

    teardown();
    assert.strictEqual(handlers.calls.length, 1);
    assert.deepEqual(handlers.calls[0], {
      fn: 'onProperty',
      args: [1, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean],
    });
  });

  it('maps every remote IFCX property type string to its PropertyValueType (propertyValueTypeFor)', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    // Seed distinct pset names up front (each pre-existing) so every remote
    // write below lands on an already-existing pset map and reliably fires
    // the `[entityPath, 'psets', psetName]` event (see the "pset already
    // exists" test above for why that matters).
    const cases: { ifcType: string; expected: PropertyValueType }[] = [
      { ifcType: 'IfcInteger', expected: PropertyValueType.Integer },
      { ifcType: 'IfcReal', expected: PropertyValueType.Real },
      { ifcType: 'IfcIdentifier', expected: PropertyValueType.Identifier },
      { ifcType: 'IfcText', expected: PropertyValueType.Text },
      { ifcType: 'IfcLogical', expected: PropertyValueType.Boolean },
      { ifcType: 'SomeUnknownType', expected: PropertyValueType.Label }, // default arm
    ];
    for (const { ifcType } of cases) {
      setPropertyValue(doc, '/wallA', `Pset_${ifcType}`, 'seed', { type: 'IfcLabel', value: 'x' });
    }
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      for (const { ifcType } of cases) {
        setPropertyValue(remote, '/wallA', `Pset_${ifcType}`, 'Value', { type: ifcType as never, value: 1 });
      }
    });

    teardown();
    assert.strictEqual(handlers.calls.length, cases.length);
    for (const { ifcType, expected } of cases) {
      const call = handlers.calls.find(
        (c) => c.fn === 'onProperty' && c.args[1] === `Pset_${ifcType}`,
      );
      assert.ok(call, `expected an onProperty call for ${ifcType}`);
      assert.strictEqual(call!.args[4], expected, `${ifcType} should map to PropertyValueType ${expected}`);
    }
  });

  /**
   * REGRESSION for a live defect found in audit round 20 and fixed in the same
   * change. When a remote peer writes the FIRST property of a brand-new Pset,
   * Yjs reports it as a single `add` on the `psets` map itself
   * (`path === [entityPath, 'psets']`) — the nested pset map does not exist yet
   * when the transaction is observed, so no `path.length === 3` event is ever
   * emitted. `attachRemoteApply` matched only `path.length === 3`, so that
   * first property never reached `MutablePropertyView`: it was correctly
   * persisted in the Y.Doc, but a collaborator's new Pset stayed invisible
   * until a reload forced a full reconstruct.
   *
   * Verified against real Yjs event shapes, not inferred: a remote add emits
   * exactly one event, `path ["/wallA","psets"] len 2, action add`.
   */
  it('delivers a remote pset property write when the pset is brand new', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' }); // psets map starts empty
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      setPropertyValue(remote, '/wallA', 'Pset_WallCommon', 'IsExternal', { type: 'IfcBoolean', value: true });
    });

    teardown();
    // The write is in the CRDT...
    assert.deepEqual(getPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal'), {
      type: 'IfcBoolean',
      value: true,
    });
    // ...and the live-sync handler now receives it.
    assert.strictEqual(handlers.calls.length, 1);
    assert.deepEqual(handlers.calls[0], {
      fn: 'onProperty',
      args: [1, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean],
    });
  });

  it('dispatches a remote pset property delete to onPropertyDelete, not onProperty (pset survives)', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    setPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal', { type: 'IfcBoolean', value: true });
    // A second property in the same pset so the pset map is NOT emptied
    // (and therefore not itself removed) by the delete below.
    setPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'Reference', { type: 'IfcIdentifier', value: 'seed' });
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      deletePropertyValue(remote, '/wallA', 'Pset_WallCommon', 'IsExternal');
    });

    teardown();
    assert.strictEqual(handlers.calls.length, 1);
    assert.deepEqual(handlers.calls[0], {
      fn: 'onPropertyDelete',
      args: [1, 'Pset_WallCommon', 'IsExternal'],
    });
  });

  /**
   * LIVE DEFECT (audit round 20), the mirror image of the "brand new pset"
   * gap above. `deletePropertyValue` (packages/collab/src/doc/entity.ts)
   * deletes the whole Pset map when its last property is removed
   * (`if (pset.size === 0) psets!.delete(psetName)`), so deleting the LAST
   * property of a Pset collapses to a single `'delete'` event on the
   * `psets` map itself (`path.length === 2`), never on the (now-removed)
   * pset map at `path.length === 3`. `onPropertyDelete` is never invoked, so
   * a remote peer's deletion of a Pset's only property leaves a stale
   * property in the local `MutablePropertyView` until the next full
   * reconstruct. Pins current behavior; do not treat 0 calls as intended.
   */
  it('[DEFECT] drops a remote pset property delete when it empties (and removes) the pset', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    setPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal', { type: 'IfcBoolean', value: true });
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      deletePropertyValue(remote, '/wallA', 'Pset_WallCommon', 'IsExternal');
    });

    teardown();
    // The CRDT correctly reflects the delete (and cascades the now-empty pset)...
    assert.strictEqual(getPropertyValue(doc, '/wallA', 'Pset_WallCommon', 'IsExternal'), undefined);
    // ...but the live-sync handler is never told, so a stale copy lingers
    // in whatever already consumed the earlier (correctly-delivered) add.
    assert.strictEqual(handlers.calls.length, 0, 'known gap: see [DEFECT] comment above');
  });

  it('dispatches a remote flat attribute write to onAttribute', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      setAttribute(remote, '/wallA', 'bsi::ifc::prop::Name', 'Wall-A');
    });

    teardown();
    assert.strictEqual(handlers.calls.length, 1);
    assert.deepEqual(handlers.calls[0], {
      fn: 'onAttribute',
      args: [1, 'bsi::ifc::prop::Name', 'Wall-A'],
    });
  });

  it('routes a remote usd::xformop write to onPlacement, not onAttribute', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      setEntityPlacement(remote, '/wallA', { location: [5, 6, 7] });
    });

    teardown();
    assert.strictEqual(handlers.calls.length, 1, 'exactly one handler call, not also onAttribute');
    assert.strictEqual(handlers.calls[0].fn, 'onPlacement');
    assert.strictEqual(handlers.calls[0].args[0], 1);
    assert.deepEqual((handlers.calls[0].args[1] as { location: number[] }).location, [5, 6, 7]);
  });

  it('dispatches a remote entity delete to onEntityDelete', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      deleteEntity(remote, '/wallA');
    });

    teardown();
    assert.strictEqual(handlers.calls.length, 1);
    assert.deepEqual(handlers.calls[0], { fn: 'onEntityDelete', args: [1] });
  });

  it('ignores local writes (own outbound mirror) — no echo back into handlers', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    const store = fakeStore(new Map([[1, '/wallA']]));
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    // A direct local transact — this is exactly what `mirrorAttribute` does.
    doc.transact(() => {
      setAttribute(doc, '/wallA', 'bsi::ifc::prop::Name', 'Wall-A');
    });

    teardown();
    assert.strictEqual(handlers.calls.length, 0, 'local echo must not re-dispatch into the handlers');
  });

  it('skips a remote edit for a path the store cannot resolve to an expressId', () => {
    const doc = createCollabDoc();
    createEntity(doc, '/wallA', { ifcClass: 'IfcWall' });
    // Store has no maps at all — entityForPath resolves null for every path.
    const store = fakeStore(new Map());
    const handlers = recordingHandlers();
    const teardown = attachRemoteApply(api, fakeSession(doc), store, handlers);

    applyAsRemoteEdit(doc, (remote) => {
      setAttribute(remote, '/wallA', 'bsi::ifc::prop::Name', 'Wall-A');
    });

    teardown();
    assert.strictEqual(handlers.calls.length, 0, 'unresolvable path must not reach any handler');
  });
});
