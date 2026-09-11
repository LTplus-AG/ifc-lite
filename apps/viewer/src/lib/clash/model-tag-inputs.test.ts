/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Inputs changed" marker for tag-filtered clash runs (issue #4215): a
 * finished result can say whether the tag memberships it was computed on
 * have since moved — and stays quiet about tags it never referenced.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Rule } from '../search/filter-rules.js';
import {
  captureModelTagInputs,
  clashModelTagInputsChanged,
  referencedModelTagIds,
  rememberModelTagInputs,
  UNTAGGED_INPUT,
} from './model-tag-inputs.js';
import type { ClashSetFilters } from './set-filter.js';

const STRUCT = 'tag-structure';
const REVIEW = 'tag-review';

const presets: ClashSetFilters[] = [
  { filterA: { combinator: 'AND', rules: [Rule.modelTag('hasAny', [STRUCT])] }, filterB: { combinator: 'AND', rules: [Rule.ifcType(['IfcDuct'])] } },
];
const assignments = (a: string[], b: string[]) =>
  new Map<string, ReadonlySet<string>>([['A', new Set(a)], ['B', new Set(b)]]);

describe('clash model-tag inputs (#4215)', () => {
  it('references only the tag ids the filters name; a preset without tag rules captures nothing', () => {
    assert.deepEqual([...referencedModelTagIds(presets)], [STRUCT]);
    assert.equal(captureModelTagInputs([{ filterA: { combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] } }], assignments([STRUCT], [])), null);
  });

  it('a result reports changed inputs only when a REFERENCED tag moved', () => {
    const result = {};
    rememberModelTagInputs(result, captureModelTagInputs(presets, assignments([STRUCT], [REVIEW])));

    assert.equal(clashModelTagInputsChanged(result, assignments([STRUCT], [REVIEW])), false, 'nothing moved');
    assert.equal(clashModelTagInputsChanged(result, assignments([STRUCT, REVIEW], [])), false, 'only the unreferenced Review tag moved');
    assert.equal(clashModelTagInputsChanged(result, assignments([], [STRUCT])), true, 'Structure moved from A to B');
    assert.equal(clashModelTagInputsChanged(result, assignments([STRUCT], [STRUCT])), true, 'Structure gained a model');
    assert.equal(clashModelTagInputsChanged(result, new Map()), true, 'every model gone or untagged');
  });

  it('an `untagged` rule depends on which models carry any tag: tagging a previously untagged model is a change', () => {
    const untaggedPreset: ClashSetFilters[] = [{ filterA: { combinator: 'AND', rules: [Rule.modelTag('untagged', [])] } }];
    assert.deepEqual([...referencedModelTagIds(untaggedPreset)], [UNTAGGED_INPUT]);
    const result = {};
    rememberModelTagInputs(result, captureModelTagInputs(untaggedPreset, assignments([STRUCT], [])));
    assert.equal(clashModelTagInputsChanged(result, assignments([STRUCT], [])), false, 'nothing moved');
    assert.equal(clashModelTagInputsChanged(result, assignments([REVIEW], [])), false, 'A is still tagged, B still untagged: the untagged set did not move');
    assert.equal(clashModelTagInputsChanged(result, assignments([STRUCT], [REVIEW])), true, 'B was untagged and is not any more');
    assert.equal(clashModelTagInputsChanged(result, assignments([], [])), true, 'A lost its last tag');
  });

  it('a result with no recorded inputs — no tag rules, a fixture — is never stale', () => {
    const noTags = {};
    rememberModelTagInputs(noTags, null);
    assert.equal(clashModelTagInputsChanged(noTags, assignments([STRUCT], [])), false);
    assert.equal(clashModelTagInputsChanged(null, assignments([STRUCT], [])), false);
  });
});
