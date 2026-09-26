/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildAutoColorLensToSave,
  cloneCriteria,
  duplicateLensConfig,
  isRuleValid,
  moveItem,
  reserveUniqueId,
} from './lens-editor-utils.js';
import type { Lens, LensCriteria, LensRule } from '@/store/slices/lensSlice';

const ruleLens: Lens = {
  id: 'lens-envelope',
  name: 'Building Envelope',
  builtin: true,
  rules: [
    { id: 'wall', name: 'Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#111111' },
    { id: 'roof', name: 'Roofs', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcRoof' }, action: 'colorize', color: '#222222' },
  ],
};

/** A compound AND criteria - imported (the panel does not yet author these)
 *  but must round-trip through every clone/copy/save path intact. */
const compoundCriteria: LensCriteria = {
  type: 'and',
  conditions: [
    { type: 'ifcType', ifcType: 'IfcWall' },
    {
      type: 'property', propertySet: 'Pset_WallCommon', propertyName: 'FireRating',
      operator: 'gte', propertyValue: '60',
    },
  ],
};

const compoundLens: Lens = {
  id: 'lens-compound',
  name: 'Fire-rated walls',
  rules: [
    { id: 'rule-and', name: 'AND rule', enabled: true, criteria: compoundCriteria, action: 'colorize', color: '#333333' },
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

describe('duplicateLensConfig (#1403)', () => {
  it('makes an editable, deletable copy of a built-in (drops builtin flag, fresh id, "(copy)" name)', () => {
    const copy = duplicateLensConfig(ruleLens, () => 'lens-NEW');
    assert.equal(copy.id, 'lens-NEW');
    assert.equal(copy.name, 'Building Envelope (copy)');
    assert.equal(copy.builtin, undefined, 'copy must not be a builtin');
    assert.equal(copy.rules.length, 2);
  });

  it('regenerates rule ids and clones criteria so editing the copy never mutates the source', () => {
    const copy = duplicateLensConfig(ruleLens, () => 'lens-NEW');
    assert.deepEqual(copy.rules.map((r) => r.id), ['lens-NEW-rule-0', 'lens-NEW-rule-1']);
    // Mutating the copy's first criteria must not affect the source.
    const copiedCriteria = copy.rules[0].criteria;
    assert.ok(copiedCriteria);
    copiedCriteria.ifcType = 'IfcSlab';
    assert.equal(ruleLens.rules[0].criteria?.ifcType, 'IfcWall');
  });

  it('carries the autoColor spec for auto-color lenses', () => {
    const auto: Lens = { id: 'lens-by-class', name: 'By IFC Class', builtin: true, rules: [], autoColor: { source: 'ifcType' } };
    const copy = duplicateLensConfig(auto, () => 'lens-NEW');
    assert.deepEqual(copy.autoColor, { source: 'ifcType' });
    assert.equal(copy.builtin, undefined);
  });

  it('deep-clones a compound criteria: mutating the copy\'s conditions array must not affect the source', () => {
    const copy = duplicateLensConfig(compoundLens, () => 'lens-NEW');
    const copyConditions = copy.rules[0].criteria?.conditions;
    assert.ok(copyConditions, 'copy must carry the compound conditions array');
    assert.equal(copyConditions!.length, 2, 'copy starts with the same two conditions as the source');

    // RED-proving mutation: push into the COPY's conditions array. A shallow
    // `{ ...criteria }` clone still aliases this array with the source, so
    // this push would leak into `compoundLens` too.
    copyConditions!.push({ type: 'ifcType', ifcType: 'IfcSlab' });

    assert.equal(
      compoundLens.rules[0].criteria?.conditions?.length, 2,
      'mutating the copy\'s compound conditions array must not grow the source\'s array',
    );
    assert.notEqual(
      copyConditions, compoundLens.rules[0].criteria?.conditions,
      'copy and source must hold genuinely distinct conditions array references',
    );
  });

  it('deep-clones a NESTED compound (and-of-or) so the inner conditions array is independent too', () => {
    const nested: Lens = {
      id: 'lens-nested',
      name: 'Nested',
      rules: [{
        id: 'rule-nested',
        name: 'Nested rule',
        enabled: true,
        criteria: {
          type: 'and',
          conditions: [
            { type: 'ifcType', ifcType: 'IfcWall' },
            { type: 'or', conditions: [{ type: 'ifcType', ifcType: 'IfcSlab' }] },
          ],
        },
        action: 'colorize',
        color: '#444444',
      }],
    };
    const copy = duplicateLensConfig(nested, () => 'lens-NEW');
    const copyInner = copy.rules[0].criteria?.conditions?.[1].conditions;
    copyInner!.push({ type: 'ifcType', ifcType: 'IfcBeam' });
    const sourceInner = nested.rules[0].criteria?.conditions?.[1].conditions;
    assert.equal(sourceInner!.length, 1, 'a push into a nested inner conditions array must not reach the source');
  });
});

describe('cloneCriteria', () => {
  it('shallow-clones a leaf criteria (no conditions array to worry about)', () => {
    const leaf: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall' };
    const cloned = cloneCriteria(leaf);
    assert.deepEqual(cloned, leaf);
    assert.notEqual(cloned, leaf, 'must return a fresh object, not the same reference');
  });

  it('deep-clones a compound so the conditions array is a distinct reference', () => {
    const cloned = cloneCriteria(compoundCriteria);
    assert.deepEqual(cloned, compoundCriteria);
    assert.notEqual(cloned.conditions, compoundCriteria.conditions);
    assert.notEqual(cloned.conditions![0], compoundCriteria.conditions![0]);
  });

  it('treats a compound with an empty conditions array as its own fresh empty array', () => {
    const empty: LensCriteria = { type: 'or', conditions: [] };
    const cloned = cloneCriteria(empty);
    assert.deepEqual(cloned.conditions, []);
    assert.notEqual(cloned.conditions, empty.conditions);
  });

  it('does not throw on a null/primitive compound member - leaves it as-is instead of recursing into it', () => {
    const withBadMember: LensCriteria = {
      type: 'and',
      conditions: [null as unknown as LensCriteria, 42 as unknown as LensCriteria, { type: 'ifcType', ifcType: 'IfcWall' }],
    };
    const cloned = cloneCriteria(withBadMember);
    assert.equal(cloned.conditions![0], null);
    assert.equal(cloned.conditions![1], 42);
    assert.deepEqual(cloned.conditions![2], { type: 'ifcType', ifcType: 'IfcWall' });
    assert.notEqual(cloned.conditions![2], withBadMember.conditions![2], 'the well-formed member must still be a fresh clone');
  });

  it('leaves an array compound member as-is instead of silently rewriting it into an object (review find)', () => {
    // Hand-edited lens JSON can put an array where a member criteria is
    // expected. `isCriteriaLike` used to accept arrays (`typeof [] ===
    // 'object'`), so this recursed into the array and `{ ...arrayMember }`
    // turned `[{"type":"ifcType", ...}]` into `{"0": {"type":"ifcType", ...}}`
    // on the next Edit/Duplicate round-trip - a silent shape mutation of
    // user data. An array must be treated the same as any other
    // not-criteria-like value: left untouched.
    const withArrayMember: LensCriteria = {
      type: 'and',
      conditions: [[{ type: 'ifcType', ifcType: 'IfcWall' }] as unknown as LensCriteria],
    };
    const cloned = cloneCriteria(withArrayMember);
    assert.ok(Array.isArray(cloned.conditions![0]), 'array member must stay an array, not become {"0": ...}');
    assert.equal(cloned.conditions![0], withArrayMember.conditions![0]);
  });

  it('does not stack-overflow on a pathologically deep compound (RED against the PR before the depth cap)', () => {
    // Build a chain far deeper than MAX_COMPOUND_DEPTH (16) - a hand-edited
    // lens JSON is not depth-limited on import, so Edit/Duplicate must survive it.
    let deep: LensCriteria = { type: 'ifcType', ifcType: 'IfcWall' };
    for (let i = 0; i < 3000; i++) {
      deep = { type: 'and', conditions: [deep] };
    }
    assert.doesNotThrow(() => cloneCriteria(deep));
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

  it('rejects empty groups even when a stale v1 criterion looks valid', () => {
    assert.equal(isRuleValid({ ...rule, groups: [] }), false);
    assert.equal(isRuleValid({ ...rule, groups: [{ rules: [], combinator: 'AND' }] }), false);
    assert.equal(isRuleValid({ ...rule, groups: [], criteria: { type: 'ifcType', ifcType: 'IfcWall' } }), false);
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
