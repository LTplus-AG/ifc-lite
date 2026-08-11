/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User-defined clash exclusions: the two rule granularities (a whole TYPE pair,
 * and one specific ELEMENT pair), their matching semantics, and the filtering
 * pass that both removes suppressed clashes and reports how many each rule is
 * suppressing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Clash, ClashElementRef, ClashResult } from '@ifc-lite/clash';
import {
  applyClashExclusions,
  elementPairExclusion,
  exclusionMatches,
  exclusionRuleKey,
  typeAnyExclusion,
  typePairExclusion,
  type ClashExclusionRule,
} from './exclusions.js';

function ref(model: string, key: string, tag: string, name?: string): ClashElementRef {
  return { model, key, tag, ref: 0, ...(name ? { name } : {}) };
}

let seq = 0;
function clash(a: ClashElementRef, b: ClashElementRef, rule = 'all-clashes'): Clash {
  seq += 1;
  return {
    id: `c${seq}`,
    a,
    b,
    rule,
    status: 'hard',
    distance: -0.075,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'major',
  };
}

function result(clashes: Clash[]): ClashResult {
  const byRule: Record<string, number> = {};
  const byTypePair: Record<string, number> = {};
  const bySeverity = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clashes) {
    byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
    const pair = [c.a.tag, c.b.tag].sort().join(' vs ');
    byTypePair[pair] = (byTypePair[pair] ?? 0) + 1;
    bySeverity[c.severity] += 1;
  }
  return {
    clashes,
    summary: { total: clashes.length, byRule, byTypePair, bySeverity },
    rulesRun: [],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

const rail1 = ref('m1', 'GUID_RAIL_1', 'IfcRail', 'Rail 1');
const rail2 = ref('m1', 'GUID_RAIL_2', 'IfcRail', 'Rail 2');
const course1 = ref('m1', 'GUID_COURSE_1', 'IfcCourse', 'Ballast');
const course2 = ref('m1', 'GUID_COURSE_2', 'IfcCourse', 'Sub-ballast');
const beam1 = ref('m1', 'GUID_BEAM_1', 'IfcBeam', 'Beam 1');
const beam2 = ref('m1', 'GUID_BEAM_2', 'IfcBeam', 'Beam 2');

describe('clash exclusion rule matching', () => {
  it('matches a type pair in either element order', () => {
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    assert.strictEqual(exclusionMatches(rule, rail1, course1), true);
    assert.strictEqual(exclusionMatches(rule, course1, rail1), true);
  });

  it('does not match a type pair that only shares one side', () => {
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    assert.strictEqual(exclusionMatches(rule, rail1, beam1), false);
    assert.strictEqual(exclusionMatches(rule, beam1, beam2), false);
  });

  it('matches a same-type pair (IfcBeam x IfcBeam) without matching a mixed pair', () => {
    const rule = typePairExclusion('IfcBeam', 'IfcBeam');
    assert.strictEqual(exclusionMatches(rule, beam1, beam2), true);
    assert.strictEqual(exclusionMatches(rule, beam1, rail1), false);
  });

  it('matches an element pair in either order but no other pair of the same types', () => {
    const rule = elementPairExclusion(beam1, beam2);
    assert.strictEqual(exclusionMatches(rule, beam1, beam2), true);
    assert.strictEqual(exclusionMatches(rule, beam2, beam1), true);
    const beam3 = ref('m1', 'GUID_BEAM_3', 'IfcBeam', 'Beam 3');
    assert.strictEqual(exclusionMatches(rule, beam1, beam3), false);
  });

  it('keeps matching an element pair across a model-id change (survives reload)', () => {
    // `model` is the viewer's per-load `crypto.randomUUID()` (useIfcLoader /
    // useIfcFederation mint a fresh one on every load/reload). A rule keyed on
    // it would go permanently inert the moment the page reloads while the
    // panel still lists it as enabled. Element identity is the durable key
    // alone (same choice as `clashReviewKey` in `@ifc-lite/clash`), so the
    // SAME rule still matches after `model` changes.
    const rule = elementPairExclusion(ref('m1', 'K1', 'IfcBeam'), ref('m1', 'K2', 'IfcBeam'));
    assert.strictEqual(exclusionMatches(rule, ref('m2', 'K1', 'IfcBeam'), ref('m2', 'K2', 'IfcBeam')), true);
    assert.strictEqual(exclusionMatches(rule, ref('m1', 'K1', 'IfcBeam'), ref('m2', 'K2', 'IfcBeam')), true);
  });

  it('gives order-independent, kind-distinct dedup keys', () => {
    assert.strictEqual(
      exclusionRuleKey(typePairExclusion('IfcRail', 'IfcCourse')),
      exclusionRuleKey(typePairExclusion('IfcCourse', 'IfcRail')),
    );
    assert.notStrictEqual(
      exclusionRuleKey(typePairExclusion('IfcBeam', 'IfcBeam')),
      exclusionRuleKey(elementPairExclusion(beam1, beam2)),
    );
  });

  it('gives a one-sided rule its own dedup key, distinct from the same-type pair', () => {
    // `typeAny('IfcBeam')` and `typePair('IfcBeam','IfcBeam')` are different
    // decisions — "beams may touch anything" vs "beams may touch beams" — so
    // adding one must not be swallowed as a duplicate of the other.
    assert.notStrictEqual(
      exclusionRuleKey(typeAnyExclusion('IfcBeam')),
      exclusionRuleKey(typePairExclusion('IfcBeam', 'IfcBeam')),
    );
    assert.strictEqual(exclusionRuleKey(typeAnyExclusion('IfcSlab')), exclusionRuleKey(typeAnyExclusion('IfcSlab')));
    assert.notStrictEqual(exclusionRuleKey(typeAnyExclusion('IfcSlab')), exclusionRuleKey(typeAnyExclusion('IfcBeam')));
  });
});

describe('one-sided type exclusion rules', () => {
  it('matches whichever side of the clash carries the type', () => {
    // Order-independence is the whole point: the engine decides which element
    // lands on side A, and the user's "ignore anything touching a slab" cannot
    // depend on that.
    const rule = typeAnyExclusion('IfcCourse');
    assert.strictEqual(exclusionMatches(rule, course1, rail1), true, 'type on side A');
    assert.strictEqual(exclusionMatches(rule, rail1, course1), true, 'type on side B');
  });

  it('matches a clash of the type against itself', () => {
    const rule = typeAnyExclusion('IfcCourse');
    assert.strictEqual(exclusionMatches(rule, course1, course2), true);
  });

  it('does not match a pair where neither side is the type', () => {
    const rule = typeAnyExclusion('IfcCourse');
    assert.strictEqual(exclusionMatches(rule, beam1, beam2), false);
    assert.strictEqual(exclusionMatches(rule, rail1, beam1), false);
  });

  it('is cross-model: the same type in any model is covered', () => {
    // A TYPE rule carries no model qualification, unlike an element-pair rule.
    const rule = typeAnyExclusion('IfcBeam');
    assert.strictEqual(exclusionMatches(rule, ref('mX', 'K9', 'IfcBeam'), ref('mY', 'K8', 'IfcRail')), true);
  });

  it('is type-exact, not a prefix or substring match', () => {
    const rule = typeAnyExclusion('IfcBeam');
    assert.strictEqual(exclusionMatches(rule, ref('m1', 'K1', 'IfcBeamStandardCase'), rail1), false);
  });

  it('does not make an existing two-sided rule behave one-sidedly', () => {
    // Backward-compatibility guard: adding the one-sided kind must not turn
    // `typePair(A,B)` into "anything touching A".
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    assert.strictEqual(exclusionMatches(rule, rail1, beam1), false);
    assert.strictEqual(exclusionMatches(rule, beam1, course1), false);
    assert.strictEqual(exclusionMatches(rule, rail1, course1), true);
  });
});

describe('applyClashExclusions with one-sided type rules', () => {
  const mixed = result([
    clash(rail1, course1),
    clash(course1, rail2),
    clash(course1, course2),
    clash(beam1, beam2),
    clash(rail1, beam1),
  ]);

  it('one rule clears every clash touching the type, whichever side it is on', () => {
    const rule = typeAnyExclusion('IfcCourse');
    const out = applyClashExclusions(mixed, [rule]);
    assert.strictEqual(out.suppressed, 3);
    assert.strictEqual(out.counts.get(rule.id), 3);
    assert.strictEqual(out.result?.clashes.length, 2);
    // The survivors are exactly the two that never touch an IfcCourse.
    assert.deepStrictEqual(out.result?.summary.byTypePair, { 'IfcBeam vs IfcBeam': 1, 'IfcBeam vs IfcRail': 1 });
  });

  it('leaves unrelated pairs alone when several one-sided rules are combined', () => {
    const out = applyClashExclusions(mixed, [typeAnyExclusion('IfcCourse'), typeAnyExclusion('IfcRail')]);
    assert.strictEqual(out.result?.clashes.length, 1);
    assert.strictEqual(out.result?.clashes[0]?.a.tag, 'IfcBeam');
    assert.strictEqual(out.result?.clashes[0]?.b.tag, 'IfcBeam');
  });

  it('a disabled one-sided rule still reports what it would hide', () => {
    const rule: ClashExclusionRule = { ...typeAnyExclusion('IfcCourse'), enabled: false };
    const out = applyClashExclusions(mixed, [rule]);
    assert.strictEqual(out.suppressed, 0);
    assert.strictEqual(out.result?.clashes.length, 5);
    assert.strictEqual(out.counts.get(rule.id), 3);
  });
});

describe('applyClashExclusions', () => {
  const railBallast = [
    clash(rail1, course1),
    clash(rail2, course1),
    clash(rail1, course2),
  ];
  const beams = [clash(beam1, beam2)];
  const base = result([...railBallast, ...beams]);

  it('leaves the result untouched when there are no rules', () => {
    const out = applyClashExclusions(base, []);
    assert.strictEqual(out.result?.clashes.length, 4);
    assert.strictEqual(out.suppressed, 0);
  });

  it('one type-pair rule suppresses every clash of that pair at once', () => {
    const rule = typePairExclusion('IfcRail', 'IfcCourse');
    const out = applyClashExclusions(base, [rule]);
    assert.strictEqual(out.result?.clashes.length, 1);
    assert.strictEqual(out.result?.clashes[0]?.a.tag, 'IfcBeam');
    assert.strictEqual(out.suppressed, 3);
    assert.strictEqual(out.counts.get(rule.id), 3);
  });

  it('rebuilds the summary so totals and buckets match the surviving clashes', () => {
    const out = applyClashExclusions(base, [typePairExclusion('IfcRail', 'IfcCourse')]);
    assert.strictEqual(out.result?.summary.total, 1);
    assert.deepStrictEqual(out.result?.summary.byTypePair, { 'IfcBeam vs IfcBeam': 1 });
    assert.strictEqual(out.result?.summary.bySeverity.major, 1);
  });

  it('an element-pair rule suppresses only that pair, leaving its type siblings', () => {
    const rule = elementPairExclusion(rail1, course1);
    const out = applyClashExclusions(base, [rule]);
    assert.strictEqual(out.result?.clashes.length, 3);
    assert.strictEqual(out.suppressed, 1);
    assert.strictEqual(out.counts.get(rule.id), 1);
  });

  it('counts a disabled rule without letting it suppress anything', () => {
    const rule: ClashExclusionRule = { ...typePairExclusion('IfcRail', 'IfcCourse'), enabled: false };
    const out = applyClashExclusions(base, [rule]);
    assert.strictEqual(out.result?.clashes.length, 4);
    assert.strictEqual(out.suppressed, 0);
    // Still reported, so the user can see what re-enabling it would cost.
    assert.strictEqual(out.counts.get(rule.id), 3);
  });

  it('counts each overlapping rule independently but suppresses each clash once', () => {
    const wide = typePairExclusion('IfcRail', 'IfcCourse');
    const narrow = elementPairExclusion(rail1, course1);
    const out = applyClashExclusions(base, [wide, narrow]);
    assert.strictEqual(out.counts.get(wide.id), 3);
    assert.strictEqual(out.counts.get(narrow.id), 1);
    assert.strictEqual(out.suppressed, 3);
    assert.strictEqual(out.result?.clashes.length, 1);
  });

  it('returns null for a null result rather than inventing an empty one', () => {
    const out = applyClashExclusions(null, [typePairExclusion('IfcRail', 'IfcCourse')]);
    assert.strictEqual(out.result, null);
    assert.strictEqual(out.suppressed, 0);
  });
});
