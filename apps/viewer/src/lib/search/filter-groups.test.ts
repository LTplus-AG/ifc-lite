/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `groupsToSelectorText` / `parseFilterGroups` regressions from PR #4987
 * review (#4904): the selector-text echo must never claim a query
 * different from what evaluation actually runs, and a persisted group
 * with a corrupt combinator must refuse rather than silently default.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Rule } from './filter-rules.js';
import { groupsToSelectorText, parseFilterGroups } from './filter-groups.js';

describe('groupsToSelectorText — all-or-nothing echo (review)', () => {
  it('renders a clean union of single-rule groups', () => {
    const text = groupsToSelectorText([
      { rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' },
      { rules: [Rule.ifcType(['IfcDoor'])], combinator: 'AND' },
    ]);
    assert.equal(text, 'IfcWall + IfcDoor');
  });

  it('an empty group is skipped — no dangling "+" — since it contributes nothing to the union (matches evaluator semantics: `evaluateFilterGroups` also skips it)', () => {
    const text = groupsToSelectorText([
      { rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' },
      { rules: [], combinator: 'AND' },
    ]);
    assert.equal(text, 'IfcWall');
  });

  it('a group with two AND-combined class rules produces NO echo — comma would read as a union, not an AND', () => {
    const text = groupsToSelectorText([
      { rules: [Rule.ifcType(['IfcWall']), Rule.globalId(['325Q7Fhnf67OZC$$r43uzK'])], combinator: 'AND' },
    ]);
    assert.equal(text, '');
  });

  it('a group with a non-renderable rule (e.g. a property rule) produces NO echo, never a partial one', () => {
    const text = groupsToSelectorText([
      { rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' },
      { rules: [Rule.property('Pset_WallCommon', 'FireRating', 'eq', '2HR')], combinator: 'AND' },
    ]);
    assert.equal(text, '');
  });
});

describe('parseFilterGroups — refuses a corrupt combinator (review)', () => {
  it('accepts AND / OR', () => {
    const groups = parseFilterGroups([
      { rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' },
    ]);
    assert.ok(groups);
    assert.equal(groups?.[0].combinator, 'AND');
  });

  it('refuses (returns null) a missing combinator rather than defaulting to AND', () => {
    const groups = parseFilterGroups([
      { rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }] },
    ]);
    assert.equal(groups, null);
  });

  it('refuses (returns null) a garbled combinator value', () => {
    const groups = parseFilterGroups([
      { rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'XOR' },
    ]);
    assert.equal(groups, null);
  });
});
