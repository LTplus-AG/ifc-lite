/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The visible-ref cache must notice every input `resolveViewHiddenEntities`
 * reads. A collab room reconstruct after a peer's non-geometry edit swaps the
 * model's `ifcDataStore` (`applyRoomModelData`) and drops its mutation view
 * (`clearMutationView`) without bumping `mutationVersion` or changing the mesh
 * count. Keyed on the old fingerprint, "Visible only" kept serving the refs
 * from before the swap (Part of #9668).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { getVisibleBasketEntityRefsFromStore, invalidateVisibleBasketCache } from './basketVisibleSet.js';
import { useViewerStore } from './index.js';
import { entityRefToString } from './types.js';
import { fixtureDataStore, fixtureModel } from '../test/store-fixture.js';
import {
  FIXTURE_STOREY_2, FIXTURE_WALL_A, FIXTURE_WALL_B, FIXTURE_WALL_C, parseFixtureModel,
} from '../components/viewer/anonymized-export/anonymized-export-fixture.test-support.js';

const mesh = (expressId: number, ifcType = 'IfcBeam'): MeshData => ({
  expressId, ifcType,
  positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), color: [1, 1, 1, 1],
});
const zero = { x: 0, y: 0, z: 0 };
const geometry = (meshes = [mesh(1), mesh(2), mesh(3)]): GeometryResult => ({
  meshes, totalTriangles: 0, totalVertices: 0,
  coordinateInfo: { originShift: zero, originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, hasLargeCoordinates: false },
});
/** Three beams; `analytical` names the ids stored as an analytical member instead. */
const beams = (...analytical: number[]) => fixtureDataStore([1, 2, 3].map(expressId => ({
  expressId, type: analytical.includes(expressId) ? 'IfcStructuralCurveMember' : 'IfcBeam',
})));
const visible = () => getVisibleBasketEntityRefsFromStore().map(entityRefToString).sort();

const initial = useViewerStore.getState();

describe('the visible-ref cache sees store and view swaps', () => {
  beforeEach(() => {
    useViewerStore.setState({
      selectedEntitiesSet: new Set(), selectedEntity: null, selectedEntityIds: new Set(), hierarchyBasketSelection: new Set(),
      hiddenEntities: new Set(), isolatedEntities: null, classFilter: null, lensHiddenIds: new Set(), selectedStoreys: new Set(),
      structuralViewMode: 'physical', mutationViews: new Map(), models: new Map(),
    });
    invalidateVisibleBasketCache();
  });
  afterEach(() => {
    useViewerStore.setState(initial);
    invalidateVisibleBasketCache();
  });

  it('re-computes after the legacy ifcDataStore is replaced', () => {
    useViewerStore.setState({ ifcDataStore: beams(), geometryResult: geometry() });
    assert.deepEqual(visible(), ['legacy:1', 'legacy:2', 'legacy:3']);
    useViewerStore.setState({ ifcDataStore: beams(2) });
    assert.deepEqual(visible(), ['legacy:1', 'legacy:3']);
  });

  it("re-computes after a federated model's ifcDataStore is replaced", () => {
    const model = { ...fixtureModel('m1'), maxExpressId: 3, ifcDataStore: beams(), geometryResult: geometry() };
    useViewerStore.setState({ models: new Map([['m1', model]]), ifcDataStore: null, geometryResult: null });
    assert.deepEqual(visible(), ['m1:1', 'm1:2', 'm1:3']);
    useViewerStore.setState({ models: new Map([['m1', { ...model, ifcDataStore: beams(2) }]]) });
    assert.deepEqual(visible(), ['m1:1', 'm1:3']);
  });

  it('re-computes after a mutation view is dropped without a mutationVersion bump', () => {
    const view = new MutablePropertyView(null, '__legacy__');
    view.setEntityType(2, 'IfcStructuralCurveMember', null, 'IfcBeam');
    useViewerStore.setState({ ifcDataStore: beams(), geometryResult: geometry(), mutationViews: new Map([['__legacy__', view]]) });
    assert.deepEqual(visible(), ['legacy:1', 'legacy:3']);
    useViewerStore.setState({ mutationViews: new Map() });
    assert.deepEqual(visible(), ['legacy:1', 'legacy:2', 'legacy:3']);
  });

  it('re-computes after a store swap under storey isolation, in mode both', async () => {
    const store = await parseFixtureModel();
    const walls = [FIXTURE_WALL_A, FIXTURE_WALL_B, FIXTURE_WALL_C];
    useViewerStore.setState({
      structuralViewMode: 'both', ifcDataStore: store, selectedStoreys: new Set([FIXTURE_STOREY_2]),
      geometryResult: geometry(walls.map(id => mesh(id, 'IfcWall'))),
    });
    assert.deepEqual(visible(), [`legacy:${FIXTURE_WALL_B}`, `legacy:${FIXTURE_WALL_C}`].sort());
    // A re-derived store without a spatial tree: storey isolation no longer narrows.
    useViewerStore.setState({ ifcDataStore: { ...store, spatialHierarchy: undefined } });
    assert.deepEqual(visible(), walls.map(id => `legacy:${id}`).sort());
  });

  it('re-computes after a same-count geometry swap', () => {
    useViewerStore.setState({ structuralViewMode: 'both', ifcDataStore: beams(), geometryResult: geometry() });
    assert.deepEqual(visible(), ['legacy:1', 'legacy:2', 'legacy:3']);
    useViewerStore.setState({ geometryResult: geometry([mesh(1), mesh(2), mesh(4)]) });
    assert.deepEqual(visible(), ['legacy:1', 'legacy:2', 'legacy:4']);
  });
});
