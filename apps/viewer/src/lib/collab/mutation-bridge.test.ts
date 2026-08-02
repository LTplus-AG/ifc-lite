/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createCollabDoc,
  createEntity,
  hasEntity,
  setAttribute,
  setEntityPlacement,
  getEntityPlacement,
  deleteEntity,
  setPropertyValue,
  deletePropertyValue,
  matrixToPlacement,
  USD_XFORMOP,
  PROPERTY_TYPE_NAMES,
} from '@ifc-lite/collab';
import type { CollabSession } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import { mirrorPlacement, registerEntityMaps, type CollabDocApi } from './mutation-bridge.js';

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
