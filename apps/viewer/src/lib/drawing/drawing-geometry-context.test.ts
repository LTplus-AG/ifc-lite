/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FederatedModel } from '@/store';
import { drawingEntityOf, drawingModelOf } from './drawing-geometry-context';

const model = (idOffset: number) => ({ idOffset }) as FederatedModel;
const ranges = (globalId: number) => (globalId >= 100 && globalId < 200 ? { modelId: 'a', expressId: globalId - 100 }
  : globalId >= 200 && globalId < 300 ? { modelId: 'b', expressId: globalId - 200 } : null);

describe('drawing geometry ownership (#10264)', () => {
  it('a federated id outside every model range belongs to no model, not the first one', () => {
    const state = { models: new Map([['a', model(100)], ['b', model(200)]]), resolveGlobalIdFromModels: ranges };
    assert.equal(drawingModelOf(state, 150), 'a');
    assert.equal(drawingModelOf(state, 250), 'b');
    assert.equal(drawingModelOf(state, 999), undefined);
    // The class lookup's local id comes from the same lookup as its model.
    assert.deepEqual(drawingEntityOf(state, 250), { modelId: 'b', expressId: 50 });
  });

  it('keeps the legacy and single offset-zero model cases', () => {
    assert.equal(drawingModelOf({ models: new Map(), resolveGlobalIdFromModels: () => null }, 7), 'legacy');
    assert.equal(drawingModelOf({ models: new Map([['solo', model(0)]]), resolveGlobalIdFromModels: () => null }, 7), 'solo');
    assert.equal(drawingModelOf({ models: new Map([['solo', model(100)]]), resolveGlobalIdFromModels: () => null }, 7), undefined);
  });
});
