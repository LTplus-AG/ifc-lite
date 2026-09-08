/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `mergeBranch(parent, branch, 'layer')` must overlay the branch's edits
 * onto entities the parent already has.
 *
 * A branch forks from its parent, so essentially every *modified* entity
 * already exists in the merge target. The 'layer' strategy re-seeds the
 * parent from the branch's IFCX snapshot, and `seedFromIfcx` reaches
 * `createEntity`, which returns early on an existing path and discards
 * every supplied attribute, child and structured branch. Before the fix,
 * only entities the branch *created* survived a 'layer' merge; every edit
 * to a pre-existing entity was silently dropped.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabSession } from '../src/session.js';
import { forkSession, mergeBranch } from '../src/branch/branch.js';
import { createEntity, getAttribute, getEntity, setAttribute, setChild } from '../src/doc/entity.js';
import { ENTITY_KEY, GEOMETRY_KEY, entitiesMap } from '../src/doc/schema.js';
import { createGeometry, getGeometry, setGeometryBlobHash } from '../src/doc/geometry.js';

function pset(doc: Y.Doc, path: string, name: string): Y.Map<unknown> | undefined {
  const psets = getEntity(doc, path)?.get(ENTITY_KEY.PSETS) as
    | Y.Map<Y.Map<unknown>>
    | undefined;
  return psets?.get(name);
}

