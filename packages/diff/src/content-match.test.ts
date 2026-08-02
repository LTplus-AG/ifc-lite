/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the opt-in content-keyed matching pass (issue #1891):
 * `diffModels(..., { matchUnpairedByContent: true })`.
 *
 * GlobalIds are unreliable across a from-scratch re-export — every element
 * gets a new GlobalId, so a pure key diff reports the whole model as
 * deleted-and-added even when nothing substantive changed. This pass
 * re-examines the key-based pass's leftover `added`/`deleted` entities and
 * pairs them by content hash where the pairing is unambiguous, reporting
 * matches via `ModelDiff.contentMatches` (never by widening `DiffState`, so
 * an existing exhaustive switch over `DiffState` elsewhere in the monorepo
 * keeps compiling).
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { buildComponentFingerprints, buildDataFingerprint } from './fingerprint.js';
import type { DataFingerprintInput } from './fingerprint.js';
import type { EntityFingerprint } from './types.js';

/** Terse fingerprint builder for tests (mirrors diff.test.ts). */
function fp(
  key: string,
  opts: Partial<Omit<EntityFingerprint<number>, 'key'>> = {},
): EntityFingerprint<number> {
  const entity: EntityFingerprint<number> = {
    key,
    ifcType: opts.ifcType ?? 'IfcWall',
    dataHash: opts.dataHash ?? 'd0',
    geometryHash: opts.geometryHash,
    ref: opts.ref ?? 0,
  };
  if (opts.components) entity.components = opts.components;
  return entity;
}

describe('diffModels — matchUnpairedByContent off (default): behaviour unchanged', () => {
  it('a re-GUIDed identical element still reads as plain added + deleted', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('new-guid', { dataHash: 'd1', geometryHash: 100n })];

    const diff = diffModels(base, head);

    expect(diff.byKey.get('old-guid')?.state).toBe('deleted');
    expect(diff.byKey.get('new-guid')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches).toBeUndefined();
  });

  it('produces byte-identical output whether or not matchUnpairedByContent is explicitly false', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n }), fp('kept')];
    const head = [fp('new-guid', { dataHash: 'd1', geometryHash: 100n }), fp('kept')];

    const withoutOption = diffModels(base, head);
    const explicitFalse = diffModels(base, head, { matchUnpairedByContent: false });

    expect(explicitFalse.counts).toEqual(withoutOption.counts);
    expect(explicitFalse.entries.map((e) => [e.key, e.state]).sort()).toEqual(
      withoutOption.entries.map((e) => [e.key, e.state]).sort(),
    );
    expect(explicitFalse.contentMatches).toBeUndefined();
    expect(withoutOption.contentMatches).toBeUndefined();
  });
});

describe('diffModels — matchUnpairedByContent: renamed / moved', () => {
  it('pairs a re-GUIDed identical element as renamed, not added+deleted', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('new-guid', { dataHash: 'd1', geometryHash: 100n })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // No longer read as a bare added/deleted pair.
    expect(diff.byKey.has('old-guid')).toBe(false);
    expect(diff.byKey.has('new-guid')).toBe(false);
    expect(diff.entries.some((e) => e.key === 'old-guid' || e.key === 'new-guid')).toBe(false);
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });

    // Reported instead as a single renamed content match.
    expect(diff.contentMatches).toHaveLength(1);
    const match = diff.contentMatches?.[0];
    expect(match?.kind).toBe('renamed');
    expect(match?.dataHash).toBe('d1');
    expect(match?.base.map((e) => e.key)).toEqual(['old-guid']);
    expect(match?.head.map((e) => e.key)).toEqual(['new-guid']);
  });

  it('classifies a re-GUIDed element with different geometry as moved, not added+deleted', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('new-guid', { dataHash: 'd1', geometryHash: 200n })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.has('old-guid')).toBe(false);
    expect(diff.byKey.has('new-guid')).toBe(false);
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });

    expect(diff.contentMatches).toHaveLength(1);
    const match = diff.contentMatches?.[0];
    expect(match?.kind).toBe('moved');
    expect(match?.base.map((e) => e.key)).toEqual(['old-guid']);
    expect(match?.head.map((e) => e.key)).toEqual(['new-guid']);
  });

  it('does not content-match entities whose data hash differs (genuinely unrelated add + delete)', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('new-guid', { dataHash: 'd2', geometryHash: 100n })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('old-guid')?.state).toBe('deleted');
    expect(diff.byKey.get('new-guid')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches).toEqual([]);
  });

  it('leaves normally key-matched (unchanged/modified) entities alone', () => {
    const base = [fp('stays', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('stays', { dataHash: 'd1', geometryHash: 100n })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('stays')?.state).toBe('unchanged');
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 1 });
    expect(diff.contentMatches).toEqual([]);
  });
});

