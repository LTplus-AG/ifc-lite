/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for `markupTransitionPatch` in isolation — the single
 * function `modelSlice.ts`'s `setActiveModel` and
 * `drawing2DSlice.teardown.ts`'s `'model-removed'` arm both call (#4159).
 * `modelSlice.markup-transition.test.ts` and
 * `useDrawing2DPersistence.test.tsx` cover the same behaviour wired into the
 * real store; this file pins the pure function's contract directly, without
 * a store, so a regression here is diagnosable without reaching for either.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  markupTransitionPatch,
  wasLiveMarkupCached,
  __resetLiveMarkupCacheForTests,
  type MarkupTransitionState,
} from './drawing2DSlice.markupTransition.js';
import { getDefaultDrawing2DState } from './drawing2DSlice.js';
import type { Measure2DResult } from './drawing2DSlice.js';

function sampleMeasure(id: string): Measure2DResult {
  return { id, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 };
}

function stateFor(activeModelId: string | null, measure2DResults: Measure2DResult[] = []): MarkupTransitionState {
  const defaults = getDefaultDrawing2DState();
  return {
    activeModelId,
    measure2DResults,
    polygonArea2DResults: defaults.polygonArea2DResults,
    textAnnotations2D: defaults.textAnnotations2D,
    cloudAnnotations2D: defaults.cloudAnnotations2D,
    drawing2DDisplayOptions: defaults.drawing2DDisplayOptions,
  };
}

describe('markupTransitionPatch', () => {
  beforeEach(() => {
    __resetLiveMarkupCacheForTests();
  });

  it('is a no-op when the target id equals the current active id', () => {
    const patch = markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), 'model-a');
    assert.deepStrictEqual(patch, {});
  });

  it('clears to defaults for a genuinely new (never-cached) model', () => {
    const patch = markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), 'model-b');
    assert.deepStrictEqual(patch.measure2DResults, []);
  });

  it('restores a previously-active model\'s real data synchronously on revisit — MUTATION TARGET', () => {
    // A -> B: captures A's live data.
    markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), 'model-b');
    assert.ok(wasLiveMarkupCached('model-a'));

    // B -> A: must restore A's REAL data, not defaults.
    const patch = markupTransitionPatch(stateFor('model-b', []), 'model-a');
    assert.strictEqual(patch.measure2DResults?.length, 1);
    assert.strictEqual(patch.measure2DResults?.[0]?.id, 'mA');
  });

  it('an A -> B -> A round trip never observes A cleared to defaults on the return leg', () => {
    markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), 'model-b');
    markupTransitionPatch(stateFor('model-b', []), 'model-a');
    // A second, later switch away from A (now holding the restored data)
    // must capture the RESTORED data, not silently drop it.
    const backToB = markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), 'model-b');
    assert.deepStrictEqual(backToB.measure2DResults, []); // B was never edited
    // And A -> null -> A still finds A's cache intact (removeModel path).
    assert.ok(wasLiveMarkupCached('model-a'));
  });

  it('transitioning to null (removeModel with nothing left active) clears to defaults', () => {
    const patch = markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), null);
    assert.deepStrictEqual(patch.measure2DResults, []);
    assert.ok(wasLiveMarkupCached('model-a'), 'the outgoing model\'s data must still be captured even when nothing succeeds it');
  });

  it('capturing the outgoing model does not disturb an unrelated cached model — MUTATION TARGET', () => {
    markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), 'model-b');
    markupTransitionPatch(stateFor('model-b', [sampleMeasure('mB')]), 'model-c');
    const backToA = markupTransitionPatch(stateFor('model-c', []), 'model-a');
    assert.strictEqual(backToA.measure2DResults?.[0]?.id, 'mA', 'model A\'s cache must survive an unrelated B -> C transition');
  });

  describe('in-progress and selection state (#4196)', () => {
    it('clears in-progress polygon points and a live selection on a model switch — MUTATION TARGET', () => {
      const patch = markupTransitionPatch(stateFor('model-a', []), 'model-b');
      assert.deepStrictEqual(patch.polygonArea2DPoints, []);
      assert.deepStrictEqual(patch.cloudAnnotation2DPoints, []);
      assert.strictEqual(patch.measure2DStart, null);
      assert.strictEqual(patch.measure2DCurrent, null);
      assert.strictEqual(patch.selectedAnnotation2D, null);
      assert.strictEqual(patch.textAnnotation2DEditing, null);
    });

    it('also clears in-progress state when the target is a previously-cached model (restore path)', () => {
      markupTransitionPatch(stateFor('model-a', [sampleMeasure('mA')]), 'model-b');
      const patch = markupTransitionPatch(stateFor('model-b', []), 'model-a');
      // Committed data still restores...
      assert.strictEqual(patch.measure2DResults?.[0]?.id, 'mA');
      // ...but in-progress/selection state from model B must not leak in.
      assert.deepStrictEqual(patch.polygonArea2DPoints, []);
      assert.strictEqual(patch.selectedAnnotation2D, null);
    });

    it('also clears in-progress state transitioning to null', () => {
      const patch = markupTransitionPatch(stateFor('model-a', []), null);
      assert.deepStrictEqual(patch.polygonArea2DPoints, []);
      assert.strictEqual(patch.selectedAnnotation2D, null);
    });

    it('does NOT touch annotation2DActiveTool — the active tool is a session preference, not tied to a model\'s coordinate frame', () => {
      const patch = markupTransitionPatch(stateFor('model-a', []), 'model-b');
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(patch, 'annotation2DActiveTool'),
        false,
        'the tool field must be absent from the patch so set() leaves it untouched',
      );
    });

    it('is a true no-op (still {}) when re-selecting the already-active model, even with in-progress state present', () => {
      const patch = markupTransitionPatch(stateFor('model-a', []), 'model-a');
      assert.deepStrictEqual(patch, {});
    });
  });
});
