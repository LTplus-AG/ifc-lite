/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash set filters with `modelTag` rules (issue #4215).
 *
 *  - A/B membership is resolved by the SAME evaluator search uses, so for one
 *    rule the two agree element for element;
 *  - a rule naming a tag that no longer exists REFUSES the run with a named
 *    error, rather than resolving that side to nothing (or, worse, to
 *    everything);
 *  - membership is a snapshot of the state the model list was built from:
 *    re-tagging afterwards — the store swapping in a new assignments map —
 *    does not move an element between the sets.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { clashMemberKey, type ClashRule } from '@ifc-lite/clash';
import { evaluateFilterRulesFederated } from '../search/filter-evaluate.js';
import { Rule } from '../search/filter-rules.js';
import { evaluatorModelsFromState, definedModelTagIdsOf, type ModelTagState } from '../model-tags/evaluator-models.js';
import { resolveClashSetFilter, withResolvedClashSetFilters } from './set-filter-resolve.js';
import type { ClashSetFilter } from './set-filter.js';

const fixture = (suffix: string) => `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj000000000000000${suffix}',$,'P',$,$,$,$,$,$);
#100=IFCWALL('Wall00000000000000${suffix}A',$,'Wall-${suffix}',$,$,$,$,$,.SOLIDWALL.);
#120=IFCDOOR('Door00000000000000${suffix}C',$,'Door-${suffix}',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(suffix: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(fixture(suffix));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true }) as unknown as Promise<IfcDataStore>;
}

const STRUCT = 'tag-structure';
const ARCH = 'tag-architecture';
const DELETED = 'tag-deleted';

/** A store-shaped snapshot: m1 Structure, m2 Architecture, m3 untagged. */
async function state(): Promise<ModelTagState> {
  const [s1, s2, s3] = await Promise.all([parse('1'), parse('2'), parse('3')]);
  return {
    models: new Map([
      ['m1', { id: 'm1', sourceFingerprint: 'fp-1', ifcDataStore: s1 }],
      ['m2', { id: 'm2', sourceFingerprint: 'fp-2', ifcDataStore: s2 }],
      ['m3', { id: 'm3', sourceFingerprint: 'fp-3', ifcDataStore: s3 }],
    ]),
    modelTags: new Map([[STRUCT, { id: STRUCT, name: 'Structure' }], [ARCH, { id: ARCH, name: 'Architecture' }]]),
    modelTagAssignments: new Map([['m1', new Set([STRUCT])], ['m2', new Set([ARCH])]]),
  };
}

// The viewer's real mapping offsets by model; any injective function does here.
const OFFSET: Record<string, number> = { m1: 0, m2: 1000, m3: 2000 };
const toGlobalId = (modelId: string, expressId: number) => OFFSET[modelId] + expressId;

describe('clash set filters with modelTag rules (#4215)', () => {
  it('A/B membership agrees with the search evaluator for the same rule', async () => {
    const s = await state();
    const models = evaluatorModelsFromState(s);
    const filter: ClashSetFilter = { combinator: 'AND', rules: [Rule.modelTag('hasAny', [STRUCT, ARCH])] };
    const clash = await resolveClashSetFilter(models, filter, toGlobalId, { definedModelTagIds: definedModelTagIdsOf(s) });
    const search = await evaluateFilterRulesFederated(models, filter.rules, filter.combinator, { definedModelTagIds: definedModelTagIdsOf(s) });
    assert.deepEqual(
      [...clash].sort(),
      search.map((m) => clashMemberKey(m.modelId, toGlobalId(m.modelId, m.expressId))).sort(),
    );
    assert.deepEqual(new Set(search.map((m) => m.modelId)), new Set(['m1', 'm2']), 'the tagged models, and only those');
    assert.equal(clash.length, 6, 'every entity of m1 and m2 (IfcProject, wall, door)');
  });

  it('untagged and hasNone pick out the models the positive ops leave', async () => {
    const s = await state();
    const models = evaluatorModelsFromState(s);
    const opts = { definedModelTagIds: definedModelTagIdsOf(s) };
    const untagged = await resolveClashSetFilter(models, { combinator: 'AND', rules: [Rule.modelTag('untagged', [])] }, toGlobalId, opts);
    assert.deepEqual([...untagged].sort(), [clashMemberKey('m3', 2001), clashMemberKey('m3', 2100), clashMemberKey('m3', 2120)].sort());
    const notStruct = await resolveClashSetFilter(models, { combinator: 'AND', rules: [Rule.modelTag('hasNone', [STRUCT])] }, toGlobalId, opts);
    assert.deepEqual(
      [...notStruct].sort(),
      ['m2', 'm3'].flatMap((m) => [1, 100, 120].map((e) => clashMemberKey(m, OFFSET[m] + e))).sort(),
      'm2 and m3, three entities each, and nothing of m1',
    );
  });

  it('REFUSES a filter naming a deleted tag with a named error, instead of resolving that side to nothing', async () => {
    const s = await state();
    const models = evaluatorModelsFromState(s);
    const filter: ClashSetFilter = { combinator: 'AND', rules: [Rule.modelTag('hasNone', [DELETED])] };
    await assert.rejects(
      resolveClashSetFilter(models, filter, toGlobalId, { definedModelTagIds: definedModelTagIdsOf(s) }),
      /model tag that no longer exists/,
    );
    // Through the preset path too: the rule set is rejected as a whole, so a
    // broken A side cannot quietly run against a resolved B side.
    const rule: ClashRule = { id: 'p1', name: 'Struct vs deleted', selectorA: '!*', selectorB: '!*', severity: 'high' } as unknown as ClashRule;
    await assert.rejects(
      withResolvedClashSetFilters([rule], [{ id: 'p1', filterA: filter, filterB: { combinator: 'AND', rules: [Rule.modelTag('hasAny', [STRUCT])] } }], models, toGlobalId,
        { definedModelTagIds: definedModelTagIdsOf(s) }),
      /model tag/,
    );
  });

  it('without a defined-tag set every tag reference is refused, never treated as "no tags exist so nothing to check"', async () => {
    const s = await state();
    await assert.rejects(
      resolveClashSetFilter(evaluatorModelsFromState(s), { combinator: 'AND', rules: [Rule.modelTag('hasAny', [STRUCT])] }, toGlobalId),
      /model tag/,
    );
  });

  it('membership is a snapshot: re-tagging after the model list was built does not move elements between sets', async () => {
    const s = await state();
    const models = evaluatorModelsFromState(s);            // what runPresets captures
    // The slice never mutates a Set in place — it swaps in a new map — so this
    // is exactly what a re-tag during the run looks like to the store.
    const retagged: ModelTagState = { ...s, modelTagAssignments: new Map([['m1', new Set([ARCH])], ['m2', new Set([STRUCT])]]) };
    assert.notDeepEqual(evaluatorModelsFromState(retagged).map((m) => [...(m.tagIds ?? [])]), models.map((m) => [...(m.tagIds ?? [])]));

    const opts = { definedModelTagIds: definedModelTagIdsOf(retagged) };
    const sideA = await resolveClashSetFilter(models, { combinator: 'AND', rules: [Rule.modelTag('hasAny', [STRUCT])] }, toGlobalId, opts);
    assert.deepEqual([...sideA].sort(), [clashMemberKey('m1', 1), clashMemberKey('m1', 100), clashMemberKey('m1', 120)].sort(), 'still m1 — the set the run started with');
  });
});
