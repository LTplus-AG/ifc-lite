/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `splitToolSlice`'s participation in the store-wide teardown seam
 * (`store/teardown.ts`, `store/teardown-registry.ts`).
 *
 * Combines `createModelSlice` with `createSplitToolSlice` in one harness, the
 * same shape as `modelSlice.test.ts`'s `ModelTestState` — `modelSlice.ts`'s
 * `removeModel` / `clearAllModels` dispatch through the REAL, module-wide
 * `viewerTeardown` (`teardown-registry.ts`), not a per-slice stub, so a
 * harness that exercises those actions is exercising the actual registry a
 * missing registration is invisible to.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { createModelSlice, type ModelSlice } from './modelSlice.js';
import { createSplitToolSlice, type SplitToolSlice } from './splitToolSlice.js';
import type { FederatedModel } from '../types.js';

type TestState = ModelSlice & SplitToolSlice;

type TestSetState = (
  partial: Partial<TestState> | ((state: TestState) => Partial<TestState>),
) => void;
type TestGetState = () => TestState;

function createMockModel(id: string, name: string): FederatedModel {
  return {
    id,
    name,
    ifcDataStore: {} as unknown as IfcDataStore,
    geometryResult: {} as unknown as GeometryResult,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: Date.now(),
    fileSize: 1024,
    idOffset: 0,
    maxExpressId: 0,
  };
}

describe('SplitToolSlice — teardown registration (viewer teardown gap)', () => {
  let state: TestState;
  let setState: TestSetState;

  beforeEach(() => {
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = (partial as (s: TestState) => Partial<TestState>)(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    const getState: TestGetState = () => state;

    const modelSlice = createModelSlice(
      setState as Parameters<typeof createModelSlice>[0],
      getState as Parameters<typeof createModelSlice>[1],
      undefined as unknown as Parameters<typeof createModelSlice>[2],
    );
    const splitToolSlice = createSplitToolSlice(
      setState as Parameters<typeof createSplitToolSlice>[0],
      getState as Parameters<typeof createSplitToolSlice>[1],
      undefined as unknown as Parameters<typeof createSplitToolSlice>[2],
    );

    state = { ...modelSlice, ...splitToolSlice };
  });

  function armSplitTool(modelId: string) {
    state.setSplitTarget(modelId, 100);
    state.setSplitHover([1, 2, 3], 1.5, 3.5, [4, 5, 6], [1, 0, 0]);
  }

  describe('removeModel', () => {
    it('clears split-tool state pointing at the removed model', () => {
      state.addModel(createMockModel('model-1', 'Test Model'));
      armSplitTool('model-1');
      assert.strictEqual(state.splitTargetModelId, 'model-1');

      state.removeModel('model-1');

      assert.strictEqual(state.splitTargetModelId, null, 'splitTargetModelId must clear');
      assert.strictEqual(state.splitTargetExpressId, null, 'splitTargetExpressId must clear');
      assert.strictEqual(state.splitHoverPoint, null, 'splitHoverPoint must clear');
      assert.strictEqual(state.splitHoverDistance, null, 'splitHoverDistance must clear');
      assert.strictEqual(state.splitHoverLength, null, 'splitHoverLength must clear');
      assert.strictEqual(state.splitHoverCutPoint, null, 'splitHoverCutPoint must clear');
      assert.strictEqual(state.splitHoverAxisDirection, null, 'splitHoverAxisDirection must clear');
      assert.strictEqual(state.splitMode, 'idle', 'splitMode must fall back to idle');
    });

    it('leaves split-tool state pointing at a SURVIVING model alone', () => {
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      armSplitTool('model-2');

      state.removeModel('model-1');

      assert.strictEqual(state.splitTargetModelId, 'model-2');
      assert.strictEqual(state.splitMode, 'aiming');
    });

    it('clears a latched slab anchor pointing at the removed model', () => {
      state.addModel(createMockModel('model-1', 'Test Model'));
      state.setSplitTarget('model-1', 200);
      state.setSlabCutAnchor([1, 2], [[0, 0], [5, 0], [5, 5], [0, 5]], 0);
      assert.strictEqual(state.splitMode, 'first-anchor');

      state.removeModel('model-1');

      assert.strictEqual(state.slabCutAnchor, null);
      assert.strictEqual(state.slabCutFootprint, null);
      assert.strictEqual(state.slabCutStoreyElevation, null);
      assert.strictEqual(state.splitMode, 'idle');
    });
  });

  describe('clearAllModels', () => {
    it('clears split-tool state unconditionally', () => {
      state.addModel(createMockModel('model-1', 'Test Model'));
      armSplitTool('model-1');

      state.clearAllModels();

      assert.strictEqual(state.splitTargetModelId, null);
      assert.strictEqual(state.splitTargetExpressId, null);
      assert.strictEqual(state.splitHoverPoint, null);
      assert.strictEqual(state.splitHoverDistance, null);
      assert.strictEqual(state.splitHoverLength, null);
      assert.strictEqual(state.splitHoverCutPoint, null);
      assert.strictEqual(state.splitHoverAxisDirection, null);
      assert.strictEqual(state.splitMode, 'idle');
    });

    it('clears a latched slab anchor', () => {
      state.addModel(createMockModel('model-1', 'Test Model'));
      state.setSplitTarget('model-1', 200);
      state.setSlabCutAnchor([1, 2], [[0, 0], [5, 0], [5, 5], [0, 5]], 0);

      state.clearAllModels();

      assert.strictEqual(state.slabCutAnchor, null);
      assert.strictEqual(state.slabCutFootprint, null);
      assert.strictEqual(state.slabCutStoreyElevation, null);
      assert.strictEqual(state.splitMode, 'idle');
    });
  });

  describe('setActiveModel', () => {
    it('does NOT tear down split-tool state — setActiveModel is not a teardown entry point', () => {
      // Convention check, not a bug report: `store/teardown.ts` names four
      // entry points (`session-reset`, `model-removed`, `all-models-cleared`,
      // and `syncSourceModel`'s purge) and `setActiveModel` is none of them —
      // `modelSlice.ts` never calls `viewerTeardown` from it. Following that
      // convention here rather than inventing a fifth entry point for this
      // one slice.
      state.addModel(createMockModel('model-1', 'First'));
      state.addModel(createMockModel('model-2', 'Second'));
      armSplitTool('model-1');

      state.setActiveModel('model-2');

      assert.strictEqual(state.splitTargetModelId, 'model-1');
      assert.strictEqual(state.splitMode, 'aiming');
    });
  });
});
