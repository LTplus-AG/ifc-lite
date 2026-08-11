/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  diffModels,
  type ContentMatch,
  type ContentMatchKind,
  type DiffEntry,
  type DiffState,
  type EntityFingerprint,
  type ModelDiff,
} from '@ifc-lite/diff';
import { buildCompareOverlay, COMPARE_COLORS } from './overlay.js';
import type { CompareRef } from './buildFingerprints.js';

function ref(globalId: number): CompareRef {
  // modelId/localId are irrelevant to the overlay (it keys on globalId).
  return { modelId: 'm', localId: globalId, globalId };
}

function entry(
  state: DiffState,
  opts: { base?: number; head?: number; changeKinds?: ('data' | 'geometry')[] } = {},
): DiffEntry<CompareRef> {
  return {
    key: `${state}:${opts.base ?? ''}:${opts.head ?? ''}`,
    state,
    changeKinds: opts.changeKinds ?? [],
    base: opts.base !== undefined ? ({ key: '', ifcType: '', dataHash: '', ref: ref(opts.base) }) : undefined,
    head: opts.head !== undefined ? ({ key: '', ifcType: '', dataHash: '', ref: ref(opts.head) }) : undefined,
  };
}

function diffOf(
  entries: DiffEntry<CompareRef>[],
  contentMatches?: ContentMatch<CompareRef>[],
): ModelDiff<CompareRef> {
  // buildCompareOverlay only reads `entries` + `contentMatches`; the rest
  // satisfies the type.
  return { scope: 'both', excludedTypes: [], entries, byKey: new Map(), counts: { added: 0, modified: 0, deleted: 0, unchanged: 0 }, contentMatches };
}

/** A content match over federation global ids. The engine retires a matched
 *  pair's add/delete entries, so a match's entities are NOT in `entries` -
 *  which is exactly why the overlay has to look at `contentMatches` too. */
function match(
  kind: ContentMatchKind,
  base: number[],
  head: number[],
): ContentMatch<CompareRef> {
  const fp = (globalId: number) => ({ key: `k${globalId}`, ifcType: 'IfcWall', dataHash: 'd', ref: ref(globalId) });
  return { kind, dataHash: 'd', base: base.map(fp), head: head.map(fp) };
}

describe('buildCompareOverlay', () => {
  it('colours added on the head, with nothing hidden', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([entry('added', { head: 10 })]), false);
    assert.deepStrictEqual(colorOverrides.get(10), COMPARE_COLORS.added);
    assert.strictEqual(hiddenIds.size, 0);
  });

  it('colours deleted on the base (it only exists in A)', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([entry('deleted', { base: 5 })]), false);
    assert.deepStrictEqual(colorOverrides.get(5), COMPARE_COLORS.deleted);
    assert.strictEqual(hiddenIds.size, 0);
  });

  it('colours modified on the head and hides the base copy', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([entry('modified', { base: 5, head: 1005, changeKinds: ['geometry'] })]),
      false,
    );
    assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.modified);
    assert.ok(!colorOverrides.has(5), 'base copy is not coloured');
    assert.ok(hiddenIds.has(5), 'base copy is hidden to avoid double geometry');
    assert.ok(!hiddenIds.has(1005), 'head copy stays visible');
  });

  it('hides both copies of an unchanged element when not showing unchanged', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([entry('unchanged', { base: 5, head: 1005 })]),
      false,
    );
    assert.strictEqual(colorOverrides.size, 0);
    assert.deepStrictEqual([...hiddenIds].sort((a, b) => a - b), [5, 1005]);
  });

  it('ghosts the head and hides the base for unchanged when showing unchanged', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([entry('unchanged', { base: 5, head: 1005 })]),
      true,
    );
    assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.unchanged);
    assert.ok(hiddenIds.has(5), 'base duplicate hidden');
    assert.ok(!hiddenIds.has(1005), 'ghosted head stays visible');
  });

  it('composes a mixed diff without cross-contaminating colours/visibility', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([
        entry('added', { head: 1001 }),
        entry('deleted', { base: 2 }),
        entry('modified', { base: 3, head: 1003 }),
        entry('unchanged', { base: 4, head: 1004 }),
      ]),
      false,
    );
    assert.deepStrictEqual(colorOverrides.get(1001), COMPARE_COLORS.added);
    assert.deepStrictEqual(colorOverrides.get(2), COMPARE_COLORS.deleted);
    assert.deepStrictEqual(colorOverrides.get(1003), COMPARE_COLORS.modified);
    // modified base + both unchanged copies are hidden; added/deleted are not.
    assert.deepStrictEqual([...hiddenIds].sort((a, b) => a - b), [3, 4, 1004]);
  });

  it('skips entries that carry no usable ref', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([entry('added', {})]), false);
    assert.strictEqual(colorOverrides.size, 0);
    assert.strictEqual(hiddenIds.size, 0);
  });

  it('hides blacklisted (excluded) ids without colouring them (#1470)', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([entry('added', { head: 1001 })]),
      false,
      new Set([7, 1007]),
    );
    // The real change is still coloured...
    assert.deepStrictEqual(colorOverrides.get(1001), COMPARE_COLORS.added);
    // ...and the excluded copies are hidden, not coloured.
    assert.ok(!colorOverrides.has(7) && !colorOverrides.has(1007), 'excluded ids not coloured');
    assert.deepStrictEqual([...hiddenIds].sort((a, b) => a - b), [7, 1007]);
  });

  it('keeps excluded ids hidden even when showing unchanged', () => {
    const { hiddenIds } = buildCompareOverlay(
      diffOf([entry('unchanged', { base: 5, head: 1005 })]),
      true,
      new Set([9]),
    );
    assert.ok(hiddenIds.has(9), 'excluded id stays hidden regardless of showUnchanged');
  });
});

