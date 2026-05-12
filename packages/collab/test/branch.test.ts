/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabSession } from '../src/session.js';
import { forkSession, mergeBranch, readBranchMeta } from '../src/branch/branch.js';
import {
  createEntity,
  getAttribute,
  setAttribute,
  setPropertyValue,
} from '../src/doc/entity.js';
import { entitiesMap } from '../src/doc/schema.js';

describe('branching (fork + mergeBranch)', () => {
  it('fork seeds the branch with the parent state and stamps metadata', async () => {
    const parent = await createCollabSession({
      roomId: 'parent-1',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => {
      createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(parent.doc, 'wall', 'Name', 'parent-name');
    });

    const branch = await forkSession(parent, { name: 'experiment' });
    expect(branch.parentRoomId).toBe('parent-1');
    expect(branch.branchName).toBe('experiment');

    // Parent state landed on branch.
    expect(getAttribute(branch.session.doc, 'wall', 'Name')).toBe('parent-name');

    // Branch carries the metadata round-trip.
    const meta = readBranchMeta(branch.session);
    expect(meta.parentRoomId).toBe('parent-1');
    expect(meta.branchName).toBe('experiment');
    expect(typeof meta.forkedAt).toBe('string');

    branch.session.dispose();
    parent.dispose();
  });

  it('mergeBranch (ops strategy) brings branch edits back into parent', async () => {
    const parent = await createCollabSession({
      roomId: 'parent-2',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => {
      createEntity(parent.doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(parent.doc, 'wall', 'Name', 'baseline');
    });
    const branch = await forkSession(parent, { name: 'tweak' });

    // Independent edits on branch and parent.
    branch.session.transact(() => {
      setAttribute(branch.session.doc, 'wall', 'Description', 'from-branch');
      setPropertyValue(branch.session.doc, 'wall', 'Pset_WallCommon', 'FireRating', {
        type: 'IfcLabel',
        value: 'EI60',
      });
    });
    parent.transact(() => setAttribute(parent.doc, 'wall', 'Name', 'parent-edited'));

    const report = mergeBranch(parent, branch, 'ops');
    expect(report.strategy).toBe('ops');
    expect(report.bytes).toBeGreaterThan(0);

    // Branch's writes landed on parent.
    expect(getAttribute(parent.doc, 'wall', 'Description')).toBe('from-branch');
    // Parent's own write survives where it didn't conflict.
    expect(getAttribute(parent.doc, 'wall', 'Name')).toBe('parent-edited');

    branch.session.dispose();
    parent.dispose();
  });

  it('mergeBranch (layer strategy) re-seeds parent from branch IFCX', async () => {
    const parent = await createCollabSession({
      roomId: 'parent-3',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    parent.transact(() => createEntity(parent.doc, 'wall'));
    const branch = await forkSession(parent, { name: 'add-window' });
    branch.session.transact(() => createEntity(branch.session.doc, 'window'));

    expect(entitiesMap(parent.doc).has('window')).toBe(false);
    const report = mergeBranch(parent, branch, 'layer');
    expect(report.strategy).toBe('layer');
    expect(entitiesMap(parent.doc).has('window')).toBe(true);

    branch.session.dispose();
    parent.dispose();
  });
});
