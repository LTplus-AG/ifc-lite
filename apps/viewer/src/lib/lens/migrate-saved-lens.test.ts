/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Lens } from '@ifc-lite/lens';

const old = {
  id: 'built-in', name: 'Old', rules: [{
    id: 'r1', name: 'Walls', enabled: true,
    criteria: { type: 'ifcType', ifcType: 'IfcWall' },
    action: 'colorize', color: '#123456',
  }],
};

describe('#5896 saved Lens import across all entry paths', () => {
  it('upserts an exported v1 built-in by ID and retains its protected status', async () => {
    const migration = await import('./migrate-saved-lens.js').catch(() => null);
    assert.ok(migration?.mergeImportedGroupLenses, 'the unified saved Lens path must be available');
    const existing = [{ id: 'built-in', name: 'Original', rules: [], builtin: true }] satisfies Lens[];
    const result = migration.mergeImportedGroupLenses(existing, [old], () => 'unused');
    assert.equal(result.length, 1);
    assert.equal(result[0].builtin, true);
    assert.equal(result[0].name, 'Old');
    assert.ok(result[0].rules[0].groups?.length);
  });

  it('keeps unreadable source data through a v2 export and re-import', async () => {
    const migration = await import('./migrate-saved-lens.js').catch(() => null);
    assert.ok(migration?.migrateSavedLens, 'the unified saved Lens path must be available');
    const raw = { type: 'material', materialName: 'Concrete' };
    const first = migration.migrateSavedLens({ ...old, id: 'custom', rules: [{ ...old.rules[0], criteria: raw }] });
    assert.ok(first?.rules[0].unreadableLegacy);
    const second = migration.migrateSavedLens(JSON.parse(JSON.stringify(first)));
    assert.deepEqual(second?.rules[0].unreadableLegacy?.criteria, raw);
    assert.deepEqual(second?.rules[0].groups, []);
  });
});
