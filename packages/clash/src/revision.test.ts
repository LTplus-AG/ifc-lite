/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { compareClashRevisions, type ClashRevisionSide } from './revision.js';
import { runClash } from './engine-ts/orchestrator.js';
import { clashMemberKey } from './members.js';
import { fromPositions } from './math/aabb.js';
import type { ClashKernel, NarrowRecord, RuleDetection } from './engine-ts/kernel.js';
import type { Clash, ClashElement, ClashResult, ClashRule, Vec3 } from './types.js';

/**
 * Every fixture below is a REAL `ClashResult` produced by the real orchestrator
 * (`runClash`), never a hand-built object shaped like `ClashResult`. The whole
 * point of `compareClashRevisions` is to read `rulesRun` / `ruleCoverage`
 * safely, and those are exactly the fields a hand-typed fixture is likely to
 * get subtly wrong (wrong shape, or simply omitted) without a test noticing —
 * the mock would then agree with the code by construction. Only the geometry
 * kernel is faked (`FixedKernel`), matching `lifecycle.test.ts`'s own seam
 * tests.
 */

let nextRef = 1;
function element(key: string, tag: string, model: string): ClashElement {
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

function record(a: number, b: number): NarrowRecord {
  return {
    a,
    b,
    status: 'hard',
    distance: -0.1,
    distanceKind: 'mesh',
    point: [0, 0, 0] as Vec3,
    bounds: fromPositions(new Float32Array([0, 0, 0, 1, 1, 1])),
  };
}

class FixedKernel implements ClashKernel {
  constructor(private readonly records: NarrowRecord[]) {}
  prepare(): void {}
  detectRule(): RuleDetection {
    return { records: this.records, candidatesProcessed: this.records.length, candidatesDropped: 0 };
  }
}

const wallDuctRule: ClashRule = { id: 'arch-mep', name: 'Arch/MEP', a: 'IfcWall', b: 'IfcDuct', mode: 'hard' };
const beamPipeRule: ClashRule = { id: 'struct-mep', name: 'Struct/MEP', a: 'IfcBeam', b: 'IfcPipe', mode: 'hard' };

function ids(clashes: readonly Clash[]): string[] {
  return clashes.map((c) => c.id).sort();
}

/** Wrap a `ClashResult` into a `ClashRevisionSide` with a model-id → name map
 *  built from whatever model ids the run's own clashes carry, so the map is
 *  never hand-typed against ids the test invented separately. */
function side(result: ClashResult, names: Record<string, string>): ClashRevisionSide {
  return { result, modelNames: names };
}

describe('compareClashRevisions — basic partition (delegates to compareClashRuns)', () => {
  it('a persisting clash is reported once, not duplicated across buckets', async () => {
    const previous = await runClash(
      [element('wall-1', 'IfcWall', 'load-1'), element('duct-1', 'IfcDuct', 'load-1')],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1)]),
    );
    const next = await runClash(
      [element('wall-1', 'IfcWall', 'load-2'), element('duct-1', 'IfcDuct', 'load-2')],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1)]),
    );

    const cmp = compareClashRevisions(
      side(previous, { 'load-1': 'building.ifc' }),
      side(next, { 'load-2': 'building.ifc' }),
    );

    expect(cmp.added).toHaveLength(0);
    expect(cmp.persistent).toHaveLength(1);
    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(0);
    expect(cmp.reasons).toEqual({ skippedRuleIds: [], noMatchRuleIds: [], missingModelNames: [] });
  });

  it('a genuinely fixed clash — same rule, same models, still checked — is resolved', async () => {
    const previous = await runClash(
      [element('wall-1', 'IfcWall', 'load-1'), element('duct-1', 'IfcDuct', 'load-1')],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1)]),
    );
    // The duct moved away: the rule ran, matched both sides, found nothing.
    const next = await runClash(
      [element('wall-1', 'IfcWall', 'load-2'), element('duct-1', 'IfcDuct', 'load-2')],
      [wallDuctRule],
      {},
      new FixedKernel([]),
    );

    const cmp = compareClashRevisions(
      side(previous, { 'load-1': 'building.ifc' }),
      side(next, { 'load-2': 'building.ifc' }),
    );

    expect(cmp.resolved).toHaveLength(1);
    expect(cmp.unretested).toHaveLength(0);
  });
});

