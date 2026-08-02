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
import type { EntityFingerprint } from './types.js';

/** Terse fingerprint builder for tests (mirrors diff.test.ts). */
function fp(
  key: string,
  opts: Partial<Omit<EntityFingerprint<number>, 'key'>> = {},
): EntityFingerprint<number> {
  return {
    key,
    ifcType: opts.ifcType ?? 'IfcWall',
    dataHash: opts.dataHash ?? 'd0',
    geometryHash: opts.geometryHash,
    ref: opts.ref ?? 0,
  };
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