describe('buildCompareOverlay - content matches (#1891)', () => {
  for (const kind of ['renamed', 'moved', 'reshaped'] as const) {
    it(`hides the A copy and gives the B copy the matched colour (${kind})`, () => {
      const { colorOverrides, hiddenIds } = buildCompareOverlay(
        diffOf([], [match(kind, [5], [1005])]),
        false,
      );
      assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.matched);
      assert.ok(!colorOverrides.has(5), 'the retired base copy is not coloured');
      assert.ok(hiddenIds.has(5), 'the retired base copy must be hidden, not stranded at full colour');
      assert.ok(!hiddenIds.has(1005), 'the surviving head copy stays visible');
    });
  }

  it('handles an N:N renamed group, hiding every A copy', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([], [match('renamed', [1, 2, 3], [1001, 1002, 1003])]),
      false,
    );
    assert.deepStrictEqual([...hiddenIds].sort((a, b) => a - b), [1, 2, 3]);
    for (const id of [1001, 1002, 1003]) {
      assert.deepStrictEqual(colorOverrides.get(id), COMPARE_COLORS.matched);
    }
  });

  for (const kind of ['ambiguous', 'duplicated', 'deduplicated'] as const) {
    it(`leaves an unresolved group's add/delete colours alone (${kind})`, () => {
      // These retire nothing, so their entries are still in `entries` with
      // their own colours. Recolouring or hiding them here would claim a
      // resolution the engine explicitly declined to make.
      const { colorOverrides, hiddenIds } = buildCompareOverlay(
        diffOf(
          [entry('deleted', { base: 5 }), entry('added', { head: 1005 })],
          [match(kind, [5], [1005])],
        ),
        false,
      );
      assert.deepStrictEqual(colorOverrides.get(5), COMPARE_COLORS.deleted);
      assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.added);
      assert.strictEqual(hiddenIds.size, 0);
    });
  }

  it('composes matches with ordinary entries and the excluded set', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf(
        [entry('added', { head: 1001 }), entry('modified', { base: 3, head: 1003 })],
        [match('renamed', [5], [1005])],
      ),
      false,
      new Set([7]),
    );
    assert.deepStrictEqual(colorOverrides.get(1001), COMPARE_COLORS.added);
    assert.deepStrictEqual(colorOverrides.get(1003), COMPARE_COLORS.modified);
    assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.matched);
    assert.deepStrictEqual([...hiddenIds].sort((a, b) => a - b), [3, 5, 7]);
  });

  it('is a no-op when the content pass did not run', () => {
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([entry('added', { head: 1001 })]),
      false,
    );
    assert.strictEqual(colorOverrides.size, 1);
    assert.strictEqual(hiddenIds.size, 0);
  });
});

