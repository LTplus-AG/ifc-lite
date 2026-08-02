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
    // Two base entities and two head entities all share content hash 'd1':
    // there is no principled 1:1 pairing.
    const base = [
      fp('b1', { dataHash: 'd1', geometryHash: 100n, ref: 1 }),
      fp('b2', { dataHash: 'd1', geometryHash: 100n, ref: 2 }),
    ];
    const head = [
      fp('h1', { dataHash: 'd1', geometryHash: 100n, ref: 11 }),
      fp('h2', { dataHash: 'd1', geometryHash: 100n, ref: 12 }),
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
 * `dataHash` is a 32-bit FNV-1a hex string (`stableHash`, `fingerprint.ts`).
 * Across the tens of thousands of unpaired entities a from-scratch re-export
 * produces, distinct content colliding on 32 bits is not hypothetical — all
 * three pairs below are real collisions, found by enumerating
 * `buildDataFingerprint` over varying names (two pairs) and over a varying
 * pset value (one pair). A collision that lands 1:1 would otherwise be
 * retired from `entries` as a `renamed`/`moved` match, destroying a genuine
 * add and a genuine delete.
 *
 * Both guards below are *sound* — neither can reject a real match:
 * `buildDataFingerprint` already folds `ifcType` into the hashed payload, and
 * `buildComponentFingerprints` hashes slices of the same content. Identical
 * content therefore always agrees on both; disagreement proves a collision.
 *
 * Neither guard makes the pass collision-proof, and the last test here pins
 * the limit rather than leaving it implied. FNV-1a's per-character update
 * (`h = (h ^ c) * prime`) is a bijection on the 32-bit state, so for two
 * entities differing only inside `attr:core` — a different `Name`, everything
 * else equal — the whole-payload strings are `prefix + name + identical
 * suffix`, and a `dataHash` collision *implies* an `attr:core` collision. The
 * component guard can only catch a collision whose differing content lands in
 * a different slice (a pset, a qset), where the sub-hash is computed over an
 * unrelated string. Closing the gap properly means widening `stableHash`,
 * which changes every published fingerprint and is out of scope here.
 */
describe('diffModels — content matching does not trust a 32-bit hash alone', () => {
  /** Real collision across types: both hash to `b4b48be`. */
  const COLLIDING_WALL: DataFingerprintInput = { ifcType: 'IfcWall', name: 'W-168484' };
  const COLLIDING_DOOR: DataFingerprintInput = { ifcType: 'IfcDoor', name: 'D-35800' };

  /**
   * Real collision within one type, both hashing to `36c92241`, with the
   * differing content inside a pset — so `pset:Pset_WallCommon` differs
   * (`c18f26d5` vs `2d7da255`) even though the whole-blob hash agrees.
   */
  const collidingPset = (reference: string): DataFingerprintInput => ({
    ifcType: 'IfcWall',
    name: 'Wall',
    propertySets: [
      { name: 'Pset_WallCommon', properties: [{ name: 'Reference', value: reference }] },
    ],
  });
  const COLLIDING_PSET_A = collidingPset('R-1129599');
  const COLLIDING_PSET_B = collidingPset('R-1732382');

  /** Real collision within one type whose difference is confined to `attr:core`. */
  const COLLIDING_NAME_A: DataFingerprintInput = { ifcType: 'IfcWall', name: 'W-129599' };
  const COLLIDING_NAME_B: DataFingerprintInput = { ifcType: 'IfcWall', name: 'W-732382' };

  function fromInput(key: string, input: DataFingerprintInput, withComponents = false) {
    const entity = fp(key, { ifcType: input.ifcType, dataHash: buildDataFingerprint(input) });
    if (withComponents) entity.components = buildComponentFingerprints(input);
    return entity;
  }

  it('the fixtures really do collide (guards the tests below against a hash change)', () => {
    expect(buildDataFingerprint(COLLIDING_WALL)).toBe(buildDataFingerprint(COLLIDING_DOOR));
    expect(buildDataFingerprint(COLLIDING_PSET_A)).toBe(buildDataFingerprint(COLLIDING_PSET_B));
    expect(buildDataFingerprint(COLLIDING_NAME_A)).toBe(buildDataFingerprint(COLLIDING_NAME_B));
    // The pset collision is detectable because the differing content sits in
    // its own slice; the name-only one is not, for the reason above.
    expect(buildComponentFingerprints(COLLIDING_PSET_A)).not.toEqual(
      buildComponentFingerprints(COLLIDING_PSET_B),
    );
    expect(buildComponentFingerprints(COLLIDING_NAME_A)).toEqual(
      buildComponentFingerprints(COLLIDING_NAME_B),
    );
  });

  it('does not pair two entities of different ifcType that collide on dataHash', () => {
    const base = [fromInput('wall-guid', COLLIDING_WALL)];
    const head = [fromInput('door-guid', COLLIDING_DOOR)];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('wall-guid')?.state).toBe('deleted');
    expect(diff.byKey.get('door-guid')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches ?? []).toEqual([]);
  });

  it('does not pair same-type colliding entities whose component sub-hashes disagree', () => {
    const base = [fromInput('a-guid', COLLIDING_PSET_A, true)];
    const head = [fromInput('b-guid', COLLIDING_PSET_B, true)];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.byKey.get('a-guid')?.state).toBe('deleted');
    expect(diff.byKey.get('b-guid')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches ?? []).toEqual([]);
  });

  it('pairs the same colliding entities when no components are supplied (the guard needs them)', () => {
    const base = [fromInput('a-guid', COLLIDING_PSET_A)];
    const head = [fromInput('b-guid', COLLIDING_PSET_B)];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.contentMatches?.[0]?.kind).toBe('renamed');
  });

  it('KNOWN LIMIT: a collision confined to attr:core is not detectable and still pairs', () => {
    const base = [fromInput('a-guid', COLLIDING_NAME_A, true)];
    const head = [fromInput('b-guid', COLLIDING_NAME_B, true)];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    // Documented, not endorsed: components agree because the sub-hash inherits
    // the colliding FNV state, so nothing here can tell the two apart. Only a
    // wider `stableHash` closes this.
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
