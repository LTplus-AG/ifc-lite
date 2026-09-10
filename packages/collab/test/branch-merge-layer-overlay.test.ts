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
import {
  createEntity,
  deleteEntity,
  getAttribute,
  getEntity,
  setAttribute,
  setChild,
} from '../src/doc/entity.js';
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

// Regression coverage for #4242: an IFCX snapshot of the branch emits only
// what an entity has, so a branch-side deletion is indistinguishable on the
// wire from "no opinion" — `applyIfcxOverlay` cannot remove what it never
// sees. This is documented, maintainer-confirmed behaviour (see the code
// comment above `mergeBranch`'s 'layer' branch and the issue thread), not a
// bug to fix here. What was missing before this test/field existed: nothing
// pinned the behaviour, and `MergeReport` gave the caller no way to detect
// it happened.
describe("mergeBranch('layer') cannot propagate branch deletions (documented limitation)", () => {
  it('resurrects an entity the branch deleted, and reports the drop', async () => {
    const parent = await createCollabSession({
      roomId: 'deletion-drop-repro',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' }));

    const branch = await forkSession(parent, { name: 'remove-wall' });
    branch.session.transact(() => deleteEntity(branch.session.doc, 'wall'));

    const report = mergeBranch(parent, branch, 'layer');

    // The known limitation, pinned: the wall is back.
    expect(entitiesMap(parent.doc).has('wall')).toBe(true);
    // The diagnostic this issue asked for: the caller can now tell.
    expect(report.droppedDeletions).toBe(1);

    branch.session.dispose();
    parent.dispose();
  });

  it('does not count an entity the parent created after the fork as a dropped deletion', async () => {
    // Load-bearing negative case: an entity absent from the branch doc is
    // not necessarily one the branch deleted — it may simply not exist yet
    // because the parent created it *after* the fork. Both look identical
    // as "missing from branch.session.doc"; only the fork-time snapshot
    // tells them apart. Miscounting this as a dropped deletion would be a
    // false alarm telling a caller data was lost when nothing happened.
    const parent = await createCollabSession({
      roomId: 'deletion-drop-false-positive',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' }));

    const branch = await forkSession(parent, { name: 'unrelated-edit' });
    // Parent creates a *new* entity after the fork; the branch never had it
    // and never deleted it.
    parent.transact(() => createEntity(parent.doc, 'door', { ifcClass: 'IfcDoor' }));
    // Branch makes an unrelated edit so the merge is not a no-op.
    branch.session.transact(() =>
      setAttribute(branch.session.doc, 'wall', 'ifclite::name', 'renamed'),
    );

    const report = mergeBranch(parent, branch, 'layer');

    expect(report.droppedDeletions).toBe(0);
    expect(entitiesMap(parent.doc).has('door')).toBe(true);
    expect(getAttribute(parent.doc, 'wall', 'ifclite::name')).toBe('renamed');

    branch.session.dispose();
    parent.dispose();
  });

  it('reports droppedDeletions: 0 and still carries branch edits through on an ordinary merge', async () => {
    // Both directions matter: the diagnostic must not fire on a normal
    // merge, and a normal merge's edits must still land. A "fix" that
    // makes ordinary merges look like they dropped something (or that
    // stops carrying real edits through) would be worse than the bug.
    const parent = await createCollabSession({
      roomId: 'deletion-drop-ordinary-merge',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' }));

    const branch = await forkSession(parent, { name: 'rename-only' });
    branch.session.transact(() =>
      setAttribute(branch.session.doc, 'wall', 'ifclite::name', 'Wall A'),
    );

    const report = mergeBranch(parent, branch, 'layer');

    expect(report.droppedDeletions).toBe(0);
    expect(getAttribute(parent.doc, 'wall', 'ifclite::name')).toBe('Wall A');

    branch.session.dispose();
    parent.dispose();
  });

  it("reports droppedDeletions: 0 for the 'ops' strategy, which propagates deletions natively", async () => {
    const parent = await createCollabSession({
      roomId: 'deletion-drop-ops-strategy',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' }));

    const branch = await forkSession(parent, { name: 'remove-wall-ops' });
    branch.session.transact(() => deleteEntity(branch.session.doc, 'wall'));

    const report = mergeBranch(parent, branch, 'ops');

    expect(report.droppedDeletions).toBe(0);
    expect(entitiesMap(parent.doc).has('wall')).toBe(false);

    branch.session.dispose();
    parent.dispose();
  });

  it('does not count an entity as a dropped deletion when the parent also deleted it', async () => {
    // Load-bearing negative case for the other half of the guard: an
    // entity present at fork time, deleted on the branch, AND also gone
    // from the parent by merge time (here because the parent independently
    // deleted it too) is not a dropped deletion — there is nothing left on
    // the parent for the branch's deletion to fail to remove. Miscounting
    // this would over-count `droppedDeletions` for a deletion both sides
    // agreed on, the same false-alarm failure mode as the fork-time guard
    // above, just on the parent side of the check.
    const parent = await createCollabSession({
      roomId: 'deletion-drop-both-sides-deleted',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' }));

    const branch = await forkSession(parent, { name: 'remove-wall-both-sides' });
    branch.session.transact(() => deleteEntity(branch.session.doc, 'wall'));
    // Parent independently deletes the same entity before the merge lands.
    parent.transact(() => deleteEntity(parent.doc, 'wall'));

    const report = mergeBranch(parent, branch, 'layer');

    expect(report.droppedDeletions).toBe(0);
    expect(entitiesMap(parent.doc).has('wall')).toBe(false);

    branch.session.dispose();
    parent.dispose();
  });
});
