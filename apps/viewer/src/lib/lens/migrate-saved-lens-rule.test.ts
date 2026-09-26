/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadMigration() {
  const module = await import('./migrate-saved-lens-rule.js').catch(() => null);
  assert.ok(module?.migrateSavedLensRule, 'the saved Lens migration must be available');
  return module.migrateSavedLensRule;
}

const core = {
  id: 'saved-rule', name: 'Rated walls', enabled: true,
  action: 'colorize', color: '#123456',
};

describe('#5896 saved Lens rule migration', () => {
  it('converts a representable v1 condition into canonical groups', async () => {
    const migrateSavedLensRule = await loadMigration();
    const saved = { ...core, criteria: { type: 'ifcType', ifcType: 'IfcWall' } };
    const result = migrateSavedLensRule(saved);
    assert.equal(result?.id, core.id);
    assert.equal(result?.groups.length, 1);
    const rule = result?.groups[0].rules[0];
    assert.equal(rule?.kind, 'ifcType');
    if (rule?.kind === 'ifcType') {
      assert.equal(rule.op, 'in');
      assert.ok(rule.values.includes('IfcWall'));
      assert.ok(rule.values.includes('IfcWallStandardCase'));
    }
  });

  it('preserves unreadable v1 data for a visible warning and explicit replacement', async () => {
    const migrateSavedLensRule = await loadMigration();
    const criteria = { type: 'material', materialName: 'Concrete' };
    const result = migrateSavedLensRule({ ...core, criteria });
    assert.ok(result?.unreadableLegacy);
    assert.deepEqual(result.groups, []);
    assert.deepEqual(result.unreadableLegacy.criteria, criteria);
    assert.ok(result.unreadableLegacy.reason.length > 0);
  });

  it('round-trips valid v2 groups and an unreadable warning', async () => {
    const migrateSavedLensRule = await loadMigration();
    const groups = [{ combinator: 'AND', rules: [
      { kind: 'ifcType', op: 'in', values: ['IfcDoor'] },
    ] }];
    assert.deepEqual(migrateSavedLensRule({ ...core, groups })?.groups, groups);
    const raw = { type: 'futureCondition', version: 3 };
    const result = migrateSavedLensRule({ ...core, groups: [],
      unreadableLegacy: { criteria: raw, reason: 'Unknown condition' },
    });
    assert.deepEqual(result?.unreadableLegacy, { criteria: raw, reason: 'Unknown condition' });
  });

  it('rejects malformed rules instead of admitting a broken action or group', async () => {
    const migrateSavedLensRule = await loadMigration();
    assert.equal(migrateSavedLensRule({ ...core, action: 'explode', groups: [] }), null);
    const result = migrateSavedLensRule({ ...core, groups: [{ combinator: 'AND', rules: [null] }] });
    assert.equal(result?.groups.length, 0);
    assert.ok(result?.unreadableLegacy);
  });
});
