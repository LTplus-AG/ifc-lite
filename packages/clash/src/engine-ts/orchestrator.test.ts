/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct coverage for `runClash`'s own orchestration logic — severity
 * resolution, exclusions, identity/dedup, ordering and summary — driven
 * through a fake `ClashKernel` instead of a real geometry backend.
 *
 * This is the cover #2830 asks for: the differential suite (`differential.
 * test.ts`) compares `engine-ts` and `engine-wasm`, but both call this same
 * `runClash`, so it cannot see a bug here (see that file's header). These
 * tests target the orchestrator directly so a broken severity rule, a
 * leaking exclusion, a bad dedup key, a wrong sort comparator, or a bad
 * summary tally fails on its own, without needing two backends to disagree.
 */

import { describe, expect, it } from 'vitest';
import { runClash } from './orchestrator.js';
import { makeExclusionSet, qualifiedKey } from '../exclude.js';
import { fromPositions } from '../math/aabb.js';
import type { ClashKernel, NarrowRecord, RuleDetection } from './kernel.js';
import type { ClashElement, ClashRule, ClashSettings, Vec3 } from '../types.js';

let nextRef = 1;
function element(key: string, tag: string, model = 'm'): ClashElement {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return {
    key,
    ref: nextRef++,
    model,
    tag,
    bounds: fromPositions(positions),
    positions,
    indices: new Uint32Array([0, 1, 2]),
  };
}

function rec(a: number, b: number, over: Partial<NarrowRecord> = {}): NarrowRecord {
  return {
    a,
    b,
    status: 'hard',
    distance: -0.1,
    distanceKind: 'mesh',
    point: [0, 0, 0] as Vec3,
    bounds: fromPositions(new Float32Array([0, 0, 0, 1, 1, 1])),
    ...over,
  };
}

/** A kernel whose broad phase is trivial (every candidate) and whose narrow
 * phase returns exactly the records the test configured — one entry per rule
 * id, in call order. Lets a test dictate the raw kernel output directly, so
 * it exercises only the orchestrator's post-processing. */
class FakeKernel implements ClashKernel {
  private calls = 0;
  constructor(private readonly recordsByCall: NarrowRecord[][]) {}

  prepare(): void {}

  detectRule(): RuleDetection {
    const records = this.recordsByCall[this.calls] ?? [];
    this.calls += 1;
    return { records, candidatesProcessed: records.length, candidatesDropped: 0 };
  }
}

function run(
  elements: ClashElement[],
  rules: ClashRule[],
  recordsByCall: NarrowRecord[][],
  settings: ClashSettings = {},
) {
  return runClash(elements, rules, settings, new FakeKernel(recordsByCall));
}

const hard = (id: string, over: Partial<ClashRule> = {}): ClashRule => ({
  id,
  name: id,
  a: 'IfcWall',
  b: 'IfcDuct',
  mode: 'hard',
  ...over,
});

describe('runClash: severity resolution', () => {
  it('uses the rule-supplied severity verbatim, without consulting the discipline matrix', async () => {
    // IfcWall/IfcDuct matches no CLASH_RULE_PRESETS pair, so an inferred
    // severity here would be 'info'. An explicit rule.severity must win.
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct')];
    const result = await run(elements, [hard('r', { severity: 'critical' })], [[rec(0, 1)]]);
    expect(result.clashes[0].severity).toBe('critical');
  });

  it('falls back to the discipline matrix when the rule has no severity', async () => {
    // IfcDuctSegment vs IfcBeam matches the HVACxSTR preset (critical).
    const elements = [element('A', 'IfcDuctSegment'), element('B', 'IfcBeam')];
    const rule: ClashRule = { id: 'r', name: 'r', a: 'IfcDuct*', b: 'IfcBeam', mode: 'hard' };
    const result = await run(elements, [rule], [[rec(0, 1)]]);
    expect(result.clashes[0].severity).toBe('critical');
  });
});

describe('runClash: exclusions', () => {
  it('drops an excluded pair when excludeVoidsAndHosts is on (the default)', async () => {
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct')];
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'A'), qualifiedKey('m', 'B')]]);
    const result = await run(elements, [hard('r')], [[rec(0, 1)]], { exclusions });
    expect(result.summary.total).toBe(0);
  });

  it('applies an excluded pair regardless of which element is a/b in the record', async () => {
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct')];
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'B'), qualifiedKey('m', 'A')]]);
    const result = await run(elements, [hard('r')], [[rec(0, 1)]], { exclusions });
    expect(result.summary.total).toBe(0);
  });

  it('keeps the exclusion set inert when excludeVoidsAndHosts is explicitly off', async () => {
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct')];
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'A'), qualifiedKey('m', 'B')]]);
    const result = await run(elements, [hard('r')], [[rec(0, 1)]], {
      exclusions,
      excludeVoidsAndHosts: false,
    });
    expect(result.summary.total).toBe(1);
  });

  it('does not drop a pair that is not in the exclusion set', async () => {
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct'), element('C', 'IfcDuct')];
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'A'), qualifiedKey('m', 'C')]]);
    const result = await run(elements, [hard('r')], [[rec(0, 1)]], { exclusions });
    expect(result.summary.total).toBe(1);
  });
});

describe('runClash: identity / dedup', () => {
  it('collapses two kernel records for the same rule and pair into one clash', async () => {
    // A real kernel should not emit the same pair twice for one rule, but the
    // orchestrator's `seen` set is the last line of defence against a kernel
    // that does (e.g. overlapping A/B groups on a two-sided rule) — this
    // drives that path directly rather than relying on a kernel accident.
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct')];
    const result = await run(elements, [hard('r')], [[rec(0, 1), rec(1, 0)]]);
    expect(result.summary.total).toBe(1);
  });

  it('keeps both clashes when two DIFFERENT rules match the same element pair', async () => {
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct')];
    const result = await run(
      elements,
      [hard('r1'), hard('r2')],
      [[rec(0, 1)], [rec(0, 1)]],
    );
    expect(result.summary.total).toBe(2);
    expect(new Set(result.clashes.map((c) => c.id)).size).toBe(2);
  });

  it('skips a same-entity pair (same key + model) even if the kernel emits it', async () => {
    const elements = [element('K', 'IfcWall'), element('K', 'IfcWall')];
    const result = await run(elements, [{ id: 'r', name: 'r', a: 'IfcWall', mode: 'hard' }], [[rec(0, 1)]]);
    expect(result.summary.total).toBe(0);
  });
});

describe('runClash: ordering', () => {
  it('sorts by element A key, then element B key', async () => {
    const elements = [
      element('B', 'IfcWall'),
      element('A', 'IfcWall'),
      element('D', 'IfcDuct'),
      element('C', 'IfcDuct'),
    ];
    // One rule over a 2x2 selection, records deliberately out of key order.
    const result = await run(
      elements,
      [hard('r')],
      [[rec(0, 2), rec(1, 3), rec(0, 3), rec(1, 2)]], // B-D, A-C, B-C, A-D
    );
    const ordered = result.clashes.map((c) => `${c.a.key}${c.b.key}`);
    expect(ordered).toEqual(['AC', 'AD', 'BC', 'BD']);
  });

  it('breaks a tie on the same element pair by rule id', async () => {
    // Two rules both matching the SAME pair (A, B) — same a.key/b.key on both
    // clashes, so only the rule-id tiebreak in `byKeyThenRule` can order them.
    const elements = [element('A', 'IfcWall'), element('B', 'IfcDuct')];
    const result = await run(
      elements,
      [hard('z'), hard('a')], // inserted in rule order z, then a
      [[rec(0, 1)], [rec(0, 1)]],
    );
    expect(result.clashes.map((c) => c.rule)).toEqual(['a', 'z']);
  });
});

describe('runClash: summary', () => {
  it('summary.total and byRule track the deduped, filtered clash list — not the raw records', async () => {
    const elements = [
      element('A', 'IfcWall'),
      element('B', 'IfcDuct'),
      element('C', 'IfcDuct'),
    ];
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'A'), qualifiedKey('m', 'C')]]);
    const result = await run(
      elements,
      [hard('r')],
      // A-B kept, A-C excluded, A-B duplicated (deduped to one).
      [[rec(0, 1), rec(0, 2), rec(1, 0)]],
      { exclusions },
    );
    expect(result.summary.total).toBe(1);
    expect(result.summary.byRule.r).toBe(1);
    expect(result.clashes).toHaveLength(1);
  });
});