describe('diffModels — matchUnpairedByContent: ambiguous groups', () => {
  it('reports a many-to-many content match as a group, not a guessed pairing (regression: #1923-style silent pick)', () => {
    // Two base and two head entities share content hash 'd1' and carry no
    // geometry hash at all, so nothing beyond the data hash distinguishes
    // them: there is no principled 1:1 pairing. (When they *do* agree on a
    // world geometry hash on both sides the group retires instead — see
    // content-match-tiers.test.ts; that is a decision about observational
    // identity, not a guess about which one became which.)
    const base = [
      fp('b1', { dataHash: 'd1', ref: 1 }),
      fp('b2', { dataHash: 'd1', ref: 2 }),
    ];
    const head = [
      fp('h1', { dataHash: 'd1', ref: 11 }),
      fp('h2', { dataHash: 'd1', ref: 12 }),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // Not silently collapsed into a 1:1 match — the plain added/deleted
    // entries for all four survive untouched.
    expect(diff.byKey.get('b1')?.state).toBe('deleted');
    expect(diff.byKey.get('b2')?.state).toBe('deleted');
    expect(diff.byKey.get('h1')?.state).toBe('added');
    expect(diff.byKey.get('h2')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });

    // ...and the ambiguity is surfaced as a group instead.
    expect(diff.contentMatches).toHaveLength(1);
    const group = diff.contentMatches?.[0];
    expect(group?.kind).toBe('ambiguous');
    expect(group?.dataHash).toBe('d1');
    expect(new Set(group?.base.map((e) => e.key))).toEqual(new Set(['b1', 'b2']));
    expect(new Set(group?.head.map((e) => e.key))).toEqual(new Set(['h1', 'h2']));
  });

  it('reports one base matching several heads as "duplicated"', () => {
    const base = [fp('b1', { dataHash: 'd1', ref: 1 })];
    const head = [
      fp('h1', { dataHash: 'd1', ref: 11 }),
      fp('h2', { dataHash: 'd1', ref: 12 }),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('b1')?.state).toBe('deleted');
    expect(diff.byKey.get('h1')?.state).toBe('added');
    expect(diff.byKey.get('h2')?.state).toBe('added');
    expect(diff.contentMatches).toHaveLength(1);
    expect(diff.contentMatches?.[0]).toMatchObject({ kind: 'duplicated', dataHash: 'd1' });
    expect(diff.contentMatches?.[0]?.base.map((e) => e.key)).toEqual(['b1']);
    expect(new Set(diff.contentMatches?.[0]?.head.map((e) => e.key))).toEqual(new Set(['h1', 'h2']));
  });

  it('reports several bases matching one head as "deduplicated"', () => {
    const base = [
      fp('b1', { dataHash: 'd1', ref: 1 }),
      fp('b2', { dataHash: 'd1', ref: 2 }),
    ];
    const head = [fp('h1', { dataHash: 'd1', ref: 11 })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('b1')?.state).toBe('deleted');
    expect(diff.byKey.get('b2')?.state).toBe('deleted');
    expect(diff.byKey.get('h1')?.state).toBe('added');
    expect(diff.contentMatches).toHaveLength(1);
    expect(diff.contentMatches?.[0]).toMatchObject({ kind: 'deduplicated', dataHash: 'd1' });
    expect(new Set(diff.contentMatches?.[0]?.base.map((e) => e.key))).toEqual(new Set(['b1', 'b2']));
    expect(diff.contentMatches?.[0]?.head.map((e) => e.key)).toEqual(['h1']);
  });
});

