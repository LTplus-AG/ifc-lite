/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Explicit A/B membership (`ClashRule.membersA` / `membersB`).
 *
 * The partition is asserted through `runClash`'s `ruleCoverage`, which reports
 * the size of each side — so these tests pin the thing the engine actually
 * ran on, not just the predicate. The kernel is a stub that finds nothing:
 * what is under test is WHICH elements each side collected.
 */

import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { runClash } from './engine-ts/orchestrator.js';
import { describeEmptyRuleSides } from './analysis.js';
import { clashMemberKey, clashMemberSet, inClashSet } from './members.js';
import { fromPositions } from './math/aabb.js';
import type { ClashKernel, RuleDetection } from './engine-ts/kernel.js';
import type { ClashElement, ClashRule } from './types.js';

function element(key: string, tag: string, ref: number, model = 'm'): ClashElement {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return {
    key,
    ref,
    model,
    tag,
    bounds: fromPositions(positions),
    positions,
    indices: new Uint32Array([0, 1, 2]),
  };
}

/** Finds nothing; the assertions read `ruleCoverage`, not clashes. */
class EmptyKernel implements ClashKernel {
  prepare(): void {}
  detectRule(): RuleDetection {
    return { records: [], candidatesProcessed: 0, candidatesDropped: 0 };
  }
}

const ELEMENTS = [
  element('wall-1', 'IfcWall', 1),
  element('wall-2', 'IfcWall', 2),
  element('duct-1', 'IfcDuctSegment', 3),
  element('duct-2', 'IfcDuctSegment', 4, 'other'),
];

const RULE: ClashRule = { id: 'r', name: 'r', a: 'IfcWall', b: 'IfcDuct*', mode: 'hard' };

async function coverageOf(rule: ClashRule) {
  const result = await runClash(ELEMENTS, [rule], {}, new EmptyKernel());
  return result.ruleCoverage![0];
}

describe('clashMemberKey', () => {
  it('separates model from ref so no two pairs collide', () => {
    // Without a separator, ('a', 11) and ('a1', 1) would both be "a11".
    expect(clashMemberKey('a', 11)).not.toBe(clashMemberKey('a1', 1));
  });
});

describe('inClashSet', () => {
  it('falls back to the type selector when the side has no members', () => {
    expect(inClashSet(ELEMENTS[0], 'IfcWall', clashMemberSet(undefined))).toBe(true);
    expect(inClashSet(ELEMENTS[2], 'IfcWall', clashMemberSet(undefined))).toBe(false);
  });

  it('ignores the selector entirely once members are given', () => {
    const members = clashMemberSet([clashMemberKey('m', 3)]);
    // The duct is in the member set but does NOT match the selector; the wall
    // is the other way round. Membership decides both.
    expect(inClashSet(ELEMENTS[2], 'IfcWall', members)).toBe(true);
    expect(inClashSet(ELEMENTS[0], 'IfcWall', members)).toBe(false);
  });

  it('scopes membership by model, not by ref alone', () => {
    const members = clashMemberSet([clashMemberKey('m', 4)]);
    // ref 4 belongs to model 'other'; the same ref in model 'm' is a different
    // element and must not be pulled in.
    expect(inClashSet(ELEMENTS[3], '*', members)).toBe(false);
  });
});

describe('runClash: rule membership', () => {
  it('partitions side A by membership across models', async () => {
    const coverage = await coverageOf({
      ...RULE,
      membersA: [clashMemberKey('m', 1), clashMemberKey('other', 4)],
    });
    // A is the member set (one wall + one duct in another model); B still
    // resolves through its selector (both ducts).
    expect(coverage.matchedA).toBe(2);
    expect(coverage.matchedB).toBe(2);
  });

  it('an EMPTY member list matches nothing — it never falls back to the selector', async () => {
    // The failure this pins: a filter the user wrote that happens to resolve
    // to no element must run over nothing, not over every IfcWall.
    const coverage = await coverageOf({ ...RULE, membersA: [] });
    expect(coverage.matchedA).toBe(0);
    expect(coverage.matchedB).toBe(2);
  });

  it('both sides can be member sets at once', async () => {
    const coverage = await coverageOf({
      ...RULE,
      membersA: [clashMemberKey('m', 1)],
      membersB: [clashMemberKey('m', 3), clashMemberKey('other', 4)],
    });
    expect(coverage.matchedA).toBe(1);
    expect(coverage.matchedB).toBe(2);
  });

  it('reports the run WITHOUT the resolved membership', async () => {
    // `rulesRun` is kept in viewer store state and cloned into the script
    // sandbox; a member list is run state, and a big federation would drag a
    // quarter-million strings per side through both.
    const result = await runClash(
      ELEMENTS,
      [{ ...RULE, membersA: [clashMemberKey('m', 1)], membersB: [] }],
      {},
      new EmptyKernel(),
    );
    assert.deepEqual(result.rulesRun, [RULE]);
    // The coverage still says what each side matched, and that both sides
    // were resolved from membership — which is what a caller explaining an
    // empty side needs once `rulesRun` no longer carries the member lists.
    expect(result.ruleCoverage![0]).toEqual({
      rule: 'r',
      matchedA: 1,
      matchedB: 0,
      matchedKeysA: ['wall-1'],
      matchedKeysB: [],
      fromMembersA: true,
      fromMembersB: true,
    });
  });

  it('leaves a selector-only rule exactly as it was', async () => {
    const coverage = await coverageOf(RULE);
    expect(coverage).toEqual({
      rule: 'r',
      matchedA: 2,
      matchedB: 2,
      matchedKeysA: ['wall-1', 'wall-2'],
      matchedKeysB: ['duct-1', 'duct-2'],
    });
  });

  it('honours membersB on a rule with no b selector instead of self-clashing', async () => {
    // The public API takes membership per side; keying the second side on the
    // `b` SELECTOR alone would silently drop it and run A against itself.
    const coverage = await coverageOf({
      id: 'r',
      name: 'r',
      a: 'IfcWall',
      mode: 'hard',
      membersB: [clashMemberKey('m', 3)],
    });
    expect(coverage.matchedA).toBe(2);
    expect(coverage.matchedB).toBe(1);
  });

  it('describes an empty side by what actually defined it', async () => {
    // Naming a selector for a side a filter defined would explain the empty
    // result with something that never ran — the rule's stored selector for a
    // filtered side is typically "*".
    const filtered = await runClash(
      ELEMENTS,
      [{ ...RULE, a: '*', membersA: [] }],
      {},
      new EmptyKernel(),
    );
    expect(describeEmptyRuleSides(filtered.rulesRun[0], filtered.ruleCoverage![0]))
      .toBe('the filter for set A matched 0 elements');

    const selectorOnly = await runClash(
      ELEMENTS,
      [{ ...RULE, a: 'IfcNoSuchThing' }],
      {},
      new EmptyKernel(),
    );
    expect(describeEmptyRuleSides(selectorOnly.rulesRun[0], selectorOnly.ruleCoverage![0]))
      .toBe('selector A ("IfcNoSuchThing") matched 0 elements');
  });
});