describe('compareClashRevisions — the three unsafe conditions', () => {
  it('a rule dropped from the matrix: its previous clash is unretested, not resolved', async () => {
    const elements = [element('wall-1', 'IfcWall', 'm'), element('duct-1', 'IfcDuct', 'm')];
    const previous = await runClash(elements, [wallDuctRule], {}, new FixedKernel([record(0, 1)]));
    // Current run's matrix simply never includes wallDuctRule (e.g. the user
    // unchecked it in the panel) — a different rule ran instead.
    const next = await runClash(
      [element('beam-1', 'IfcBeam', 'm'), element('pipe-1', 'IfcPipe', 'm')],
      [beamPipeRule],
      {},
      new FixedKernel([]),
    );

    const cmp = compareClashRevisions(side(previous, { m: 'building.ifc' }), side(next, { m: 'building.ifc' }));

    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1);
    expect(cmp.reasons.skippedRuleIds).toEqual(['arch-mep']);
  });

  it("a rule whose selector now matches nothing: its previous clash is unretested", async () => {
    const previous = await runClash(
      [element('wall-1', 'IfcWall', 'm'), element('duct-1', 'IfcDuct', 'm')],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1)]),
    );
    // Same rule runs again, but no IfcDuct element exists this time (e.g. the
    // MEP discipline was left out of the federation by mistake) — matchedB=0.
    const next = await runClash([element('wall-1', 'IfcWall', 'm')], [wallDuctRule], {}, new FixedKernel([]));

    expect(next.ruleCoverage?.[0]).toMatchObject({ rule: 'arch-mep', matchedA: 1, matchedB: 0 });

    const cmp = compareClashRevisions(side(previous, { m: 'building.ifc' }), side(next, { m: 'building.ifc' }));

    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1);
    expect(cmp.reasons.noMatchRuleIds).toEqual(['arch-mep']);
  });

  it('a model missing from the current comparison is caught even when the rule still has other matches (isolates the model check from the coverage check)', async () => {
    // Baseline: a wall clashes with a duct in EACH of two MEP models.
    const previous = await runClash(
      [
        element('wall-1', 'IfcWall', 'arch'),
        element('duct-1', 'IfcDuct', 'mep-1'),
        element('duct-2', 'IfcDuct', 'mep-2'),
      ],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1), record(0, 2)]),
    );
    // Current: mep-1 is gone entirely, but mep-2 reloaded (new id) still
    // supplies a duct, so the rule matches non-zero on both sides — matchedA
    // and matchedB are both > 0, so `ruleHadNoMatch` cannot flag this rule.
    // Only the durable-name check can catch the lost mep-1 model.
    const next = await runClash(
      [element('wall-1', 'IfcWall', 'arch-2'), element('duct-2', 'IfcDuct', 'mep-2-reload')],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1)]),
    );
    expect(next.ruleCoverage?.[0]).toMatchObject({ matchedA: 1, matchedB: 1 });

    const cmp = compareClashRevisions(
      side(previous, { arch: 'architecture.ifc', 'mep-1': 'mep-1.ifc', 'mep-2': 'mep-2.ifc' }),
      side(next, { 'arch-2': 'architecture.ifc', 'mep-2-reload': 'mep-2.ifc' }),
    );

    expect(cmp.persistent).toHaveLength(1); // the mep-2 clash survives the reload
    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1); // the mep-1 clash: unknown, not fixed
    expect(cmp.reasons.missingModelNames).toEqual(['mep-1.ifc']);
    expect(cmp.reasons.noMatchRuleIds).toEqual([]);
    expect(cmp.reasons.skippedRuleIds).toEqual([]);
  });

  it('a model missing from the current comparison: its previous clash is unretested', async () => {
    const previous = await runClash(
      [element('wall-1', 'IfcWall', 'arch-load'), element('duct-1', 'IfcDuct', 'mep-load')],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1)]),
    );
    // Current run only has the architectural model loaded — MEP was never
    // reloaded at all, not merely re-minted with a new id.
    const next = await runClash([element('wall-1', 'IfcWall', 'arch-load-2')], [wallDuctRule], {}, new FixedKernel([]));

    const cmp = compareClashRevisions(
      side(previous, { 'arch-load': 'architecture.ifc', 'mep-load': 'mep.ifc' }),
      side(next, { 'arch-load-2': 'architecture.ifc' }),
    );

    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1);
    expect(cmp.reasons.missingModelNames).toEqual(['mep.ifc']);
  });
});

