/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `removeModel` must drop a computed BIM<->scan deviation result: the
 * heatmap in `DeviationPanel` is built from a BVH over every triangle
 * currently in the scene (`DeviationComputer.compute`, packages/renderer),
 * so removing a federated model changes the very geometry the buffer
 * describes. `pointCloudDeviationComputed` gates BOTH the "Recompute" vs.
 * "Compute deviation" label and the auto-recompute effect
 * (`!computed && ...`) in `DeviationPanel.tsx`, so once it is left `true`
 * nothing re-triggers a rebuild and the slider/legend keep presenting a
 * heatmap computed against a mesh set that no longer exists.
 *
 * `removeModel` already tears down the same "references geometry that just
 * changed" class of staleness for the clash focus, the IDS validation
 * report and the compare result (see its own comments) -- this is the one
 * sibling it left out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

function model(id: string, idOffset: number): FederatedModel {
  return { id, name: id, visible: true, idOffset } as unknown as FederatedModel;
}

function seedTwoModelsWithComputedDeviation(): void {
  useViewerStore.setState({
    models: new Map([
      ['A', model('A', 0)],
      ['B', model('B', 100000)],
    ]),
    activeModelId: 'A',
  });
  useViewerStore.getState().setPointCloudDeviationComputed(true);
}

describe('removeModel drops a stale computed deviation result', () => {
  it('clears pointCloudDeviationComputed when a model is removed', () => {
    seedTwoModelsWithComputedDeviation();
    useViewerStore.getState().removeModel('A');
    const s = useViewerStore.getState();

    assert.strictEqual(
      s.pointCloudDeviationComputed,
      false,
      'a removed model changed the scene\'s triangle set, so the prior deviation compute no longer describes it',
    );
  });
});
