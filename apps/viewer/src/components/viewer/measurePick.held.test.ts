/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { pickMeasurePoint } from './measurePick.js';

const state = () => useViewerStore.getState();

describe('measure picking during geometry restore', () => {
  beforeEach(() => state().resetViewerState());
  afterEach(() => state().resetViewerState());

  it('does not snap against held geometry and resumes picking at release', () => {
    let raycasts = 0;
    const ctx = {
      canvas: null,
      renderer: { raycastSceneMagnetic: () => { raycasts++; return { intersection: null, snapTarget: null, edgeLock: { shouldRelease: false, shouldLock: false } }; } },
      camera: {},
      edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
      hiddenEntitiesRef: { current: new Set<number>() },
      isolatedEntitiesRef: { current: null },
      snapEnabledRef: { current: true },
    } as unknown as MouseHandlerContext;
    useViewerStore.setState({ models: new Map([['restore', { geometryRestorePending: true }]]) as never });

    assert.equal(pickMeasurePoint(ctx, 10, 20), null);
    assert.equal(raycasts, 0);

    useViewerStore.setState({ models: new Map([['restore', { geometryRestorePending: false }]]) as never });
    assert.equal(pickMeasurePoint(ctx, 10, 20), null);
    assert.equal(raycasts, 1);
  });
});
