/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Rule, type ModelTag, type RuleSetFile } from '@ifc-lite/rules';
import { collectRuleTagIds, remapRuleTags } from './rule-tag-bindings';

function fixture(): RuleSetFile {
  return { version: 1, name: 'Coordination', targets: { modelTagIds: ['old-structure'], modelFingerprints: ['old-structure'] }, rules: [
    { id: 'element', name: 'Check',
      applicability: { authoredAs: 'chips', groups: [
        { combinator: 'OR', rules: [Rule.modelTag('hasAny', ['old-structure']), Rule.model(['old-services'])] },
        { combinator: 'AND', rules: [Rule.modelTag('hasNone', ['old-services'])] },
      ] },
      requirement: { kind: 'element', block: { authoredAs: 'chips', groups: [
        { combinator: 'AND', rules: [Rule.modelTag('hasAll', ['old-structure', 'old-services']), Rule.property('Pset_WallCommon', 'tagIds', 'eq', 'old-structure')] },
      ] } },
    },
    { id: 'aggregate', name: 'Count per group',
      applicability: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] }] },
      requirement: { kind: 'aggregate', fn: 'count', op: 'gte', value: 1, groupBy: {
        subject: { kind: 'parent' }, universe: { authoredAs: 'chips', groups: [{ combinator: 'OR', rules: [Rule.modelTag('hasAny', ['old-universe'])] }] },
      } },
    },
  ] };
}
const vocabulary: ReadonlyMap<string, ModelTag> = new Map([
  ['fresh-structure', { id: 'fresh-structure', name: 'Structure' }],
  ['fresh-services', { id: 'fresh-services', name: 'Services' }],
  ['fresh-universe', { id: 'fresh-universe', name: 'Building A' }],
]);
const bindings = { 'old-structure': ' STRUCTURE ', 'old-services': 'services', 'old-universe': 'Building A' };

describe('portable rule tag bindings (#6612)', () => {
  it('collects targets, multiple groups, requirements and aggregate universes in source order', () => {
    assert.deepEqual(collectRuleTagIds(fixture()), ['old-structure', 'old-services', 'old-universe']);
  });

  it('maps a fresh-browser vocabulary without rewriting fingerprints, IFC names or source definitions', () => {
    const source = fixture();
    const original = structuredClone(source);
    const result = remapRuleTags(source, bindings, vocabulary);
    assert.deepEqual(collectRuleTagIds(result), ['fresh-structure', 'fresh-services', 'fresh-universe']);
    assert.deepEqual(source, original);
    assert.deepEqual(result.targets?.modelFingerprints, ['old-structure']);
    assert.deepEqual(result.rules[0].applicability.groups[0].rules[1], Rule.model(['old-services']));
    assert.equal(result.rules[0].requirement.kind, 'element');
    if (result.rules[0].requirement.kind === 'element') {
      assert.deepEqual(result.rules[0].requirement.block.groups[0].rules[1], Rule.property('Pset_WallCommon', 'tagIds', 'eq', 'old-structure'));
    }
  });

  it('preserves known local identities and is idempotent for an already remapped definition', () => {
    const mapped = remapRuleTags(fixture(), bindings, vocabulary);
    assert.deepEqual(remapRuleTags(mapped, {}, vocabulary), mapped);
  });

  it('refuses unmapped negative predicates, missing names, empty names and ambiguous names', () => {
    assert.throws(() => remapRuleTags(fixture(), { 'old-structure': 'Structure' }, vocabulary), /old-services.*requires/);
    assert.throws(() => remapRuleTags(fixture(), { ...bindings, 'old-services': 'Unknown' }, vocabulary), /does not exist/);
    assert.throws(() => remapRuleTags(fixture(), { ...bindings, 'old-services': ' ' }, vocabulary), /does not exist/);
    const ambiguous = new Map(vocabulary);
    ambiguous.set('other', { id: 'other', name: ' structure ' });
    assert.throws(() => remapRuleTags(fixture(), bindings, ambiguous), /ambiguous/);
  });

  it('requires own mapping entries, protecting imported IDs that equal Object prototype names', () => {
    const source = fixture();
    source.targets = { modelTagIds: ['constructor'] };
    assert.throws(() => remapRuleTags(source, bindings, vocabulary), /constructor.*requires/);
  });
});