describe('compareClashRevisions — per-element granularity (#3947)', () => {
  it('1a: a narrowed membersB filter drops one previously-clashing element while the side still matches non-zero elsewhere', async () => {
    const wall = element('wall-1', 'IfcWall', 'm');
    const duct1 = element('duct-1', 'IfcDuct', 'm');
    const duct2 = element('duct-2', 'IfcDuct', 'm');
    const elements = [wall, duct1, duct2];
    const ruleWithMembers = (memberRefs: number[]): ClashRule => ({
      id: 'arch-mep-filtered',
      name: 'Arch/MEP (filtered)',
      a: 'IfcWall',
      mode: 'hard',
      membersB: memberRefs.map((ref) => clashMemberKey('m', ref)),
    });

    const previous = await runClash(
      elements,
      [ruleWithMembers([duct1.ref, duct2.ref])],
      {},
      new FixedKernel([record(0, 1)]), // wall-1 x duct-1
    );
    // duct-1 is unchanged and unmoved, but a re-scoped MEP filter drops it from
    // membersB this run; duct-2 stays, so `matchedB` is still non-zero.
    const next = await runClash(
      elements,
      [ruleWithMembers([duct2.ref])],
      {},
      new FixedKernel([]),
    );
    expect(next.ruleCoverage?.[0]).toMatchObject({ matchedA: 1, matchedB: 1 });

    const cmp = compareClashRevisions(
      side(previous, { m: 'building.ifc' }),
      side(next, { m: 'building.ifc' }),
    );

    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1);
  });

  it('1b: two models sharing a display name — one genuinely lost, the other reloaded under the same durable key — still flags the lost one', async () => {
    const wall = element('wall-1', 'IfcWall', 'arch');
    const ductA = element('duct-1', 'IfcDuct', 'mep-a');
    // Same durable key as ductA but a DIFFERENT model — the multi-occurrence-
    // per-review-key case lifecycle.ts's own module doc documents.
    const ductB = element('duct-1', 'IfcDuct', 'mep-b');
    const previous = await runClash(
      [wall, ductA, ductB],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1), record(0, 2)]),
    );

    // mep-a is gone entirely; mep-b reloads under a new id, still named
    // "mep.ifc" and still carrying durable key "duct-1" — so the key alone
    // cannot distinguish "mep-a's duct came back" from "mep-b's duct is still
    // here"; only the per-name COUNT can (2 previous models named "mep.ifc",
    // only 1 remains).
    const wall2 = element('wall-1', 'IfcWall', 'arch-2');
    const ductB2 = element('duct-1', 'IfcDuct', 'mep-b-2');
    const next = await runClash([wall2, ductB2], [wallDuctRule], {}, new FixedKernel([record(0, 1)]));

    const cmp = compareClashRevisions(
      side(previous, { arch: 'architecture.ifc', 'mep-a': 'mep.ifc', 'mep-b': 'mep.ifc' }),
      side(next, { 'arch-2': 'architecture.ifc', 'mep-b-2': 'mep.ifc' }),
    );

    expect(cmp.persistent).toHaveLength(1);
    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1);
    expect(cmp.reasons.missingModelNames).toEqual(['mep.ifc']);
  });

  it('1c: a renamed GlobalId between exports (same element, same model, same rule) must not read as resolved', async () => {
    const wall = element('wall-1', 'IfcWall', 'm');
    const ductOld = element('duct-1', 'IfcDuct', 'm');
    const previous = await runClash([wall, ductOld], [wallDuctRule], {}, new FixedKernel([record(0, 1)]));

    // Same physical duct, same model (not reloaded), re-exported under a new
    // durable key — `compareClashRuns` correctly cannot match old to new, so
    // it reports one `resolved` half and one `added` half.
    const wall2 = element('wall-1', 'IfcWall', 'm');
    const ductNew = element('duct-1-v2', 'IfcDuct', 'm');
    const next = await runClash([wall2, ductNew], [wallDuctRule], {}, new FixedKernel([record(0, 1)]));

    const cmp = compareClashRevisions(
      side(previous, { m: 'building.ifc' }),
      side(next, { m: 'building.ifc' }),
    );

    expect(cmp.added).toHaveLength(1);
    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1);
  });
});

