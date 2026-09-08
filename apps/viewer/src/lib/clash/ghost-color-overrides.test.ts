/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PR #2574, maintainer follow-up (louistrue, 2026-08-13): `useClash.ts`'s
 * `focusClash` ghosts the whole model for the clash-solid presentation, then
 * restores the caller's lens/Pset/IDS colour overrides verbatim
 * (`s.setPendingColorUpdates(s.lensAppliedColors ?? new Map())`). With any
 * lens active, that non-empty map reaches `scene.setColorOverrides`, and the
 * renderer promotes every overridden entity — including the two clash
 * parents — to the opaque, depth-writing pipeline
 * (`packages/renderer/src/overlay-routing.ts`,
 * `OVERRIDE_PROMOTION_MIN_ALPHA`). `ghostExceptIds` only supplies alpha
 * through the transparent-pipeline path and does not survive that
 * promotion, so the ghosting is silently defeated and the solid renders
 * behind opaque geometry — invisible, while the panel reports a volume.
 *
 * `restoreOverridesForGhosting` is the fix: it filters the restored map down
 * to entities NOT covered by the ghost (`ghostExceptEntities`'s members),
 * so the ghost tier always wins over a lens override for the duration of the
 * solid presentation. `focusClash` ghosts the ENTIRE model
 * (`setGhostExceptEntities(new Set())`), so today this collapses to an empty
 * map — which is exactly the input `useGeometryStreaming.ts`'s
 * `pendingColorUpdates.size === 0` branch already handles correctly
 * (`scene.clearColorOverrides()`), the same path taken when no lens was
 * active at all. The function is written generally (against the "except"
 * set, not hardcoded to "whole model") so a future partial-ghost
 * presentation keeps working without another trace through the renderer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { restoreOverridesForGhosting } from './ghost-color-overrides.js';

describe('restoreOverridesForGhosting (#2574 lens-vs-ghost promotion)', () => {
  it('no ghosting active (solid dismissed): the lens map is restored unchanged', () => {
    const lens = new Map<number, [number, number, number, number]>([
      [10, [1, 0.6, 0, 1]],
      [20, [0, 0.8, 1, 1]],
    ]);
    const out = restoreOverridesForGhosting(lens, null);
    assert.deepEqual([...out.entries()].sort(), [...lens.entries()].sort());
  });

  it('no lens active, no ghosting: restoring an empty map stays empty', () => {
    const out = restoreOverridesForGhosting(new Map(), null);
    assert.equal(out.size, 0);
  });

  it('no lens active, full-model ghost active (today\'s solid presentation): still empty, unaffected by the fix', () => {
    const out = restoreOverridesForGhosting(new Map(), new Set());
    assert.equal(out.size, 0);
  });

  it('THE DEFECT: a lens active + full-model ghost (clash solid shown) must drop every override, not restore it verbatim', () => {
    const lens = new Map<number, [number, number, number, number]>([
      [10, [1, 0.6, 0, 1]], // e.g. the clash's own parent, still lens-coloured
      [20, [0, 0.8, 1, 1]],
    ]);
    // focusClash ghosts the whole model: `setGhostExceptEntities(new Set())`.
    const out = restoreOverridesForGhosting(lens, new Set());
    assert.equal(
      out.size,
      0,
      'a non-empty result here reaches scene.setColorOverrides and promotes every ' +
        'entry to the opaque pipeline, defeating the ghost that was just applied ' +
        '(the exact bug louistrue traced through the renderer on #2574)',
    );
  });

  it('a PARTIAL ghost (future presentation that exempts some ids) keeps only the exempted overrides', () => {
    const lens = new Map<number, [number, number, number, number]>([
      [10, [1, 0.6, 0, 1]], // exempted from ghosting: must survive
      [20, [0, 0.8, 1, 1]], // ghosted: must be dropped
      [30, [0, 1, 0, 1]],   // ghosted: must be dropped
    ]);
    const exempt = new Set([10]);
    const out = restoreOverridesForGhosting(lens, exempt);
    assert.deepEqual([...out.keys()], [10]);
    assert.deepEqual(out.get(10), [1, 0.6, 0, 1]);
  });

  it('the returned map is a fresh copy, not aliasing the input map', () => {
    const lens = new Map<number, [number, number, number, number]>([[10, [1, 0.6, 0, 1]]]);
    const out = restoreOverridesForGhosting(lens, null);
    assert.notEqual(out, lens);
    out.set(99, [0, 0, 0, 1]);
    assert.equal(lens.has(99), false, 'mutating the returned map must not leak back into the source map');
  });
});