/**
 * `dataHash` is a 64-bit FNV-1a hex string (`stableHash`, `fingerprint.ts`),
 * widened from 32 bits in issue #1962 precisely because this pass treats hash
 * equality as identity: the 1:1 branch is the only destructive path, retiring
 * a real `added` and a real `deleted` in favour of one match record, and its
 * exposure grows with the square of the number of distinct fingerprints
 * compared. At 32 bits collisions between plausible IFC content were findable
 * by enumeration; at 64 they are not. They are still not impossible — FNV-1a
 * is a drift-catching hash, not a cryptographic one — so the guards stay, and
 * so does their coverage here.
 *
 * These tests set `dataHash` on the fingerprints directly instead of hunting
 * for inputs that happen to collide. What the engine does *when* two hashes
 * are equal is independent of how likely that is, and a found-collision
 * fixture stops testing anything the moment the hash changes — which is
 * exactly what happened to the three 32-bit fixtures these replaced.
 *
 * Both guards are *sound* — neither can reject a real match:
 * `buildDataFingerprint` already folds `ifcType` into the hashed payload, and
 * `buildComponentFingerprints` hashes slices of the same content. Identical
 * content therefore always agrees on both; disagreement proves a collision.
 *
 * Neither guard makes the pass collision-proof, and the last test here pins
 * the limit rather than leaving it implied. FNV-1a's per-character update
 * (`h = (h ^ c) * prime`) is a bijection on its state at any width, so for two
 * entities differing only inside `attr:core` — a different `Name`, everything
 * else equal — the whole-payload strings are `prefix + name + identical
 * suffix`, and a `dataHash` collision *implies* an `attr:core` collision.
 * Widening does not change that implication, only how unlikely its premise is.
 * The component guard can only catch a collision whose differing content lands
 * in a different slice (a pset, a qset), where the sub-hash is computed over
 * an unrelated string.
 */
