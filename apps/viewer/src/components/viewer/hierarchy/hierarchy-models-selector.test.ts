/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy keeps its `models` identity across a geometry update that
 * changes nothing it shows (#6232 perf): a re-mesh swaps an element's meshes
 * under the same id. Anything the tree does read still passes through.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { createHierarchyModelsSelector } from './hierarchy-models-selector';

const mesh = (expressId: number) => ({ expressId }) as MeshData;
const geometry = (...ids: number[]) => ({ meshes: ids.map(mesh) }) as unknown as GeometryResult;
const model = (fields: Partial<FederatedModel>) => ({ id: 'm', name: 'M', visible: true, ifcDataStore: null, ...fields }) as FederatedModel;
const state = (m: FederatedModel) => ({ models: new Map([['m', m]]) });

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
});
