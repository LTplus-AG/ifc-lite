/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4129: `transparencyOverrides` names ENTITIES, so resolution and the batch
 * partition that carries it to the GPU have to be per entity. These are the
 * pure halves — the draw path that consumes them is pinned end-to-end in
 * renderer-render-paths.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { XRayAlpha, XRayEpochTracker, MAX_ALPHA_GROUPS_PER_BATCH, type AlphaBatchLike } from './xray-alpha.js';
import { DEFAULT_GHOST_ALPHA } from './overlay-routing.js';
import type { RenderOptions } from './types.js';

const NONE: ReadonlySet<number> = new Set<number>();

/** A grey, fully opaque batch holding `ids` — the roof-slab shape from #4129. */
function batchOf(...ids: number[]): AlphaBatchLike {
    return { expressIds: ids, color: [0.5, 0.5, 0.5, 1] };
}

function groupAlphas(groups: { alpha: number; ids: Set<number> }[] | null): [number, number[]][] {
    assert.ok(groups != null, 'expected a split');
    return groups.map((g) => [g.alpha, [...g.ids].sort((a, b) => a - b)]);
}

describe('XRayAlpha resolves alpha per entity', () => {
    it('fades the named entity and leaves its colour batchmates alone (#4129)', () => {
        const xray = new XRayAlpha({ transparencyOverrides: new Map([[1, 0.18]]) }, NONE);
        assert.strictEqual(xray.forEntity(1, 1), 0.18);
        assert.strictEqual(xray.forEntity(2, 1), 1, 'a batchmate the caller never named stays solid');
        assert.deepStrictEqual(groupAlphas(xray.groupsForBatch(batchOf(1, 2), 1)), [
            [0.18, [1]],
            [1, [2]],
        ]);
    });

    it('leaves a batch whose entities all resolve alike unsplit', () => {
        const xray = new XRayAlpha({ transparencyOverrides: new Map([[1, 0.18], [2, 0.18]]) }, NONE);
        assert.strictEqual(xray.groupsForBatch(batchOf(1, 2), 1), null, 'nothing to gain from a split');
        assert.strictEqual(xray.forBatch(batchOf(1, 2), 1), 0.18);
    });

    it('is inert with no override and no ghost set', () => {
        const xray = new XRayAlpha({}, NONE);
        assert.strictEqual(xray.active, false);
        assert.strictEqual(xray.forEntity(1, 0.3), 0.3);
        assert.strictEqual(xray.forBatch(batchOf(1, 2), 0.3), 0.3);
        assert.strictEqual(xray.groupsForBatch(batchOf(1, 2), 0.3), null);
    });

    it('exempts selected entities, so a selected id joins the un-faded group', () => {
        const overrides = new Map([[1, 0.18], [2, 0.18]]);
        const xray = new XRayAlpha({ transparencyOverrides: overrides }, new Set([2]));
        assert.strictEqual(xray.forEntity(2, 1), 1, 'the highlight pass owns a selected entity');
        assert.deepStrictEqual(groupAlphas(xray.groupsForBatch(batchOf(1, 2), 1)), [
            [0.18, [1]],
            [1, [2]],
        ]);
    });

    it('keeps a ghost-excepted entity solid inside a ghosted batch without co-selecting it', () => {
        // Pre-#4129 the excepted id faded with its batch unless it was also in
        // selectedIds — the caveat the clash viewer had to work around.
        const xray = new XRayAlpha({ ghostExceptIds: new Set([2]) }, NONE);
        assert.deepStrictEqual(groupAlphas(xray.groupsForBatch(batchOf(1, 2), 1)), [
            [DEFAULT_GHOST_ALPHA, [1]],
            [1, [2]],
        ]);
    });

    it('does not split a batch that is entirely ghosted', () => {
        const xray = new XRayAlpha({ ghostExceptIds: new Set([99]) }, NONE);
        assert.strictEqual(xray.groupsForBatch(batchOf(1, 2), 1), null);
        assert.strictEqual(xray.forBatch(batchOf(1, 2), 1), DEFAULT_GHOST_ALPHA);
    });

    it('lets an explicit override win over the ghost alpha', () => {
        const xray = new XRayAlpha(
            { ghostExceptIds: new Set([2]), transparencyOverrides: new Map([[1, 0.5]]) },
            NONE,
        );
        assert.deepStrictEqual(groupAlphas(xray.groupsForBatch(batchOf(1, 2, 3), 1)), [
            [DEFAULT_GHOST_ALPHA, [3]],
            [0.5, [1]],
            [1, [2]],
        ]);
    });

    it('falls back to the batch-wide minimum when the distinct alphas exceed the cap', () => {
        const overrides = new Map<number, number>();
        const ids: number[] = [];
        for (let i = 0; i <= MAX_ALPHA_GROUPS_PER_BATCH; i++) {
            overrides.set(i + 1, 0.1 + i * 0.05);
            ids.push(i + 1);
        }
        const xray = new XRayAlpha({ transparencyOverrides: overrides }, NONE);
        assert.strictEqual(xray.groupsForBatch(batchOf(...ids), 1), null, 'too many sub-batches to be worth it');
        assert.strictEqual(xray.forBatch(batchOf(...ids), 1), 0.1, 'whole batch takes the minimum');
    });

    it('resolves the fallback-path minimum over overridden ids only', () => {
        // A glass batch (native alpha 0.3) with one id pushed to 0.8: the id
        // that carries no entry must not drag the minimum up to its own colour.
        const xray = new XRayAlpha({ transparencyOverrides: new Map([[1, 0.8]]) }, NONE);
        assert.strictEqual(xray.forBatch({ expressIds: [1, 2], color: [0, 0, 0, 0.3] }, 0.3), 0.8);
        // …and each split group still resolves to its own alpha.
        assert.deepStrictEqual(groupAlphas(xray.groupsForIds([1, 2], 0.3)), [
            [0.3, [2]],
            [0.8, [1]],
        ]);
    });

    it('groups an arbitrary id subset (the visible subset of a hidden-filtered batch)', () => {
        const xray = new XRayAlpha({ transparencyOverrides: new Map([[1, 0.18], [3, 0.18]]) }, NONE);
        assert.deepStrictEqual(groupAlphas(xray.groupsForIds([2, 3], 1)), [
            [0.18, [3]],
            [1, [2]],
        ]);
    });

    it('snapshots the caller map, so a mid-frame mutation cannot desync a frame', () => {
        const overrides = new Map([[1, 0.18]]);
        const xray = new XRayAlpha({ transparencyOverrides: overrides }, NONE);
        overrides.set(2, 0.18);
        overrides.delete(1);
        assert.strictEqual(xray.forEntity(1, 1), 0.18);
        assert.strictEqual(xray.forEntity(2, 1), 1);
    });
});

