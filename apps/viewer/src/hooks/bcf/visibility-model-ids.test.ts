/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ViewerState } from '@/store';
import { visibilityModelIdsForCapture } from './visibility-model-ids.js';

describe('visibilityModelIdsForCapture', () => {
  it('uses canonical model-scoped ownership rather than offset subtraction (#4921)', () => {
    const models = new Map([
      ['not-owner', {
        id: 'not-owner', idOffset: 0, maxExpressId: 10,
        ifcDataStore: { entities: { getGlobalId: () => 'SHARED' } },
      }],
      ['owner', {
        id: 'owner', idOffset: 100, maxExpressId: 10,
        ifcDataStore: { entities: { getGlobalId: (id: number) => id === 1 ? 'SHARED' : null } },
      }],
    ]) as unknown as ViewerState['models'];
    const resolveGlobalIdInModel = mock.fn((modelId: string, globalId: number) =>
      modelId === 'owner' && globalId === 101 ? { modelId, expressId: 1 } : null);
    const state = {
      models,
      ifcDataStore: null,
      mutationViews: new Map(),
      hiddenEntities: new Set([101]),
      isolatedEntities: null,
      resolveGlobalIdInModel,
    } as unknown as Pick<ViewerState,
      | 'models' | 'ifcDataStore' | 'mutationViews'
      | 'hiddenEntities' | 'isolatedEntities'
      | 'resolveGlobalIdInModel'>;

    assert.deepEqual(visibilityModelIdsForCapture(state, () => 'SHARED'), ['owner']);
    assert.deepEqual(resolveGlobalIdInModel.mock.calls.map((call) => call.arguments), [
      ['not-owner', 101], ['owner', 101],
    ]);
  });
});
