/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modelTag` rules in the runtime evaluator (issue #4215).
 *
 * Two real parsed models (IFC4 STEP through `IfcParser`), tagged differently,
 * evaluated through the SAME federated entry the search modal, the clash
 * resolver and the appearance scope call. The cases the issue calls out:
 *
 *  - the four ops agree on one definition (`modelTagRuleMatches`);
 *  - whole-model pruning under AND keeps boolean semantics: under OR a model
 *    failing the tag condition still contributes what the other rule admits;
 *  - a rule naming a tag that no longer exists matches NOTHING, for every op
 *    — including `hasNone`, which would otherwise be true of every model.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { evaluateFilterRules, evaluateFilterRulesFederated, type EvaluatorModel } from './filter-evaluate.js';
import { Rule, isFilterRule, parseFilterRules, type FilterRule } from './filter-rules.js';
import { modelTagRuleMatches, unresolvedModelTagIds } from '../model-tags/types.js';

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
const DEFINED = new Set([STRUCT, ARCH]);

/** m1 is tagged Structure; m2 is tagged Structure + Architecture; m3 is untagged. */
async function federation(): Promise<EvaluatorModel[]> {
  const [s1, s2, s3] = await Promise.all([parse('1'), parse('2'), parse('3')]);
  return [
    { id: 'm1', tagIds: new Set([STRUCT]), store: s1 },
    { id: 'm2', tagIds: new Set([STRUCT, ARCH]), store: s2 },
    { id: 'm3', store: s3 },
  ];
}

async function run(models: EvaluatorModel[], rules: FilterRule[], combinator: 'AND' | 'OR') {
  const out = await evaluateFilterRulesFederated(models, rules, combinator, { definedModelTagIds: DEFINED, chunkSize: 4 });
  return out.map((r) => `${r.modelId}:${r.expressId}`).sort();
}

// Every populated entity of a model: the IfcProject #1, the wall and the door.
const ALL_OF = (...ids: string[]) => ids.flatMap((m) => [`${m}:1`, `${m}:100`, `${m}:120`]).sort();

describe('modelTagRuleMatches — one definition of the four ops', () => {
  const both = new Set([STRUCT, ARCH]);
  it('hasAny / hasAll / hasNone / untagged', () => {
    assert.equal(modelTagRuleMatches('hasAny', [STRUCT, ARCH], new Set([STRUCT]), DEFINED), true);
    assert.equal(modelTagRuleMatches('hasAll', [STRUCT, ARCH], new Set([STRUCT]), DEFINED), false);
    assert.equal(modelTagRuleMatches('hasAll', [STRUCT, ARCH], both, DEFINED), true);
    assert.equal(modelTagRuleMatches('hasNone', [ARCH], new Set([STRUCT]), DEFINED), true);
    assert.equal(modelTagRuleMatches('hasNone', [ARCH], both, DEFINED), false);
    assert.equal(modelTagRuleMatches('untagged', [], undefined, DEFINED), true);
    assert.equal(modelTagRuleMatches('untagged', [], new Set(), DEFINED), true);
    assert.equal(modelTagRuleMatches('untagged', [STRUCT], both, DEFINED), false, 'untagged ignores its tag list');
  });
  it('an empty tag list on hasAny/hasAll/hasNone matches nothing (an unfinished rule is not "everything")', () => {
    assert.equal(modelTagRuleMatches('hasAny', [], both, DEFINED), false);
    assert.equal(modelTagRuleMatches('hasAll', [], both, DEFINED), false);
    assert.equal(modelTagRuleMatches('hasNone', [], undefined, DEFINED), false);
  });
  it('an unresolved id matches nothing under EVERY op — hasNone must not widen to every model', () => {
    assert.equal(modelTagRuleMatches('hasNone', [DELETED], undefined, DEFINED), false);
    assert.equal(modelTagRuleMatches('hasNone', [ARCH, DELETED], new Set([STRUCT]), DEFINED), false);
    assert.equal(modelTagRuleMatches('hasAny', [STRUCT, DELETED], new Set([STRUCT]), DEFINED), false);
    assert.equal(modelTagRuleMatches('hasAll', [STRUCT, DELETED], both, DEFINED), false);
    assert.deepEqual(unresolvedModelTagIds({ op: 'hasNone', tagIds: [ARCH, DELETED, DELETED] }, DEFINED), [DELETED]);
    assert.deepEqual(unresolvedModelTagIds({ op: 'untagged', tagIds: [DELETED] }, DEFINED), []);
  });
});

describe('evaluateFilterRulesFederated — modelTag (#4215)', () => {
  it('hasAny selects every element of every tagged model, in one and in several models', async () => {
    const models = await federation();
    assert.deepEqual(await run(models, [Rule.modelTag('hasAny', [ARCH])], 'AND'), ALL_OF('m2'));
    assert.deepEqual(await run(models, [Rule.modelTag('hasAny', [STRUCT])], 'AND'), ALL_OF('m1', 'm2'));
    assert.deepEqual(await run(models, [Rule.modelTag('hasAll', [STRUCT, ARCH])], 'AND'), ALL_OF('m2'));
    assert.deepEqual(await run(models, [Rule.modelTag('hasNone', [STRUCT])], 'AND'), ALL_OF('m3'));
    assert.deepEqual(await run(models, [Rule.modelTag('untagged', [])], 'AND'), ALL_OF('m3'));
  });

  it('AND with an element rule prunes whole models without changing the answer', async () => {
    const models = await federation();
    const out = await run(models, [Rule.modelTag('hasAny', [STRUCT]), Rule.ifcType(['IfcDoor'])], 'AND');
    assert.deepEqual(out, ['m1:120', 'm2:120']);
  });

  it('OR with an element rule keeps boolean semantics: a model failing the tag still contributes its doors', async () => {
    const models = await federation();
    const out = await run(models, [Rule.modelTag('hasAny', [ARCH]), Rule.ifcType(['IfcDoor'])], 'OR');
    assert.deepEqual(out, ['m1:120', 'm2:1', 'm2:100', 'm2:120', 'm3:120']);
  });

  it('an unresolved tag id matches nothing, never everything — under AND and under OR', async () => {
    const models = await federation();
    assert.deepEqual(await run(models, [Rule.modelTag('hasNone', [DELETED])], 'AND'), []);
    assert.deepEqual(await run(models, [Rule.modelTag('hasAny', [DELETED])], 'AND'), []);
    // OR: the broken rule contributes nothing; the door rule still does.
    assert.deepEqual(await run(models, [Rule.modelTag('hasNone', [DELETED]), Rule.ifcType(['IfcDoor'])], 'OR'), ['m1:120', 'm2:120', 'm3:120']);
  });

  it('without a defined-tag set every tag reference is unresolved (no silent "no tags means match")', async () => {
    const models = await federation();
    const out = await evaluateFilterRulesFederated(models, [Rule.modelTag('hasNone', [STRUCT])], 'AND');
    assert.deepEqual(out, []);
  });

  it('the synchronous single-model entry reads the same options', async () => {
    const store = await parse('9');
    const hit = evaluateFilterRules('solo', store, [Rule.modelTag('hasAny', [STRUCT])], 'AND',
      { modelTagIds: new Set([STRUCT]), definedModelTagIds: DEFINED });
    assert.deepEqual(hit.map((r) => r.expressId).sort((a, b) => a - b), [1, 100, 120]);
    const miss = evaluateFilterRules('solo', store, [Rule.modelTag('untagged', [])], 'AND',
      { modelTagIds: new Set([STRUCT]), definedModelTagIds: DEFINED });
    assert.deepEqual(miss, []);
  });
});

describe('modelTag rules survive the JSON boundary (saved filters, clash presets)', () => {
  it('isFilterRule accepts a well-formed rule and rejects a malformed one instead of letting it drop silently', () => {
    assert.equal(isFilterRule({ kind: 'modelTag', op: 'hasAny', tagIds: ['a'] }), true);
    assert.equal(isFilterRule({ kind: 'modelTag', op: 'untagged', tagIds: [] }), true);
    assert.equal(isFilterRule({ kind: 'modelTag', op: 'in', tagIds: ['a'] }), false, 'a SetOp is not a tag op');
    assert.equal(isFilterRule({ kind: 'modelTag', op: 'hasAny', tagIds: [1] }), false);
    assert.equal(isFilterRule({ kind: 'modelTag', op: 'hasAny' }), false);
    const parsed = parseFilterRules([{ kind: 'modelTag', op: 'hasAll', tagIds: ['a', 'b'] }, { kind: 'ifcType', op: 'in', values: ['IfcWall'] }]);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], Rule.modelTag('hasAll', ['a', 'b']));
  });
});