describe('buildCompareOverlay - a modified element with no geometry on the head side', () => {
  /** A modified entry whose head copy is explicitly NOT drawable — the shape a
   *  revision produces when it strips an element's Representation, and the
   *  shape every geometry-less product compared on its data alone has. */
  function unmeshedHead(base: number, head: number): DiffEntry<CompareRef> {
    const e = entry('modified', { base, head, changeKinds: ['geometry'] });
    e.head!.ref = { ...e.head!.ref, meshed: false };
    return e;
  }

  it('marks the base copy and hides nothing, so the change is still on screen', () => {
    // Without this the element is drawn NOWHERE: the yellow goes to a head id
    // the renderer has no mesh for, and the only drawable copy — the base one —
    // is hidden. Before geometry-less products were compared at all, this
    // element read as `deleted` and was at least painted red; turning that into
    // an invisible `modified` would be a widening that lost information.
    const { colorOverrides, hiddenIds } = buildCompareOverlay(
      diffOf([unmeshedHead(5, 1005)]),
      false,
    );
    assert.deepStrictEqual(colorOverrides.get(5), COMPARE_COLORS.modified);
    assert.ok(!colorOverrides.has(1005), 'the un-drawable head copy is not coloured');
    assert.ok(!hiddenIds.has(5), 'the only drawable copy must stay visible');
  });

  it('still hides the base copy when the head copy IS drawable', () => {
    // The control for the branch above: `meshed: true` must behave exactly as
    // an untouched entry does, or the fix would have disabled the duplicate
    // suppression the overlay exists for.
    const e = entry('modified', { base: 5, head: 1005, changeKinds: ['geometry'] });
    e.head!.ref = { ...e.head!.ref, meshed: true };
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([e]), false);
    assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.modified);
    assert.ok(hiddenIds.has(5), 'base copy is hidden to avoid double geometry');
  });

  it('treats an omitted `meshed` as drawable, so no existing caller changes', () => {
    // `meshed` is optional and read as "drawable unless explicitly false".
    // A ref built without it — every hand-built ref in this file, and any
    // caller predating the field — must keep the original behaviour.
    const e = entry('modified', { base: 5, head: 1005, changeKinds: ['geometry'] });
    assert.strictEqual(e.head!.ref.meshed, undefined, 'the fixture must omit the flag');
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([e]), false);
    assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.modified);
    assert.ok(hiddenIds.has(5));
  });
});

