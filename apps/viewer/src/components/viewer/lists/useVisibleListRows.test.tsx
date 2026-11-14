/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Visible only" re-filters when a collab reconstruct replaces the legacy
 * store or drops a mutation view: neither bumps `mutationVersion`, so the
 * hook must subscribe to both (Part of #9668).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { ListRow } from '@ifc-lite/lists';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { invalidateVisibleBasketCache } from '@/store/basketVisibleSet';
import { fixtureDataStore } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { useVisibleListRows } from './useVisibleListRows';

const mesh = (expressId: number): MeshData => ({
  expressId, ifcType: 'IfcBeam',
  positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), color: [1, 1, 1, 1],
});
const zero = { x: 0, y: 0, z: 0 };
const geometry: GeometryResult = {
  meshes: [mesh(1), mesh(2), mesh(3)], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: { originShift: zero, originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false },
};
const beams = (...analytical: number[]) => fixtureDataStore([1, 2, 3].map(expressId => ({
  expressId, type: analytical.includes(expressId) ? 'IfcStructuralCurveMember' : 'IfcBeam',
})));
const ROWS: ListRow[] = [1, 2, 3].map(entityId => ({ entityId, modelId: 'legacy', values: [] }));

function Probe() {
  const rows = useVisibleListRows(ROWS, true);
  return <span>{rows.map(r => r.entityId).join(',')}</span>;
}

const initial = useViewerStore.getState();
describe('useVisibleListRows follows store and view swaps', () => {
  beforeEach(() => {
    useViewerStore.setState({
      models: new Map(), hiddenEntities: new Set(), isolatedEntities: null, classFilter: null, lensHiddenIds: new Set(),
      selectedStoreys: new Set(), structuralViewMode: 'physical', mutationViews: new Map(), geometryResult: geometry,
    });
    invalidateVisibleBasketCache();
  });
  afterEach(() => {
    cleanup();
    useViewerStore.setState(initial);
    invalidateVisibleBasketCache();
  });

  it('re-filters when the legacy store is replaced', () => {
    useViewerStore.setState({ ifcDataStore: beams() });
    const host = render(<Probe />);
    assert.equal(host.textContent, '1,2,3');
    act(() => useViewerStore.setState({ ifcDataStore: beams(2) }));
    assert.equal(host.textContent, '1,3');
  });

  it('re-filters when a mutation view is dropped', () => {
    const view = new MutablePropertyView(null, '__legacy__');
    view.setEntityType(2, 'IfcStructuralCurveMember', null, 'IfcBeam');
    useViewerStore.setState({ ifcDataStore: beams(), mutationViews: new Map([['__legacy__', view]]) });
    const host = render(<Probe />);
    assert.equal(host.textContent, '1,3');
    act(() => useViewerStore.setState({ mutationViews: new Map() }));
    assert.equal(host.textContent, '1,2,3');
  });
});
