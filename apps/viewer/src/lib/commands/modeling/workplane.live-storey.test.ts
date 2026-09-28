/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An element's storey is its storey NOW (#6232, after #6282): a containment
 * edit that moves a wall from L0 (0 m) to L1 (3 m) must move the workplane a
 * command edits it on, and the mesh a resize mirrors to collaborators, to L1.
 * Both read the load-time `elementToStorey` index before, which still says L0.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { refreshWallMeshIn } from '@/store/slices/mutation-wall-resize';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import './builtin.js';
import { getCommandRuntime } from './runtime.js';
import { elementStoreyId } from './workplane.js';

let wallId = 0;

/** A wall authored on L0, then re-contained on L1 by editing its IfcRelContainedInSpatialStructure. */
beforeEach(async () => {
  const view = await seedModelingSession();
  const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.5 });
  assert.ok('expressId' in wall);
  wallId = wall.expressId;
  const rel = view.getNewEntities().find((e) => e.type === 'IfcRelContainedInSpatialStructure'
    && Array.isArray(e.attributes[4]) && e.attributes[4].includes(`#${wallId}`));
  assert.ok(rel);
  view.setAttribute(rel.expressId, 'RelatingStructure', `#${UPPER_STOREY}`);
  assert.equal(
    useViewerStore.getState().models.get(MODEL_ID)?.ifcDataStore?.spatialHierarchy?.elementToStorey.get(wallId),
    STOREY,
    'control: the load-time index still says L0',
  );
});
afterEach(() => { useViewerStore.getState().exitModelWorkspace(); });

describe('live storey for element workplanes (#6232)', () => {
  it('elementStoreyId follows the containment edit', () => {
    assert.equal(elementStoreyId(useViewerStore.getState(), MODEL_ID, wallId), UPPER_STOREY);
  });

  it('wall.moveEndpoint edits the moved wall on L1, 3 m up', () => {
    const s = useViewerStore.getState();
    s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, wallId));
    s.startCommand('wall.moveEndpoint');
    const g = getCommandRuntime().gesture as { plane: { spec: { storeyId: number }; localToRender(p: readonly number[]): readonly number[] } | null };
    assert.equal(g.plane?.spec.storeyId, UPPER_STOREY);
    assert.equal(g.plane?.localToRender([0, 0, 0])[1], 3, 'the plane sits at L1\'s elevation');
  });

  it('a resize mirrors a mesh standing on L1, not L0', () => {
    let mirrored: MeshData | null = null;
    useViewerStore.setState({ mirrorEntityGeometry: (_modelId: string, _id: number, mesh: MeshData) => { mirrored = mesh; } });
    refreshWallMeshIn(useViewerStore.getState, MODEL_ID, wallId, true);
    assert.ok(mirrored, 'the mirror mesh was built');
    const ys = [...(mirrored as MeshData).positions].filter((_, i) => i % 3 === 1);
    assert.deepEqual([Math.min(...ys), Math.max(...ys)].map((v) => +v.toFixed(6)), [3, 5.5]);
  });
});
