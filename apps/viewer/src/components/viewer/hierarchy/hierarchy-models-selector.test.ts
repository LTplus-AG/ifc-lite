/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy keeps its `models` identity across a geometry update that
 * changes nothing it shows (#6232 perf): a re-mesh swaps an element's meshes
 * under the same id. Anything the tree does read still passes through.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { createHierarchyModelsSelector } from './hierarchy-models-selector';

const mesh = (expressId: number) => ({ expressId }) as MeshData;
const geometry = (...ids: number[]) => ({ meshes: ids.map(mesh) }) as unknown as GeometryResult;
const model = (fields: Partial<FederatedModel>) => ({ id: 'm', name: 'M', visible: true, ifcDataStore: null, ...fields }) as FederatedModel;
const state = (m: FederatedModel, geometryContentVersion = 0) => ({ models: new Map([['m', m]]), geometryContentVersion });

describe('hierarchy models selector (#6232)', () => {
  it('keeps the previous map when only the meshes of existing ids were replaced', () => {
    const select = createHierarchyModelsSelector();
    const first = state(model({ geometryResult: geometry(1, 2) }));
    const out = select(first);
    assert.equal(out, first.models);
    assert.equal(select(state(model({ geometryResult: geometry(2, 1, 1) }))), out, 're-mesh: same ids have geometry');
  });

  it('passes a change through when an id gains or loses geometry, or a shown field changes', () => {
    const select = createHierarchyModelsSelector();
    select(state(model({ geometryResult: geometry(1) })));
    const gained = state(model({ geometryResult: geometry(1, 3) }));
    assert.equal(select(gained), gained.models);
    const hidden = state(model({ geometryResult: geometry(1, 3), visible: false }));
    assert.equal(select(hidden), hidden.models);
    const renamed = state(model({ geometryResult: geometry(1, 3), visible: false, name: 'N' }));
    assert.equal(select(renamed), renamed.models);
  });

  it('passes a change through when the frame the storey badges read changes, in place or not', () => {
    const select = createHierarchyModelsSelector();
    const first = geometry(1);
    select(state(model({ geometryResult: first })));
    const reframed = { ...geometry(1), coordinateInfo: { originShift: { x: 1, y: 0, z: 0 } } } as unknown as GeometryResult;
    const next = state(model({ geometryResult: reframed }));
    assert.equal(select(next), next.models, 'a new coordinateInfo');
    // A federation re-align rewrites geometry in place and bumps the content version.
    const bumped = state(model({ geometryResult: reframed }), 1);
    assert.equal(select(bumped), bumped.models, 'a content-version bump');
  });

  // #6411: every streamed batch is a new model with more meshes, and the tree
  // rebuilt for each one twice a second on a large load. A streaming model is
  // held until the refresh is due; anything else still passes at once.
  describe('while geometry streams (#6411)', () => {
    let clock = 0;
    beforeEach(() => { clock = 0; mock.method(performance, 'now', () => clock); });
    afterEach(() => mock.restoreAll());
    const streaming = (fields: Partial<FederatedModel> = {}) =>
      state(model({ loadState: 'streaming-geometry', ...fields }));

    it('holds the growing geometry until the refresh is due, then passes it without comparing ids', () => {
      const select = createHierarchyModelsSelector();
      const first = streaming({ geometryResult: geometry(1) });
      assert.equal(select(first), first.models);
      clock = 1;
      assert.equal(select(streaming({ geometryResult: geometry(1, 2) })), first.models, 'held');
      clock = 60_000;
      const due = streaming({ geometryResult: geometry(1, 2, 3) });
      assert.equal(select(due), due.models, 'refreshed');
    });

    it('holds a batch whose frame object is new, as every streamed batch is', () => {
      const select = createHierarchyModelsSelector();
      const first = streaming({ geometryResult: geometry(1) });
      select(first);
      clock = 1;
      const reframed = { ...geometry(1, 2), coordinateInfo: { originShift: { x: 0, y: 0, z: 0 } } } as unknown as GeometryResult;
      assert.equal(select(streaming({ geometryResult: reframed })), first.models);
    });

    it('passes a non-geometry change through at once, e.g. metadata arriving', () => {
      const select = createHierarchyModelsSelector();
      select(streaming({ geometryResult: geometry(1) }));
      clock = 1;
      const store = { entityCount: 1 } as unknown as FederatedModel['ifcDataStore'];
      const withMetadata = streaming({ geometryResult: geometry(1, 2), ifcDataStore: store });
      assert.equal(select(withMetadata), withMetadata.models);
    });

    it('passes the end of the stream through at once', () => {
      const select = createHierarchyModelsSelector();
      select(streaming({ geometryResult: geometry(1) }));
      clock = 1;
      const done = state(model({ geometryResult: geometry(1, 2), loadState: 'complete' }));
      assert.equal(select(done), done.models);
    });
  });
});
