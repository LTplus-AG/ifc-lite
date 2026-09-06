/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash, ClashRevisionComparison } from '@ifc-lite/clash';
import { warningLines } from './ClashRevisionCompareDialog.js';

const emptyClash: Clash = {
  id: 'c1',
  a: { key: 'a', ref: 1, model: 'm', tag: 'IfcWall' },
  b: { key: 'b', ref: 2, model: 'm', tag: 'IfcDuct' },
  rule: 'r',
  status: 'hard',
  distance: -1,
  point: [0, 0, 0],
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  severity: 'major',
};

function comparison(overrides: Partial<ClashRevisionComparison>): ClashRevisionComparison {
  return {
    added: [],
    persistent: [],
    resolved: [],
    unretested: [],
    reasons: { skippedRuleIds: [], noMatchRuleIds: [], missingModelNames: [] },
    summary: { added: 0, persistent: 0, resolved: 0, unretested: 0 },
    ...overrides,
  };
}

describe('ClashRevisionCompareDialog.warningLines', () => {
  it('returns nothing when there is no comparison yet', () => {
    assert.deepEqual(warningLines(null), []);
  });

  it('returns nothing when nothing is unretested', () => {
    assert.deepEqual(warningLines(comparison({})), []);
  });

  it('surfaces the rule/model-level reasons verbatim', () => {
    const cmp = comparison({
      unretested: [emptyClash],
      reasons: {
        skippedRuleIds: ['rule-a'],
        noMatchRuleIds: ['rule-b'],
        missingModelNames: ['mep.ifc'],
      },
    });
    const lines = warningLines(cmp);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /rule-a/);
    assert.match(lines[1], /rule-b/);
    assert.match(lines[2], /mep\.ifc/);
  });

  /**
   * The regression this guards: `compareClashRevisions` (#3947) can reclassify
   * a clash as `unretested` purely from the per-ELEMENT `elementsReexamined`
   * check (a narrowed selector/membership list dropped just the one element a
   * clash depended on) while every rule ran with non-zero matches on both
   * sides and every model is still present — so all three `reasons` arrays
   * are empty. A `warningLines` that only reads `reasons` would silently
   * render no explanation at all for a real, correctly-classified
   * `unretested` clash — see `ClashRevisionCompareDialog`'s own comment and
   * `revision.test.ts`'s "1a" case, which is exactly this shape.
   */
  it('still explains an unretested clash when reasons is entirely empty (#3947 per-element case)', () => {
    const cmp = comparison({ unretested: [emptyClash] });
    const lines = warningLines(cmp);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /element/i);
  });
});