describe('diffModels — content matching does not trust the data hash alone', () => {
  /** Stand-in for a hash collision: two different entities, one `dataHash`. */
  const COLLIDING = 'c011ded0c011ded0';

  /**
   * Two walls differing only inside `Pset_WallCommon`. Their real `dataHash`
   * values differ; the tests below override that to simulate a collision, but
   * `components` stay genuinely derived, so `pset:Pset_WallCommon` really does
   * disagree the way a caught collision would.
   */
  const wallWithReference = (reference: string): DataFingerprintInput => ({
    ifcType: 'IfcWall',
    name: 'Wall',
    propertySets: [
      { name: 'Pset_WallCommon', properties: [{ name: 'Reference', value: reference }] },
    ],
  });
  const PSET_A = wallWithReference('R-1129599');
  const PSET_B = wallWithReference('R-1732382');

  /** Two walls differing only in `Name`, i.e. only inside `attr:core`. */
  const NAME_A: DataFingerprintInput = { ifcType: 'IfcWall', name: 'W-129599' };
  const NAME_B: DataFingerprintInput = { ifcType: 'IfcWall', name: 'W-732382' };

  function fromInput(key: string, input: DataFingerprintInput, withComponents = false) {
    const entity = fp(key, { ifcType: input.ifcType, dataHash: buildDataFingerprint(input) });
    if (withComponents) entity.components = buildComponentFingerprints(input);
    return entity;
  }

  it('the pset fixtures differ in exactly one component sub-hash', () => {
    // Guards the two tests below: the simulated collision is only interesting
    // if `pset:Pset_WallCommon` is what disagrees and nothing else does.
    const a = buildComponentFingerprints(PSET_A);
    const b = buildComponentFingerprints(PSET_B);
    expect(Object.keys(a)).toEqual(Object.keys(b));
    const differing = Object.keys(a).filter((key) => a[key] !== b[key]);
    expect(differing).toEqual(['pset:Pset_WallCommon']);
  });

  it('does not pair two entities of different ifcType that share a dataHash', () => {
    const base = [fp('wall-guid', { ifcType: 'IfcWall', dataHash: COLLIDING })];
    const head = [fp('door-guid', { ifcType: 'IfcDoor', dataHash: COLLIDING })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('wall-guid')?.state).toBe('deleted');
    expect(diff.byKey.get('door-guid')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches ?? []).toEqual([]);
  });

  it('does not pair same-type entities sharing a dataHash whose component sub-hashes disagree', () => {
    const base = [
      fp('a-guid', {
        ifcType: 'IfcWall',
        dataHash: COLLIDING,
        components: buildComponentFingerprints(PSET_A),
      }),
    ];
    const head = [
      fp('b-guid', {
        ifcType: 'IfcWall',
        dataHash: COLLIDING,
        components: buildComponentFingerprints(PSET_B),
      }),
    ];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('a-guid')?.state).toBe('deleted');
    expect(diff.byKey.get('b-guid')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches ?? []).toEqual([]);
  });

  it('pairs the same colliding entities when no components are supplied (the guard needs them)', () => {
    const base = [fp('a-guid', { ifcType: 'IfcWall', dataHash: COLLIDING })];
    const head = [fp('b-guid', { ifcType: 'IfcWall', dataHash: COLLIDING })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
  });

  it('KNOWN LIMIT: a collision confined to attr:core is not detectable and still pairs', () => {
    // Both sides carry the SAME component map on purpose. That is not a
    // convenience: for a difference confined to `attr:core`, a `dataHash`
    // collision implies an `attr:core` collision (the bijection argument
    // above) and every other slice is equal by hypothesis, so agreeing
    // components are what such a collision necessarily looks like.
    const components = buildComponentFingerprints(NAME_A);
    const base = [fp('a-guid', { ifcType: 'IfcWall', dataHash: COLLIDING, components })];
    const head = [fp('b-guid', { ifcType: 'IfcWall', dataHash: COLLIDING, components })];

    // The two entities really are different content...
    expect(buildDataFingerprint(NAME_A)).not.toBe(buildDataFingerprint(NAME_B));

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // ...and nothing here can tell them apart: documented, not endorsed.
    // Widening `stableHash` made the premise far less likely; it did not
    // remove the limit.
    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
  });

  it('still pairs a genuine re-GUID whose components agree', () => {
    const wall: DataFingerprintInput = {
      ifcType: 'IfcWall',
      name: 'Wall-A',
      propertySets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }],
    };
    const base = [fromInput('old-guid', wall, true)];
    const head = [fromInput('new-guid', wall, true)];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.contentMatches).toHaveLength(1);
    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
  });

  it('pairs a TYPED element whose assigned type was re-GUIDed too, components and all', () => {
    // The whole re-export scenario, end to end: `IfcTypeObject` is an
    // `IfcRoot`, so a from-scratch re-export regenerates the *type's* GlobalId
    // alongside the element's. Typed elements are most of a real model, so if
    // either the bucket key (`dataHash`) or the collision guard
    // (`componentsAgree`, via the `type-assignment` sub-hash) folded in the
    // type's GlobalId, this pass would fail on the majority of the model it
    // exists to rescue. Both must ignore it, which is why they share one
    // projection.
    const typed = (typeGuid: string): DataFingerprintInput => ({
      ifcType: 'IfcWall',
      name: 'Wall-A',
      propertySets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }],
      typeAssignments: [{ globalId: typeGuid, name: 'WT-200', type: 'IfcWallType' }],
    });
    const before = typed('0aBc$before000000000001');
    const after = typed('3xYz_after0000000000002');

    const diff = diffModels([fromInput('old-guid', before, true)], [fromInput('new-guid', after, true)], {
      matchUnpairedByContent: true,
    });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.contentMatches).toHaveLength(1);
    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');

    // ...and it paired because the guard abstained on an agreeing sub-hash,
    // not because components were withheld. Asserted after the outcome so a
    // regression reports the behaviour that broke, not just its cause.
    expect(fromInput('new-guid', after, true).components).toBeDefined();
    expect(buildComponentFingerprints(after)['type-assignment']).toBe(
      buildComponentFingerprints(before)['type-assignment'],
    );
  });

  it('still refuses a pair whose assigned type genuinely differs by name', () => {
    // The guard keeps its teeth on the axis that survived: a different type
    // *name* is real content, so these do not share a `dataHash` at all and
    // never reach the same bucket.
    const typed = (typeName: string): DataFingerprintInput => ({
      ifcType: 'IfcWall',
      name: 'Wall-A',
      typeAssignments: [{ globalId: 'same-guid', name: typeName, type: 'IfcWallType' }],
    });
    const base = [fromInput('old-guid', typed('WT-200'), true)];
    const head = [fromInput('new-guid', typed('WT-300'), true)];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('old-guid')?.state).toBe('deleted');
    expect(diff.byKey.get('new-guid')?.state).toBe('added');
    expect(diff.contentMatches ?? []).toEqual([]);
  });
});

describe('diffModels — content matching honours the selected scope', () => {
  it('classifies a data-scope content match as "renamed" even when geometry differs', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('new-guid', { dataHash: 'd1', geometryHash: 200n })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true, scope: 'data' });

    expect(diff.contentMatches).toHaveLength(1);
    // Geometry is excluded from the comparison, so a geometry-derived "moved"
    // would report a difference the caller explicitly opted out of seeing.
    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
  });

  it('still reports "moved" under the default both-scope', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('new-guid', { dataHash: 'd1', geometryHash: 200n })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('moved');
  });

  it('still reports "moved" under geometry scope, where geometry is in scope', () => {
    const base = [fp('old-guid', { dataHash: 'd1', geometryHash: 100n })];
    const head = [fp('new-guid', { dataHash: 'd1', geometryHash: 200n })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true, scope: 'geometry' });

    expect(diff.contentMatches?.[0]?.kind).toBe('moved');
  });
});
