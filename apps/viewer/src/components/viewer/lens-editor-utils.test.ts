/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildAutoColorLensToSave,
  cloneCriteria,
  compoundCriteriaSummary,
  deriveRuleName,
  duplicateLensConfig,
  isRuleValid,
  mergeImportedLenses,
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

/** A compound AND criteria — imported (the panel does not yet author these)
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
    copy.rules[0].criteria.ifcType = 'IfcSlab';
    assert.equal(ruleLens.rules[0].criteria.ifcType, 'IfcWall');
  });

  it('carries the autoColor spec for auto-color lenses', () => {
    const auto: Lens = { id: 'lens-by-class', name: 'By IFC Class', builtin: true, rules: [], autoColor: { source: 'ifcType' } };
    const copy = duplicateLensConfig(auto, () => 'lens-NEW');
    assert.deepEqual(copy.autoColor, { source: 'ifcType' });
    assert.equal(copy.builtin, undefined);
  });

  it('deep-clones a compound criteria: mutating the copy\'s conditions array must not affect the source', () => {
    const copy = duplicateLensConfig(compoundLens, () => 'lens-NEW');
    const copyConditions = copy.rules[0].criteria.conditions;
    assert.ok(copyConditions, 'copy must carry the compound conditions array');
    assert.equal(copyConditions!.length, 2, 'copy starts with the same two conditions as the source');

    // RED-proving mutation: push into the COPY's conditions array. A shallow
    // `{ ...criteria }` clone still aliases this array with the source, so
    // this push would leak into `compoundLens` too.
    copyConditions!.push({ type: 'ifcType', ifcType: 'IfcSlab' });

    assert.equal(
      compoundLens.rules[0].criteria.conditions!.length, 2,
      'mutating the copy\'s compound conditions array must not grow the source\'s array',
    );
    assert.notEqual(
      copyConditions, compoundLens.rules[0].criteria.conditions,
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
    const copyInner = copy.rules[0].criteria.conditions![1].conditions;
    copyInner!.push({ type: 'ifcType', ifcType: 'IfcBeam' });
    const sourceInner = nested.rules[0].criteria.conditions![1].conditions;
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
});

describe('deriveRuleName — compound naming (fka #lens-compound-conditions)', () => {
  it('names a leaf criteria the same way as before (bounding: no behavior change for leaves)', () => {
    assert.equal(deriveRuleName({ type: 'ifcType', ifcType: 'IfcWall' }), 'Wall');
    assert.equal(deriveRuleName({ type: 'attribute', attributeName: 'Name', attributeValue: 'Foo' }), 'Foo');
    assert.equal(deriveRuleName({ type: 'group', groupName: 'Zone A' }), 'Zone A');
  });

  it('resolves a model leaf\'s name via the injected resolver, falling back to "Model"', () => {
    const resolve = (id: string) => (id === 'm1' ? 'Model One' : undefined);
    assert.equal(deriveRuleName({ type: 'model', modelId: 'm1' }, resolve), 'Model One');
    assert.equal(deriveRuleName({ type: 'model', modelId: 'unknown' }, resolve), 'Model');
    assert.equal(deriveRuleName({ type: 'model' }), 'Model');
  });

  it('names a compound honestly instead of falling through to a generic "Rule" default', () => {
    assert.equal(deriveRuleName(compoundCriteria), 'AND (Wall, FireRating)');
  });

  it('recurses into a nested compound', () => {
    const nested: LensCriteria = {
      type: 'or',
      conditions: [
        { type: 'ifcType', ifcType: 'IfcSlab' },
        { type: 'and', conditions: [{ type: 'ifcType', ifcType: 'IfcBeam' }] },
      ],
    };
    assert.equal(deriveRuleName(nested), 'OR (Slab, AND (Beam))');
  });

  it('names an empty compound distinctly from an incomplete leaf', () => {
    assert.equal(deriveRuleName({ type: 'and', conditions: [] }), 'AND (empty)');
    assert.equal(deriveRuleName({ type: 'and' }), 'AND (empty)');
  });
});

describe('compoundCriteriaSummary', () => {
  it('summarizes a compound with a short count label and an expanded tooltip detail', () => {
    const summary = compoundCriteriaSummary(compoundCriteria);
    assert.equal(summary.label, 'AND — 2 conditions');
    assert.equal(summary.detail, 'Wall, FireRating');
  });

  it('singularizes the count for exactly one condition', () => {
    const summary = compoundCriteriaSummary({ type: 'or', conditions: [{ type: 'ifcType', ifcType: 'IfcWall' }] });
    assert.equal(summary.label, 'OR — 1 condition');
  });

  it('reports zero conditions distinctly (an incomplete imported compound)', () => {
    const summary = compoundCriteriaSummary({ type: 'and', conditions: [] });
    assert.equal(summary.label, 'AND — 0 conditions');
    assert.equal(summary.detail, 'No conditions');
  });
});

describe('isRuleValid — compound rules must survive Save (#lens-compound-conditions)', () => {
  it('treats a non-empty compound rule as valid', () => {
    const rule: LensRule = { id: 'r', name: 'AND', enabled: true, criteria: compoundCriteria, action: 'colorize', color: '#000' };
    assert.ok(isRuleValid(rule), 'a non-empty imported compound rule must not be dropped by the LensEditor Save filter');
  });

  it('treats an empty compound (no conditions) as invalid, like an incomplete leaf', () => {
    const rule: LensRule = { id: 'r', name: 'AND', enabled: true, criteria: { type: 'and', conditions: [] }, action: 'colorize', color: '#000' };
    assert.equal(isRuleValid(rule), false);
  });

  it('still validates leaf rules exactly as before (bounding)', () => {
    assert.ok(isRuleValid({ id: 'r1', name: 'x', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#000' }));
    assert.equal(isRuleValid({ id: 'r2', name: 'x', enabled: true, criteria: { type: 'ifcType' }, action: 'colorize', color: '#000' }), false);
    assert.ok(isRuleValid({ id: 'r3', name: 'x', enabled: true, criteria: { type: 'group' }, action: 'colorize', color: '#000' }));
  });
});

describe('mergeImportedLenses (#1403)', () => {
  const existing: Lens[] = [
    { id: 'lens-envelope', name: 'Building Envelope', builtin: true, rules: [] },
    { id: 'custom-1', name: 'My Lens', rules: [] },
  ];

  it('upserts by id: re-importing the same ids updates in place instead of doing nothing', () => {
    // Round-trip: an edited export carries the existing ids.
    const imported = [
      { id: 'lens-envelope', name: 'Building Envelope', rules: ruleLens.rules },
      { id: 'custom-1', name: 'My Lens Renamed', rules: [] },
    ];
    const next = mergeImportedLenses(existing, imported, (i) => `gen-${i}`);
    assert.equal(next.length, 2, 'no duplicates created on re-import');
    assert.equal(next[0].name, 'Building Envelope');
    assert.equal(next[0].rules.length, 2, 'builtin override picked up the edited rules');
    assert.equal(next[0].builtin, true, 'replacing a builtin preserves the builtin flag');
    assert.equal(next[1].name, 'My Lens Renamed', 'custom lens updated in place');
  });

  it('appends lenses with new ids, keeping existing order', () => {
    const next = mergeImportedLenses(existing, [{ id: 'custom-2', name: 'New', rules: [] }], (i) => `gen-${i}`);
    assert.deepEqual(next.map((l) => l.id), ['lens-envelope', 'custom-1', 'custom-2']);
    assert.equal(next[2].builtin, false, 'a brand-new imported lens is never a builtin');
  });

  it('generates ids for id-less hand-authored lenses', () => {
    const next = mergeImportedLenses(existing, [{ name: 'No Id', rules: [] }], (i) => `gen-${i}`);
    assert.equal(next.length, 3);
    assert.equal(next[2].id, 'gen-0');
  });

  it('skips malformed entries (missing name or rules) without throwing', () => {
    const next = mergeImportedLenses(
      existing,
      [null, 42, { name: '' }, { name: 'x' }, { name: 'ok', rules: [] }],
      (i) => `gen-${i}`,
    );
    assert.deepEqual(next.map((l) => l.name), ['Building Envelope', 'My Lens', 'ok']);
  });

  it('rejects lenses whose rules array is shape-invalid (e.g. [null] or partial rule)', () => {
    const next = mergeImportedLenses(
      existing,
      [
        { name: 'bad-null-rule', rules: [null] },
        { name: 'bad-partial-rule', rules: [{ id: 'r', name: 'r' /* missing enabled/criteria/action/color */ }] },
        { name: 'good', rules: ruleLens.rules },
      ],
      (i) => `gen-${i}`,
    );
    assert.deepEqual(next.map((l) => l.name), ['Building Envelope', 'My Lens', 'good']);
  });

  it('preserves a valid imported autoColor spec (and clones it)', () => {
    const spec = { source: 'material' as const };
    const next = mergeImportedLenses(existing, [{ id: 'auto-x', name: 'Auto', rules: [], autoColor: spec }], (i) => `gen-${i}`);
    assert.deepEqual(next[2].autoColor, { source: 'material' });
    assert.notEqual(next[2].autoColor, spec, 'autoColor must be cloned, not aliased');
  });

  it('rejects a lens carrying a malformed autoColor (bad shape or unknown source)', () => {
    const next = mergeImportedLenses(
      existing,
      [
        { id: 'a1', name: 'arr-autocolor', rules: [], autoColor: [] },
        { id: 'a2', name: 'bad-source', rules: [], autoColor: { source: 'not-a-source' } },
        { id: 'a3', name: 'bad-pset-type', rules: [], autoColor: { source: 'property', psetName: 7 } },
        { id: 'a4', name: 'good-autocolor', rules: [], autoColor: { source: 'ifcType' } },
      ],
      (i) => `gen-${i}`,
    );
    assert.deepEqual(next.map((l) => l.name), ['Building Envelope', 'My Lens', 'good-autocolor']);
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
