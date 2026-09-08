/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ClashPanel sections for a duplicate scan (#2530 review blocker).
 *
 * The review's failure scenario: three coincident columns produced three
 * pairwise rows with every column named twice, because `groupDuplicateSets`
 * was written into store state no component read while the panel bucketed
 * `result.clashes` itself. These tests run the REAL detector + grouping over
 * three coincident elements and pin that the section builder the panel now
 * renders from turns them into ONE "3 coincident ..." section — and that it
 * degrades to `null` (the generic sections) rather than mislabeling anything
 * it cannot vouch for.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicates,
  groupClashes,
  groupDuplicateSets,
  type ClashElement,
  type ClashResult,
} from '@ifc-lite/clash';
import { duplicateSetSections } from './duplicate-set-sections.js';

let nextRef = 1;

/** A degenerate-geometry element at `min`..`max` — enough for the AABB pass. */
function element(key: string, min: [number, number, number], max: [number, number, number]): ClashElement {
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag: 'IfcColumn',
    bounds: { min: [...min], max: [...max] },
    positions: new Float32Array(0),
    indices: new Uint32Array(6),
  };
}

function tripletResult(): ClashResult {
  return findDuplicates([
    element('a', [0, 0, 0], [1, 1, 1]),
    element('b', [0, 0, 0], [1, 1, 1]),
    element('c', [0, 0, 0], [1, 1, 1]),
  ]);
}

describe('duplicateSetSections', () => {
  it('renders three coincident copies as ONE section holding the three pair rows', () => {
    const result = tripletResult();
    assert.equal(result.clashes.length, 3, 'pairwise result: 3 rows for 3 copies');
    const sections = duplicateSetSections(result, groupDuplicateSets(result), result.clashes);
    assert.ok(sections, 'a duplicates run must produce set sections');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].label, '3 coincident IfcColumn objects');
    assert.equal(sections[0].items.length, 3);
  });

  it('keeps two unrelated duplicate pairs as TWO sections', () => {
    const result = findDuplicates([
      element('a', [0, 0, 0], [1, 1, 1]),
      element('b', [0, 0, 0], [1, 1, 1]),
      element('c', [5, 0, 0], [6, 1, 1]),
      element('d', [5, 0, 0], [6, 1, 1]),
    ]);
    const sections = duplicateSetSections(result, groupDuplicateSets(result), result.clashes);
    assert.ok(sections);
    assert.equal(sections.length, 2);
    for (const s of sections) assert.equal(s.items.length, 1);
  });

  it('respects the caller\'s visible-clash filter and drops emptied sets', () => {
    const result = tripletResult();
    const visible = result.clashes.slice(0, 1);
    const sections = duplicateSetSections(result, groupDuplicateSets(result), visible);
    assert.ok(sections);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].items.length, 1);
    // Everything filtered out → no sections at all, not an empty shell.
    const none = duplicateSetSections(result, groupDuplicateSets(result), []);
    assert.ok(none);
    assert.equal(none.length, 0);
  });

  it('returns null for anything that is not a duplicates-only run', () => {
    const result = tripletResult();
    const notDuplicates: ClashResult = {
      ...result,
      rulesRun: [{ id: 'all-clashes', name: 'All elements', a: '*', mode: 'hard' }],
    };
    assert.equal(
      duplicateSetSections(notDuplicates, groupDuplicateSets(notDuplicates), notDuplicates.clashes),
      null,
    );
  });

  it('returns null when the grouping does not cover a visible clash (stale groups)', () => {
    const result = tripletResult();
    const stale = groupDuplicateSets(findDuplicates([
      element('x', [9, 9, 9], [10, 10, 10]),
      element('y', [9, 9, 9], [10, 10, 10]),
    ]));
    assert.equal(duplicateSetSections(result, stale, result.clashes), null);
  });

  it('is NOT satisfied by the spatial clustering the review reverted to', () => {
    // The review's falsification: swap the grouping back to
    // groupClashes({by:'cluster'}) and prove nothing changes on screen. Here
    // that swap DOES change the outcome: cluster groups fuse the two duplicate
    // pairs standing within the 1.5 m radius into one section, where the
    // coincident-set grouping keeps them apart.
    const result = findDuplicates([
      element('a', [0, 0, 0], [1, 1, 1]),
      element('b', [0, 0, 0], [1, 1, 1]),
      element('c', [1, 0, 0], [2, 1, 1]),
      element('d', [1, 0, 0], [2, 1, 1]),
    ]);
    const viaSets = duplicateSetSections(result, groupDuplicateSets(result), result.clashes);
    const viaClusters = duplicateSetSections(
      result,
      groupClashes(result, { by: 'cluster', epsilon: 1.5 }),
      result.clashes,
    );
    assert.ok(viaSets);
    assert.ok(viaClusters);
    assert.equal(viaSets.length, 2);
    assert.equal(viaClusters.length, 1);
  });
});
