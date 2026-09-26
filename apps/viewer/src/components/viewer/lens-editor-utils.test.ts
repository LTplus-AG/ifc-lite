/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildAutoColorLensToSave,
  duplicateLensConfig,
  isRuleValid,
  moveItem,
  reserveUniqueId,
} from './lens-editor-utils.js';
import type { Lens, LensRule } from '@/store/slices/lensSlice';
import { Rule, type FilterRule } from '@ifc-lite/rules';

const ruleLens: Lens = {
  id: 'lens-envelope', name: 'Building Envelope', builtin: true,
  rules: [
    { id: 'wall', name: 'Walls', enabled: true, action: 'colorize', color: '#111111',
      groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }] },
    { id: 'roof', name: 'Roofs', enabled: true, action: 'colorize', color: '#222222',
      groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcRoof'] }] }] },
  ],
};

describe('buildAutoColorLensToSave (#1365)', () => {
  it('preserves the existing id when editing a saved lens (so rename updates in place)', () => {
    let generated = false;
    const lens = buildAutoColorLensToSave(
      { id: 'lens-auto-123' },
      { name: 'Renamed lens', autoColor: { source: 'ifcType' } },
      () => { generated = true; return 'lens-auto-SHOULD-NOT-BE-USED'; },
    );

    assert.equal(lens.id, 'lens-auto-123', 'editing must keep the original id');
    assert.equal(generated, false, 'must not generate a new id when editing');
    assert.equal(lens.name, 'Renamed lens');
    assert.deepEqual(lens.autoColor, { source: 'ifcType' });
    assert.deepEqual(lens.rules, []);
  });

  it('mints a fresh id only when creating a new lens (no initial id)', () => {
    const lens = buildAutoColorLensToSave(
      {},
      { name: 'Color by IFC Class', autoColor: { source: 'property', psetName: 'Pset_X', propertyName: 'P' } },
      () => 'lens-auto-FRESH',
    );

    assert.equal(lens.id, 'lens-auto-FRESH');
    assert.equal(lens.name, 'Color by IFC Class');
    assert.deepEqual(lens.autoColor, { source: 'property', psetName: 'Pset_X', propertyName: 'P' });
  });
});

describe('duplicateLensConfig (#1403, #5896)', () => {
  it('copies a built-in into an editable lens with fresh rule ids', () => {
    const copy = duplicateLensConfig(ruleLens, () => 'lens-NEW');
    assert.equal(copy.id, 'lens-NEW');
    assert.equal(copy.name, 'Building Envelope (copy)');
    assert.equal(copy.builtin, undefined);
    assert.deepEqual(copy.rules.map((r) => r.id), ['lens-NEW-rule-0', 'lens-NEW-rule-1']);
  });

  it('deep-clones shared groups and preserved unreadable data (#5896)', () => {
    const source: Lens = { ...ruleLens, rules: [{ ...ruleLens.rules[0], unreadableLegacy: {
      criteria: { type: 'material', materialName: 'Concrete' }, reason: 'Unrepresentable',
    } }] };
    const copy = duplicateLensConfig(source, () => 'lens-NEW');
    const group = copy.rules[0].groups![0];
    const filter = group.rules[0];
    assert.equal(filter.kind, 'ifcType');
    if (filter.kind !== 'ifcType') return;
    filter.values.push('IfcSlab');
    (copy.rules[0].unreadableLegacy!.criteria as { materialName: string }).materialName = 'Steel';
    assert.deepEqual(source.rules[0].groups![0].rules[0], {
      kind: 'ifcType', op: 'in', values: ['IfcWall'],
    });
    assert.deepEqual(source.rules[0].unreadableLegacy!.criteria, {
      type: 'material', materialName: 'Concrete',
    });
  });

  it('carries the autoColor spec for auto-color lenses', () => {
    const auto: Lens = { id: 'lens-by-class', name: 'By IFC Class', builtin: true, rules: [], autoColor: { source: 'ifcType' } };
    const copy = duplicateLensConfig(auto, () => 'lens-NEW');
    assert.deepEqual(copy.autoColor, { source: 'ifcType' });
    assert.equal(copy.builtin, undefined);
  });
});

