/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The federation run's own rules, with the loaders stubbed: the concurrency
 * bound, and the failed slot's Retry on its model row.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, click, cleanup } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { loadProcessedFederation } from './processedFederationLoad.js';
import { clearFederationSlotFailures, federationSlotFailure, setFederationSlotFailure } from '@/lib/federation-slot-status';
import { FederationSlotRetry } from '@/components/viewer/hierarchy/FederationSlotRetry';

const sha = (c: string) => c.repeat(64);
const slot = (id: string, c: string) => ({ slot: id, label: id, sha256: sha(c), bytes: 1, name: `${id}.ifc`, visible: true });

afterEach(() => { cleanup(); clearFederationSlotFailures(); useViewerStore.getState().clearAllModels(); });

for (const concurrency of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
  it(`a concurrency of ${concurrency} falls back to the default instead of starting no slot (#11813 review)`, async () => {
    const added: string[] = [];
    const outcome = await loadProcessedFederation({ kind: 'federation', id: 'w', slots: [slot('arch', 'a'), slot('struct', 'b'), slot('mep', 'c')] }, {
      concurrency,
      openPrimary: async (request, modelId) => {
        // A primary with geometry and properties, as the loader leaves it.
        useViewerStore.getState().upsertModel({ ...fixtureModel(modelId), loadState: 'complete', geometryResult: { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }, hasLargeCoordinates: false } }, processedModel: { sha256: request.sha256, bytes: 1 } } as FederatedModel);
      },
      addSlot: async (_request, options) => { added.push(options.modelId!); return options.modelId!; },
    });
    assert.deepEqual(outcome, { loaded: ['arch', 'struct', 'mep'], failed: [], skipped: [] });
    assert.deepEqual(added, ['struct', 'mep']);
  });
}

it('a failed slot row offers Retry with its reason, and clicking it retries that slot', () => {
  let retried = 0;
  setFederationSlotFailure('struct', { reason: 'The processing server is busy.', retry: () => { retried++; } });
  const ui = render(<><FederationSlotRetry modelId="struct" name="Structure" /><FederationSlotRetry modelId="mep" name="MEP" /></>);
  const buttons = ui.querySelectorAll('button');
  assert.equal(buttons.length, 1, 'only the failed slot shows Retry');
  assert.equal(buttons[0].getAttribute('aria-label'), 'Retry loading Structure');
  assert.equal(buttons[0].getAttribute('title'), 'The processing server is busy.');
  click(buttons[0]);
  assert.equal(retried, 1);
  setFederationSlotFailure('struct', null);
  assert.equal(federationSlotFailure('struct'), undefined);
});