describe("mergeBranch('layer') overlays edits onto pre-existing entities", () => {
  it('carries a branch edit to an entity the parent already has', async () => {
    const parent = await createCollabSession({
      roomId: 'overlay-repro',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => {
      createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(parent.doc, 'wall', 'ifclite::name', 'Wall A');
    });

    const branch = await forkSession(parent, { name: 'rename-wall' });
    // Edit an entity that already exists in the parent...
    branch.session.transact(() =>
      setAttribute(branch.session.doc, 'wall', 'ifclite::name', 'Wall A (renamed)'),
    );
    // ...and create one that does not.
    branch.session.transact(() =>
      createEntity(branch.session.doc, 'window', { ifcClass: 'IfcWindow' }),
    );

    mergeBranch(parent, branch, 'layer');

    // The new entity always landed, even before the fix.
    expect(entitiesMap(parent.doc).has('window')).toBe(true);
    // The edit to the pre-existing entity is the data loss under test.
    expect(getAttribute(parent.doc, 'wall', 'ifclite::name')).toBe('Wall A (renamed)');

    branch.session.dispose();
    parent.dispose();
  });

  it('overlays structured branches (psets) and children onto pre-existing entities', async () => {
    const parent = await createCollabSession({
      roomId: 'overlay-structured',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => {
      createEntity(parent.doc, 'storey', { ifcClass: 'IfcBuildingStorey' });
      createEntity(parent.doc, 'wall', {
        ifcClass: 'IfcWall',
        psets: {
          Pset_WallCommon: {
            IsExternal: { type: 'IfcBoolean', value: false },
            Reference: { type: 'IfcIdentifier', value: 'W-01' },
          },
        },
      });
    });

    const branch = await forkSession(parent, { name: 'enrich-wall' });
    branch.session.transact(() => {
      setChild(branch.session.doc, 'storey', 'wall', 'wall');
      pset(branch.session.doc, 'wall', 'Pset_WallCommon')?.set('IsExternal', {
        type: 'IfcBoolean',
        value: true,
      });
    });

    mergeBranch(parent, branch, 'layer');

    expect(pset(parent.doc, 'wall', 'Pset_WallCommon')?.get('IsExternal')).toEqual({
      type: 'IfcBoolean',
      value: true,
    });
    // The property the branch never touched keeps its value.
    expect(pset(parent.doc, 'wall', 'Pset_WallCommon')?.get('Reference')).toEqual({
      type: 'IfcIdentifier',
      value: 'W-01',
    });

    const children = getEntity(parent.doc, 'storey')?.get(ENTITY_KEY.CHILDREN) as
      | Y.Map<string>
      | undefined;
    expect(children?.get('wall')).toBe('wall');

    branch.session.dispose();
    parent.dispose();
  });

  // Both directions. Overlaying must not clobber parent state the branch
  // snapshot has no opinion about. A merge that blindly rebuilt every
  // entity from its branch node would pass the "the edit landed" cases
  // above while silently erasing everything asserted here.
  it('does not clobber parent state the branch snapshot has no opinion about', async () => {
    const parent = await createCollabSession({
      roomId: 'overlay-both-ways',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => {
      createEntity(parent.doc, 'wall', {
        ifcClass: 'IfcWall',
        psets: { Pset_WallCommon: { IsExternal: { type: 'IfcBoolean', value: false } } },
      });
      setAttribute(parent.doc, 'wall', 'ifclite::name', 'Wall A');
    });

    const branch = await forkSession(parent, { name: 'touch-one-key' });
    branch.session.transact(() =>
      setAttribute(branch.session.doc, 'wall', 'ifclite::description', 'from branch'),
    );

    // Both of these land on the parent *after* the fork, so the branch's
    // snapshot carries no node opinion for either — a whole-entity rebuild
    // from the branch node would drop them.
    parent.transact(() => {
      setAttribute(parent.doc, 'wall', 'ifclite::tag', 'parent-only');
      pset(parent.doc, 'wall', 'Pset_WallCommon')?.set('LoadBearing', {
        type: 'IfcBoolean',
        value: true,
      });
      createEntity(parent.doc, 'door', { ifcClass: 'IfcDoor' });
    });

    mergeBranch(parent, branch, 'layer');

    // The branch's edit landed...
    expect(getAttribute(parent.doc, 'wall', 'ifclite::description')).toBe('from branch');
    // ...and none of the parent-only state was overwritten.
    expect(getAttribute(parent.doc, 'wall', 'ifclite::tag')).toBe('parent-only');
    expect(getAttribute(parent.doc, 'wall', 'ifclite::name')).toBe('Wall A');
    expect(pset(parent.doc, 'wall', 'Pset_WallCommon')?.get('LoadBearing')).toEqual({
      type: 'IfcBoolean',
      value: true,
    });
    expect(entitiesMap(parent.doc).has('door')).toBe(true);

    branch.session.dispose();
    parent.dispose();
  });
});

describe("mergeBranch('layer') overlays edits onto pre-existing GEOMETRY", () => {
  it('carries a branch edit to a geometry record the parent already has', async () => {
    const parent = await createCollabSession({
      roomId: 'overlay-geom-repro',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => {
      createGeometry(parent.doc, 'g1', {
        type: 'mesh',
        source: 'mesh-blob',
        blobHash: 'OLD',
      });
      createEntity(parent.doc, 'wall', {
        ifcClass: 'IfcWall',
        geometryRef: { geomIds: ['g1'] },
      });
    });

    const branch = await forkSession(parent, { name: 'remesh-wall' });
    // Re-mesh an existing geometry record...
    branch.session.transact(() => setGeometryBlobHash(branch.session.doc, 'g1', 'NEW'));
    // ...and add one the parent has never seen, so a merge that drops NOTHING
    // and a merge that drops only in-place edits are distinguishable.
    branch.session.transact(() => {
      createGeometry(branch.session.doc, 'g2', {
        type: 'mesh',
        source: 'mesh-blob',
        blobHash: 'FRESH',
      });
      createEntity(branch.session.doc, 'slab', {
        ifcClass: 'IfcSlab',
        geometryRef: { geomIds: ['g2'] },
      });
    });

    mergeBranch(parent, branch, 'layer');

    // The new record lands either way; it is the in-place edit that used to be
    // discarded, because `createGeometry` returns an existing record untouched.
    expect(getGeometry(parent.doc, 'g2')?.get(GEOMETRY_KEY.BLOB_HASH)).toBe('FRESH');
    expect(getGeometry(parent.doc, 'g1')?.get(GEOMETRY_KEY.BLOB_HASH)).toBe('NEW');

    branch.session.dispose();
    parent.dispose();
  });
});