describe('XRayEpochTracker invalidates the sub-batch cache by CONTENT', () => {
    const tracker = () => new XRayEpochTracker();

    it('does not bump for a fresh Map with identical content', () => {
        const t = tracker();
        const v = t.update({ transparencyOverrides: new Map([[1, 0.18]]) });
        assert.strictEqual(t.update({ transparencyOverrides: new Map([[1, 0.18]]) }), v);
    });

    it('bumps when an alpha changes for the same id', () => {
        const t = tracker();
        const v = t.update({ transparencyOverrides: new Map([[1, 0.18]]) });
        assert.notStrictEqual(t.update({ transparencyOverrides: new Map([[1, 0.4]]) }), v);
    });

    it('sees an IN-PLACE mutation of the caller Map', () => {
        const t = tracker();
        const live = new Map([[1, 0.18]]);
        const options: RenderOptions = { transparencyOverrides: live };
        const v = t.update(options);
        live.set(2, 0.18);
        assert.notStrictEqual(t.update(options), v);
    });

    it('treats an empty Map, undefined and null as the same inactive state', () => {
        const t = tracker();
        const v = t.update({});
        assert.strictEqual(t.update({ transparencyOverrides: new Map() }), v);
        assert.strictEqual(t.update({ transparencyOverrides: null }), v);
    });

    it('bumps on a ghost set change and on a ghost alpha change', () => {
        const t = tracker();
        const v0 = t.update({ ghostExceptIds: new Set([1]) });
        const v1 = t.update({ ghostExceptIds: new Set([2]) });
        assert.notStrictEqual(v1, v0);
        assert.strictEqual(t.update({ ghostExceptIds: new Set([2]) }), v1);
        assert.notStrictEqual(t.update({ ghostExceptIds: new Set([2]), ghostAlpha: 0.3 }), v1);
    });

    it('distinguishes an empty ghost set from no ghosting (empty ghosts everything)', () => {
        const t = tracker();
        const v = t.update({});
        assert.notStrictEqual(t.update({ ghostExceptIds: new Set() }), v);
    });
});