describe('isRuleValid — shared Lens groups (#5896)', () => {
  const rule: LensRule = { id: 'r', name: 'Walls', enabled: true,
    groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }],
    action: 'colorize', color: '#000' };

  it('saves a group-only rule and keeps unreadable legacy data', () => {
    assert.ok(isRuleValid(rule));
    assert.ok(isRuleValid({ ...rule, groups: [], unreadableLegacy: {
      criteria: { type: 'material', materialName: 'Concrete' }, reason: 'Unrepresentable',
    } }));
  });

  it('rejects empty groups', () => {
    assert.equal(isRuleValid({ ...rule, groups: [] }), false);
    assert.equal(isRuleValid({ ...rule, groups: [{ rules: [], combinator: 'AND' }] }), false);
  });

  it('rejects unfinished shared chips before Save without losing presence rules (#5896)', () => {
    const blankType = { kind: 'ifcType' as const, op: 'in' as const, values: [] };
    const walls = { kind: 'ifcType' as const, op: 'in' as const, values: ['IfcWall'] };
    const saved = (rules: FilterRule[], combinator: 'AND' | 'OR' = 'AND') =>
      isRuleValid({ ...rule, groups: [{ rules, combinator }] });
    assert.equal(saved([blankType]), false, 'an untouched Add type chip selects no IFC element');
    assert.equal(saved([{ kind: 'ifcType', op: 'in' } as unknown as FilterRule]), false,
      'a malformed imported set rule also fails closed without throwing');
    assert.equal(saved([null as unknown as FilterRule]), false, 'a malformed imported member cannot crash Save');
    assert.equal(saved([{ kind: 'futureKind' } as unknown as FilterRule]), false,
      'an unknown future rule cannot be saved as if it selected entities');
    assert.equal(saved([walls, blankType]), false, 'an incomplete AND member empties the whole selection');
    assert.equal(saved([walls, blankType], 'OR'), false, 'an empty notIn set in OR could select every entity');
    assert.equal(isRuleValid({ ...rule, groups: [
      { combinator: 'AND', rules: [walls] },
      { combinator: 'AND', rules: [{ kind: 'ifcType', op: 'notIn', values: [] }] },
    ] }), false, 'an unfinished second group must not broaden the saved Lens');
    assert.equal(isRuleValid({ ...rule, groups: [null] as unknown as LensRule['groups'] }), false,
      'a malformed imported group cannot crash Save');
    assert.equal(saved([{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }]), true);
    assert.equal(isRuleValid({ ...rule, groups: [{ combinator: 'AND', rules: [
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: '', op: 'eq', value: '' },
    ] }] }), false, 'an untouched Property chip has no property to read');
    assert.equal(isRuleValid({ ...rule, groups: [{ combinator: 'AND', rules: [
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'Reference', op: 'eq', value: '' },
    ] }] }), true, 'an explicitly empty property value remains a valid comparison');
    assert.equal(isRuleValid({ ...rule, groups: [{ combinator: 'AND', rules: [
      { kind: 'modelTag', op: 'untagged', tagIds: [] },
    ] }] }), true, 'Untagged intentionally needs no tag IDs');
  });

  it('accepts every configured shared rule kind exposed by the Lens editor (#5896)', () => {
    const configured: FilterRule[] = [
      Rule.model(['architecture.ifc']), Rule.modelTag('untagged', []), Rule.storey(['Level 1']),
      Rule.ifcType(['IfcWall']), Rule.predefinedType(['STANDARD']), Rule.name('contains', 'Wall'),
      Rule.globalId(['325Q7Fhnf67OZC$$r43uzK']), Rule.attribute('Description', 'eq', ''),
      Rule.property('Pset_WallCommon', 'Reference', 'eq', ''), Rule.quantity('Qto_WallBaseQuantities', 'Length', 'gt', 0),
      Rule.material('contains', 'Concrete'), Rule.classification('', 'isSet', ''), Rule.elevation('gt', 0),
      Rule.typeName('contains', 'WT01'), Rule.parent('contains', 'Level 1'), Rule.group('isSet', ''),
      Rule.modelFact('georef.crs', 'isSet', ''),
    ];
    for (const filter of configured) {
      assert.equal(isRuleValid({ ...rule, groups: [{ rules: [filter], combinator: 'AND' }] }), true,
        `${filter.kind} must remain saveable`);
    }
    assert.equal(isRuleValid({ ...rule, groups: [{ rules: [Rule.name('contains', '')], combinator: 'AND' }] }), false);
    assert.equal(isRuleValid({ ...rule, groups: [{ rules: [Rule.classification('', 'contains', '')], combinator: 'AND' }] }), false);
  });
});

describe('reserveUniqueId (#1403)', () => {
  it('returns the base id when free and reserves it', () => {
    const taken = new Set<string>();
    assert.equal(reserveUniqueId('lens-1', taken), 'lens-1');
    assert.ok(taken.has('lens-1'));
  });

  it('appends an incrementing suffix on collision', () => {
    const taken = new Set(['lens-1', 'lens-1-1']);
    assert.equal(reserveUniqueId('lens-1', taken), 'lens-1-2');
    assert.ok(taken.has('lens-1-2'));
  });

  it('produces distinct ids across successive calls with the same base', () => {
    const taken = new Set<string>();
    const a = reserveUniqueId('lens-x', taken);
    const b = reserveUniqueId('lens-x', taken);
    const c = reserveUniqueId('lens-x', taken);
    assert.deepEqual([a, b, c], ['lens-x', 'lens-x-1', 'lens-x-2']);
  });
});

describe('moveItem (#1403)', () => {
  it('moves an item forward', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  });
  it('moves an item backward', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
  });
  it('returns an unchanged copy for no-op / out-of-range moves', () => {
    const arr = ['a', 'b', 'c'];
    assert.deepEqual(moveItem(arr, 1, 1), arr);
    assert.deepEqual(moveItem(arr, -1, 2), arr);
    assert.deepEqual(moveItem(arr, 0, 9), arr);
    assert.notEqual(moveItem(arr, 1, 1), arr, 'returns a fresh array, not the same reference');
  });
});
