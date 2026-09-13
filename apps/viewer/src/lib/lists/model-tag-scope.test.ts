/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A list's model tag scope (issue #4215) resolves with the SAME predicate
 * search and clash use — asserted by evaluating the identical rule through
 * the search evaluator's model-level arm — refuses an unresolved tag, and
 * refuses (with a reason) a scope that selects no loaded model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { modelScopedRuleMatches } from '../search/filter-evaluate-model-tag.js';
import { Rule } from '../search/filter-rules.js';
import type { ModelTag, ModelTagOp } from '../model-tags/types.js';
import { describeListModelTagScope, resolveListModelTagScope, scopeModelPairs, type ListModelTagState } from './model-tag-scope.js';

const S: ModelTag = { id: 'tag-s', name: 'Structure' };
const A: ModelTag = { id: 'tag-a', name: 'Architecture' };

/** m1 Structure + Architecture, m2 Structure, m3 untagged. */
const state: ListModelTagState = {
  models: new Map([['m1', {}], ['m2', {}], ['m3', {}]]),
  modelTags: new Map([[S.id, S], [A.id, A]]),
  modelTagAssignments: new Map([['m1', new Set([S.id, A.id])], ['m2', new Set([S.id])]]),
};
const pairs = [{ modelId: 'm1' }, { modelId: 'm2' }, { modelId: 'm3' }];

const ids = (r: ReturnType<typeof resolveListModelTagScope>) => (r.kind === 'models' ? [...r.modelIds] : r.kind);

describe('list model tag scope (#4215)', () => {
  it('no scope → every model', () => {
    assert.deepEqual(resolveListModelTagScope(undefined, state), { kind: 'all' });
    assert.deepEqual(scopeModelPairs({}, pairs, state), pairs);
  });

  it('the four operators select the same models the search / clash evaluator would', () => {
    const cases: Array<[ModelTagOp, string[], string[]]> = [
      ['hasAny', [S.id], ['m1', 'm2']],
      ['hasAny', [A.id], ['m1']],
      ['hasAll', [S.id, A.id], ['m1']],
      ['hasNone', [S.id], ['m3']],
      ['untagged', [], ['m3']],
    ];
    const defined = new Set(state.modelTags.keys());
    for (const [op, tagIds, expected] of cases) {
      assert.deepEqual(ids(resolveListModelTagScope({ op, tagIds }, state)), expected, `${op} ${tagIds}`);
      const viaSearch = [...state.models.keys()].filter((id) =>
        modelScopedRuleMatches(Rule.modelTag(op, tagIds), {
          filterIdentity: id, tagIds: state.modelTagAssignments.get(id), definedModelTagIds: defined,
        }));
      assert.deepEqual(viaSearch, expected, `search agrees for ${op}`);
    }
  });

  it('an unresolved tag id refuses the run with a named reason — never widens to every model', () => {
    const resolved = resolveListModelTagScope({ op: 'hasNone', tagIds: ['tag-gone'] }, state);
    assert.deepEqual(resolved, { kind: 'unresolved', tagIds: ['tag-gone'] });
    assert.throws(
      () => scopeModelPairs({ modelTagScope: { op: 'hasNone', tagIds: ['tag-gone'] } }, pairs, state),
      /no longer exists.*not run/s,
    );
  });

  it('a scope that selects no loaded model refuses with the scope spelled out', () => {
    const empty = new Map([['m3', {}]]);
    assert.throws(
      () => scopeModelPairs({ modelTagScope: { op: 'hasAny', tagIds: [A.id] } }, [{ modelId: 'm3' }], { ...state, models: empty }),
      /No loaded model matches.*models that have any of Architecture.*Nothing was run/s,
    );
    assert.equal(describeListModelTagScope({ op: 'hasAll', tagIds: [S.id, A.id] }, state.modelTags), 'models that have all of Structure, Architecture');
    assert.equal(describeListModelTagScope({ op: 'untagged', tagIds: [] }, state.modelTags), 'untagged models');
  });

  it('a scoped run keeps only the providers of models in scope, in federation order', () => {
    assert.deepEqual(scopeModelPairs({ modelTagScope: { op: 'hasAny', tagIds: [S.id] } }, pairs, state), [{ modelId: 'm1' }, { modelId: 'm2' }]);
  });
});
