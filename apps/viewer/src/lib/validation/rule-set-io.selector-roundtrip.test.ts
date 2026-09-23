/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `rule-set-io` applicability groups round-trip through the viewer's
 * selector-text mini-language (#5138). Split out of
 * `@ifc-lite/rules`'s `rule-set.test.ts` (PR 7a) because `readSelector`
 * (`lib/search/selector-to-rules.ts`) is viewer-only — it was never in the
 * PR 7a move list — while `groupsToSelectorText`/`Rule` are package exports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Rule, groupsToSelectorText } from '@ifc-lite/rules';
import { readSelector } from '@/lib/search/selector-to-rules.js';

describe('rule-set-io — applicability groups round-trip through the selector (#5138)', () => {
  // `groupsToSelectorText`/`readSelector` only spell single-rule groups of
  // `ifcType`/`globalId` (`filter-groups.ts`'s `ruleToSelectorClause`) — every
  // other allowed applicability kind (model, modelTag, storey, name,
  // attribute, property, quantity, material, classification, type, parent,
  // predefinedType) has no selector-text spelling and echoes as `''`
  // (`groupsToSelectorText`'s all-or-nothing rule), so only the two kinds
  // below round-trip through text. `exactClass` is exactly one of the kinds
  // the selector cannot spell: it is silently dropped by `ruleToSelectorClause`.
  it('an ifcType group round-trips through groupsToSelectorText -> readSelector, but loses exactClass', () => {
    const groups = [{ combinator: 'AND' as const, rules: [{ ...Rule.ifcType(['IfcWall'], 'in'), exactClass: true }] }];
    const text = groupsToSelectorText(groups);
    assert.equal(text, 'IfcWall');
    const reading = readSelector(text);
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    const rule = reading.groups[0]?.rules[0];
    assert.equal(rule?.kind, 'ifcType');
    assert.equal((rule as { exactClass?: boolean }).exactClass, undefined);
  });

  it('a globalId group round-trips through groupsToSelectorText -> readSelector', () => {
    const groups = [{ combinator: 'AND' as const, rules: [Rule.globalId(['325Q7Fhnf67OZC$$r43uzK'], 'in')] }];
    const text = groupsToSelectorText(groups);
    assert.equal(text, '325Q7Fhnf67OZC$$r43uzK');
    const reading = readSelector(text);
    assert.equal(reading.ok, true);
    if (!reading.ok) return;
    assert.deepEqual(reading.groups[0]?.rules[0], Rule.globalId(['325Q7Fhnf67OZC$$r43uzK'], 'in'));
  });
});