describe('compareClashRevisions — role-qualified matching (#3947 follow-up)', () => {
  it('1d: an element dropped from role A but still present in role B must not credit a cross-role match as resolved', async () => {
    // wall sits in BOTH membersA and membersB; duct-1 is A-only, duct-2 is
    // B-only. The kernel finds wall(A) x duct-2(B).
    const wall = element('wall-1', 'IfcWall', 'm');
    const duct1 = element('duct-1', 'IfcDuct', 'm');
    const duct2 = element('duct-2', 'IfcDuct', 'm');
    const elements = [wall, duct1, duct2];
    const ruleWithMembers = (aRefs: number[], bRefs: number[]): ClashRule => ({
      id: 'arch-mep-members',
      name: 'Arch/MEP (membership)',
      a: '', // ignored: membersA replaces the selector entirely (members.ts)
      mode: 'hard',
      membersA: aRefs.map((ref) => clashMemberKey('m', ref)),
      membersB: bRefs.map((ref) => clashMemberKey('m', ref)),
    });

    const previous = await runClash(
      elements,
      [ruleWithMembers([wall.ref, duct1.ref], [wall.ref, duct2.ref])],
      {},
      new FixedKernel([record(0, 2)]), // wall (A) x duct-2 (B)
    );
    expect(previous.ruleCoverage?.[0]).toMatchObject({
      matchedKeysA: ['duct-1', 'wall-1'],
      matchedKeysB: ['duct-2', 'wall-1'],
    });

    // Next run: the coordinator edits membersA to drop wall entirely, but
    // membersB is untouched — wall is now B-only, duct-2 is still B-only.
    // Under real A×B pairing, they are never tested against each other again.
    const next = await runClash(
      elements,
      [ruleWithMembers([duct1.ref], [wall.ref, duct2.ref])],
      {},
      new FixedKernel([]),
    );
    expect(next.ruleCoverage?.[0]).toMatchObject({
      matchedKeysA: ['duct-1'],
      matchedKeysB: ['duct-2', 'wall-1'],
    });

    const cmp = compareClashRevisions(
      side(previous, { m: 'building.ifc' }),
      side(next, { m: 'building.ifc' }),
    );

    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(1);
  });

  it('1e: a self-clash rule (no B side) treats both elements symmetrically within the single matched set', async () => {
    const wall1 = element('wall-1', 'IfcWall', 'm');
    const wall2 = element('wall-2', 'IfcWall', 'm');
    const elements = [wall1, wall2];
    const selfClashRule: ClashRule = { id: 'self-wall', name: 'Wall self-clash', a: 'IfcWall', mode: 'hard' };

    const previous = await runClash(elements, [selfClashRule], {}, new FixedKernel([record(0, 1)]));
    expect(previous.ruleCoverage?.[0]).toMatchObject({
      matchedKeysA: ['wall-1', 'wall-2'],
      matchedKeysB: null,
    });

    // Both elements are still matched by the same (single) group next run —
    // a genuinely resolved self-clash must still read as resolved regardless
    // of which element the kernel happened to label `a` vs `b`.
    const next = await runClash(elements, [selfClashRule], {}, new FixedKernel([]));

    const cmp = compareClashRevisions(
      side(previous, { m: 'building.ifc' }),
      side(next, { m: 'building.ifc' }),
    );

    expect(cmp.resolved).toHaveLength(1);
    expect(cmp.unretested).toHaveLength(0);
  });
});

describe('compareClashRevisions — controls', () => {
  it('a run compared to itself: everything persists, nothing new or resolved', async () => {
    const elements = [
      element('wall-1', 'IfcWall', 'm'),
      element('duct-1', 'IfcDuct', 'm'),
      element('duct-2', 'IfcDuct', 'm'),
    ];
    const result = await runClash(elements, [wallDuctRule], {}, new FixedKernel([record(0, 1), record(0, 2)]));
    const names = { m: 'building.ifc' };

    const cmp = compareClashRevisions(side(result, names), side(result, names));

    expect(cmp.added).toHaveLength(0);
    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.unretested).toHaveLength(0);
    expect(ids(cmp.persistent)).toEqual(ids(result.clashes));
  });

  it('an empty run on either side is handled without throwing', async () => {
    const empty = await runClash([], [wallDuctRule], {}, new FixedKernel([]));
    const withOne = await runClash(
      [element('wall-1', 'IfcWall', 'm'), element('duct-1', 'IfcDuct', 'm')],
      [wallDuctRule],
      {},
      new FixedKernel([record(0, 1)]),
    );
    const names = { m: 'building.ifc' };

    const fromEmpty = compareClashRevisions(side(empty, names), side(withOne, names));
    expect(fromEmpty.added).toHaveLength(1);
    expect(fromEmpty.resolved).toHaveLength(0);

    const toEmpty = compareClashRevisions(side(withOne, names), side(empty, names));
    // withOne's rule matched 0 on both sides in `empty` (no elements at all),
    // so the previous clash correctly reads as unretested, not resolved: an
    // empty run proves nothing was re-checked.
    expect(toEmpty.resolved).toHaveLength(0);
    expect(toEmpty.unretested).toHaveLength(1);
  });

  it('a clash present in both runs at a changed location is persistent, carrying the current geometry', async () => {
    const previous = await runClash(
      [element('wall-1', 'IfcWall', 'm'), element('duct-1', 'IfcDuct', 'm')],
      [wallDuctRule],
      {},
      new FixedKernel([{ ...record(0, 1), distance: -0.5, point: [0, 0, 0] }]),
    );
    const next = await runClash(
      [element('wall-1', 'IfcWall', 'm'), element('duct-1', 'IfcDuct', 'm')],
      [wallDuctRule],
      {},
      new FixedKernel([{ ...record(0, 1), distance: -0.02, point: [3, 3, 3] }]),
    );
    const names = { m: 'building.ifc' };

    const cmp = compareClashRevisions(side(previous, names), side(next, names));

    expect(cmp.resolved).toHaveLength(0);
    expect(cmp.persistent).toHaveLength(1);
    expect(cmp.persistent[0]?.point).toEqual([3, 3, 3]);
    expect(cmp.persistent[0]?.distance).toBe(-0.02);
  });
});
