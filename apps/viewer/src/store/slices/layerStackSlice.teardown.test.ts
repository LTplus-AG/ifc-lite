/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `layerStackSlice`'s participation in the store-wide teardown seam (#4309;
 * `store/teardown.ts`, `store/teardown-registry.ts`).
 *
 * Combines `createModelSlice` with `createLayerStackSlice` in one harness,
 * the same shape `splitToolSlice.teardown.test.ts` uses (`#4249`/`#4289`) —
 * `modelSlice.ts`'s `removeModel` / `clearAllModels` dispatch through the
 * REAL, module-wide `viewerTeardown` (`teardown-registry.ts`), not a
 * per-slice stub, so a harness that exercises those actions is exercising
 * the actual registry a missing registration is invisible to.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { createModelSlice, type ModelSlice } from './modelSlice.js';
import {
  createLayerStackSlice,
  type LayerStackSlice,
  type LayerStackEntry,
} from './layerStackSlice.js';
import { layerStackTeardown } from './layerStackSlice.teardown.js';
import type { FederatedModel } from '../types.js';
import type { TeardownState } from '../teardown.js';

type TestState = ModelSlice & LayerStackSlice;

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
    schemaVersion: 'IFC5',
    loadedAt: Date.now(),
    fileSize: 1024,
    idOffset: 0,
    maxExpressId: 0,
  };
}

/** A minimal layer stack entry — only `id` is load-bearing for the teardown. */
function makeEntry(id: string, name: string): LayerStackEntry {
  return {
    id,
    name,
    file: { header: { id, ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-07-11T00:00:00Z' }, imports: [], schemas: {}, data: [] },
    nodeCount: 0,
    byteLength: 0,
  };
}

describe('LayerStackSlice — teardown registration (#4309)', () => {
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
    const layerStackSlice = createLayerStackSlice(
      setState as Parameters<typeof createLayerStackSlice>[0],
      getState as Parameters<typeof createLayerStackSlice>[1],
      undefined as unknown as Parameters<typeof createLayerStackSlice>[2],
    );

    state = { ...modelSlice, ...layerStackSlice };
  });

  function armLayerStack(...modelIds: string[]) {
    const entries = modelIds.map((id) => makeEntry(id, `${id}.ifcx`));
    state.setLayerStack(entries, new Map([['wall-1', 42]]));
    state.setLayersPanelVisible(true);
    state.setLayerDiffBusy(true);
  }

  describe('removeModel', () => {
    it('clears the layer stack when the removed model is one of its layers (#4309 RED without registration)', () => {
      state.addModel(createMockModel('layer-a', 'Base'));
      state.addModel(createMockModel('layer-b', 'Overlay'));
      armLayerStack('layer-a', 'layer-b');
      assert.strictEqual(state.layerStack.length, 2);
      assert.ok(state.layerStackPathToId);

      state.removeModel('layer-a');

      assert.deepStrictEqual(state.layerStack, [], 'layerStack must clear');
      assert.strictEqual(state.layerStackPathToId, null, 'layerStackPathToId (3D selection bridge) must clear');
      assert.strictEqual(state.layerStackDiff, null, 'layerStackDiff must clear');
      assert.strictEqual(state.layerDiffBusy, false, 'layerDiffBusy must clear');
      // Panel stays docked open over the now-empty composition rather than
      // being yanked shut under the user for a partial removal.
      assert.strictEqual(state.layersPanelVisible, true, 'layersPanelVisible must NOT close on model-removed');
    });

    it('leaves an UNRELATED layer stack alone when the removed model is not one of its layers', () => {
      state.addModel(createMockModel('layer-a', 'Base'));
      state.addModel(createMockModel('other-model', 'Unrelated STEP file'));
      armLayerStack('layer-a');

      state.removeModel('other-model');

      assert.strictEqual(state.layerStack.length, 1);
      assert.ok(state.layerStackPathToId);
    });
  });

  describe('clearAllModels', () => {
    it('clears the layer stack unconditionally', () => {
      state.addModel(createMockModel('layer-a', 'Base'));
      armLayerStack('layer-a');

      state.clearAllModels();

      assert.deepStrictEqual(state.layerStack, []);
      assert.strictEqual(state.layerStackPathToId, null);
      assert.strictEqual(state.layerStackDiff, null);
      assert.strictEqual(state.layerDiffBusy, false);
      // Same rationale as model-removed: data clears, panel stays as the
      // user left it rather than closing under them mid-session.
      assert.strictEqual(state.layersPanelVisible, true);
    });
  });

  describe('session-reset', () => {
    it('clears the layer stack AND closes the panel', () => {
      state.addModel(createMockModel('layer-a', 'Base'));
      armLayerStack('layer-a');

      const patch = layerStackTeardown.teardown({ kind: 'session-reset' }, state as unknown as TeardownState);

      assert.deepStrictEqual(patch.layerStack, []);
      assert.strictEqual(patch.layerStackPathToId, null);
      assert.strictEqual(patch.layerStackDiff, null);
      assert.strictEqual(patch.layerDiffBusy, false);
      assert.strictEqual(patch.layersPanelVisible, false, 'a genuinely new file load closes the layers panel');
    });
  });
});
