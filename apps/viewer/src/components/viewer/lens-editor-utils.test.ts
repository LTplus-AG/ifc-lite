/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Lens, LensRule } from '@ifc-lite/lens';
import {
  buildAutoColorLensToSave, duplicateLensConfig, isRuleValid,
  mergeImportedLenses, moveItem, reserveUniqueId,
} from './lens-editor-utils.js';

const rule: LensRule = {
  id: 'wall', name: 'Walls', enabled: true,
  groups: [{ combinator: 'AND', rules: [
    { kind: 'ifcType', op: 'in', values: ['IfcWall'] },
    { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'gte', value: '60' },
  ] }],
  action: 'colorize', color: '#111111',
};
const builtin: Lens = {
  id: 'lens-envelope', name: 'Building Envelope', builtin: true, rules: [rule],
};

function importLenses(existing: readonly Lens[], raw: unknown[]): Lens[] {
  return mergeImportedLenses(existing, raw, (i) => `generated-${i}`);
}

describe('Lens editor persistence and copy (#5896)', () => {
  it('preserves an auto-color lens id on edit and creates one only for a new lens', () => {
    assert.equal(buildAutoColorLensToSave(
      { id: 'existing' }, { name: 'Renamed', autoColor: { source: 'ifcType' } },
      () => { throw new Error('must not allocate a new id'); },
    ).id, 'existing');
    assert.equal(buildAutoColorLensToSave(
      {}, { name: 'New', autoColor: { source: 'property', psetName: 'Pset_X', propertyName: 'P' } },
      () => 'new-id',
    ).id, 'new-id');
  });

  it('copies nested FilterGroups and makes a built-in editable without sharing chips', () => {
    const copy = duplicateLensConfig(builtin, () => 'copy');
    assert.equal(copy.builtin, undefined);
    assert.equal(copy.id, 'copy');
    assert.equal(copy.rules[0].id, 'copy-rule-0');
    const copiedRule = copy.rules[0].groups[0].rules[0];
    assert.equal(copiedRule.kind, 'ifcType');
    if (copiedRule.kind !== 'ifcType') return;
    copiedRule.values.push('IfcSlab');
    const sourceRule = builtin.rules[0].groups[0].rules[0];
    assert.equal(sourceRule.kind, 'ifcType');
    if (sourceRule.kind !== 'ifcType') return;
    assert.deepEqual(sourceRule.values, ['IfcWall']);
  });

  it('upserts exports by id and preserves a built-in flag on re-import', () => {
    const imported = [{ id: builtin.id, name: 'Revised', rules: [rule] }];
    const next = importLenses([builtin], imported);
    assert.equal(next.length, 1);
    assert.equal(next[0].name, 'Revised');
    assert.equal(next[0].builtin, true);
    assert.deepEqual(next[0].rules[0].groups, rule.groups);
  });

  it('legacy import → export → import keeps normalized groups and rule order', () => {
    const legacy = [{ id: 'old', name: 'Old lens', rules: [
      { id: 'r1', name: 'Wall or door', enabled: true, action: 'colorize', color: '#ff0000',
        criteria: { type: 'or', conditions: [
          { type: 'ifcType', ifcType: 'IfcWall' }, { type: 'ifcType', ifcType: 'IfcDoor' },
        ] } },
    ] }];
    const first = importLenses([], legacy);
    assert.equal(first.length, 1);
    assert.equal(first[0].rules[0].groups.length, 2);
    const exported = JSON.parse(JSON.stringify(first));
    const second = importLenses([], exported);
    assert.deepEqual(second, first);
    assert.equal(second[0].rules[0].unreadableLegacy, undefined);
  });

  it('unrepresentable v1 criteria warn and round-trip until explicitly replaced', () => {
    const criteria = { type: 'material', materialName: 'Concrete' };
    const legacy = [{ id: 'old', name: 'Old lens', rules: [
      { id: 'r1', name: 'Material', enabled: true, action: 'colorize', color: '#ff0000', criteria },
    ] }];
    const first = importLenses([], legacy);
    const saved = first[0].rules[0];
    assert.deepEqual(saved.groups, []);
    assert.deepEqual(saved.unreadableLegacy?.criteria, criteria);
    assert.ok(saved.unreadableLegacy?.reason);
    assert.equal(isRuleValid(saved), true, 'editing the lens must not drop an unreadable rule');
    const second = importLenses([], JSON.parse(JSON.stringify(first)));
    assert.deepEqual(second, first);
  });

  it('refuses malformed imported groups instead of silently accepting a changed query', () => {
    const malformed = [{ id: 'bad', name: 'Bad', rules: [{
      ...rule, groups: [{ combinator: 'UNKNOWN', rules: rule.groups[0].rules }],
    }] }];
    const next = importLenses([], malformed);
    assert.equal(next.length, 1);
    assert.equal(next[0].rules[0].groups.length, 0);
    assert.ok(next[0].rules[0].unreadableLegacy);
  });

  it('keeps an entered group but omits an empty editor draft on save', () => {
    assert.equal(isRuleValid(rule), true);
    assert.equal(isRuleValid({ ...rule, groups: [{ combinator: 'AND', rules: [] }] }), false);
  });

  it('reserves collision-free ids and preserves rule priority on reorder', () => {
    const taken = new Set(['lens', 'lens-1']);
    assert.equal(reserveUniqueId('lens', taken), 'lens-2');
    assert.deepEqual(moveItem(['first', 'second', 'third'], 2, 0), ['third', 'first', 'second']);
  });
});