describe('buildCompareOverlay - the drawable-copy rule holds on EVERY hide-A-colour-B site (review find)', () => {
  // The `meshed !== false` guard exists because "hide A, colour B" rests on B
  // being DRAWABLE. The `unchanged`+showUnchanged branch and the content-match
  // retiring loop apply the identical rule, so guarding only `modified` left
  // two ways for an element's only drawable copy to be hidden.

  it('unchanged + showUnchanged with an unmeshed head ghosts the base and hides nothing', () => {
    // Scope='data' of a pair where the head revision stripped the element's
    // Representation but its data is identical: the widened enumeration puts
    // it in head's fingerprints, so it classifies `unchanged` instead of
    // `deleted`. Hiding globalId(base) — the only drawable copy — while
    // ghosting an undrawable head erases the element from the scene.
    const e = entry('unchanged', { base: 5, head: 1005 });
    e.head!.ref = { ...e.head!.ref, meshed: false };
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([e]), true);
    assert.ok(!hiddenIds.has(5), 'the only drawable copy must stay visible');
    assert.deepStrictEqual(colorOverrides.get(5), COMPARE_COLORS.unchanged);
    assert.ok(!colorOverrides.has(1005), 'the un-drawable head copy is not coloured');
  });

  it('unchanged + showUnchanged with a meshed head keeps the original ghosting (control)', () => {
    const e = entry('unchanged', { base: 5, head: 1005 });
    e.head!.ref = { ...e.head!.ref, meshed: true };
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([e]), true);
    assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.unchanged);
    assert.ok(hiddenIds.has(5), 'base duplicate hidden');
  });

  it('a retiring content match with an unmeshed head marks the base and hides nothing', () => {
    // A base-meshed element re-GUIDed and Representation-stripped in head is
    // retired as `renamed` by content matching under data scope. Hiding the
    // base copy while colouring a head id the renderer has no mesh for erased
    // it from the scene; pre-widening it at least rendered red as `deleted`.
    const m = match('renamed', [5], [1005]);
    m.head[0]!.ref = { ...m.head[0]!.ref, meshed: false };
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([], [m]), false);
    assert.ok(!hiddenIds.has(5), 'the only drawable copy must stay visible');
    assert.deepStrictEqual(colorOverrides.get(5), COMPARE_COLORS.matched);
    assert.ok(!colorOverrides.has(1005), 'the un-drawable head copy is not coloured');
  });

  it('a retiring content match with a meshed head keeps the original suppression (control)', () => {
    const m = match('renamed', [5], [1005]);
    m.head[0]!.ref = { ...m.head[0]!.ref, meshed: true };
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diffOf([], [m]), false);
    assert.deepStrictEqual(colorOverrides.get(1005), COMPARE_COLORS.matched);
    assert.ok(hiddenIds.has(5));
  });

  it('unchanged without showUnchanged still hides both copies whatever `meshed` says', () => {
    // Hiding is the POINT there — an invisible unchanged element is the
    // requested rendering, not a lost one.
    const e = entry('unchanged', { base: 5, head: 1005 });
    e.head!.ref = { ...e.head!.ref, meshed: false };
    const { hiddenIds } = buildCompareOverlay(diffOf([e]), false);
    assert.deepStrictEqual([...hiddenIds].sort((a, b) => a - b), [5, 1005]);
  });
});

describe('scenario: base-meshed element, head Representation stripped, data scope (review find)', () => {
  // The end-to-end shape of the review's failure scenario, run through the
  // REAL engine rather than a hand-built diff: under scope='data' the engine
  // ignores geometry, so the pair below is not `deleted` — and the overlay
  // must then keep its one drawable copy on screen.
  const sideFp = (
    key: string,
    globalId: number,
    withMesh: boolean,
  ): EntityFingerprint<CompareRef> => ({
    key,
    ifcType: 'IfcWall',
    dataHash: 'd',
    ...(withMesh ? { geometryHash: 7n } : {}),
    ref: { modelId: withMesh ? 'A' : 'B', localId: 1, globalId, meshed: withMesh },
  });

  it('classifies unchanged, and showUnchanged does not erase it from the scene', () => {
    const diff = diffModels([sideFp('G1', 5, true)], [sideFp('G1', 1005, false)], {
      scope: 'data',
    });
    assert.strictEqual(diff.entries.length, 1);
    assert.strictEqual(diff.entries[0]!.state, 'unchanged', 'data scope must ignore geometry');
    const { hiddenIds } = buildCompareOverlay(diff, true);
    assert.ok(!hiddenIds.has(5), 'the only drawable copy must stay visible');
  });

  it('a re-GUIDed pair retires as a content match, and the base copy stays on screen', () => {
    const diff = diffModels([sideFp('G1', 5, true)], [sideFp('G2', 1005, false)], {
      scope: 'data',
      matchUnpairedByContent: true,
    });
    const retiring = (diff.contentMatches ?? []).filter((m) => m.kind === 'renamed');
    assert.strictEqual(retiring.length, 1, 'the pair must retire as renamed under data scope');
    const { colorOverrides, hiddenIds } = buildCompareOverlay(diff, false);
    assert.ok(!hiddenIds.has(5), 'the only drawable copy must stay visible');
    assert.deepStrictEqual(colorOverrides.get(5), COMPARE_COLORS.matched);
  });
});
