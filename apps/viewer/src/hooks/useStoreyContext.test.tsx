/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's storey context in 3D (#6232, decision D9), through the
 * hook the viewport reads its hidden / ghost sets from (`useVisibilityState`).
 *
 * The fixture has two storeys, L0 (0 m) and L1 (3 m), with imported elements
 * on L0. Each test draws a wall on each storey, so the upper floor holds an
 * element drawn this session — the case the parsed tree alone would miss.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { cleanup, render } from '@/test/render.js';
import { MESH_WALL, MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { useVisibilityState } from './useViewerSelectors.js';
import { useVisibilityIsolation } from './useVisibilityIsolation.js';

type Sets = ReturnType<typeof useVisibilityState>;
let seen: Sets | null = null;
let isolation: Set<number> | null = null;
function Probe() {
  seen = useVisibilityState();
  isolation = useVisibilityIsolation();
  return null;
}
const viewport = (): Sets => seen!;

let lowerWall = 0;
let upperWall = 0;
const WALL = { Thickness: 0.2, Height: 3 };

function globalId(expressId: number): number {
  return toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, expressId);
}

/** A stand-in mesh per drawn entity, so "every drawn entity" is known to the ghost path. */
function meshFor(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    ifcType: 'IfcWall',
  } as MeshData;
}

beforeEach(async () => {
  await seedModelingSession();
  const s = useViewerStore.getState();
  s.setStoreyContextMode('hide');
  const lower = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], ...WALL });
  const upper = s.addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 2, 0], End: [4, 2, 0], ...WALL });
  assert.ok('expressId' in lower && 'expressId' in upper);
  lowerWall = lower.expressId;
  upperWall = upper.expressId;
  // Replace whatever re-mesh fallback may have landed with one known mesh per element.
  const model = useViewerStore.getState().models.get(MODEL_ID)!;
  const meshes = [MESH_WALL, lowerWall, upperWall].map((id) => meshFor(globalId(id)));
  useViewerStore.setState({
    models: new Map([[MODEL_ID, { ...model, geometryResult: { ...model.geometryResult!, meshes } }]]),
    hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
    selectedStoreys: new Set(), levelDisplayMode: 'stacked',
  });
  render(<Probe />);
});

afterEach(() => {
  act(() => { useViewerStore.getState().exitModelWorkspace(); });
  cleanup();
  seen = null;
  isolation = null;
});

describe('Model workspace storey context in 3D (#6232 D9)', () => {
  it('outside the workspace the viewport draws exactly the user\'s sets', () => {
    const s = useViewerStore.getState();
    assert.equal(viewport().hiddenEntities, s.hiddenEntities);
    assert.equal(viewport().ghostExceptEntities, null);
  });

  it('hides everything above the active storey by default, drawn elements included, and leaves the storey itself', () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }); });
    const hidden = viewport().hiddenEntities;
    assert.ok(hidden.has(globalId(upperWall)), 'the wall drawn on the floor above is hidden');
    assert.ok(!hidden.has(globalId(lowerWall)), 'the wall drawn on the active storey shows');
    assert.ok(!hidden.has(globalId(MESH_WALL)), 'the imported wall on the active storey shows');
    assert.equal(viewport().ghostExceptEntities, null, 'hide mode ghosts nothing');
    assert.equal(useViewerStore.getState().hiddenEntities.size, 0, 'the shared hidden channel is not written');
  });

  it('ghost mode fades the storeys above instead, and show all leaves the view alone', () => {
    act(() => {
      useViewerStore.getState().setStoreyContextMode('ghost');
      useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
    });
    const ghostExcept = viewport().ghostExceptEntities!;
    assert.ok(ghostExcept, 'ghosting is on');
    assert.ok(!ghostExcept.has(globalId(upperWall)), 'the floor above fades');
    assert.ok(ghostExcept.has(globalId(lowerWall)) && ghostExcept.has(globalId(MESH_WALL)), 'the active storey stays solid');
    assert.ok(!viewport().hiddenEntities.has(globalId(upperWall)), 'ghosted, not hidden');

    act(() => { useViewerStore.getState().setStoreyContextMode('all'); });
    assert.equal(viewport().hiddenEntities, useViewerStore.getState().hiddenEntities);
    assert.equal(viewport().ghostExceptEntities, null);
  });

  it('a storey switch moves the context: on the top storey nothing is above', () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }); });
    assert.ok(viewport().hiddenEntities.has(globalId(upperWall)));
    act(() => { useViewerStore.getState().setSessionStorey(UPPER_STOREY); });
    assert.ok(!viewport().hiddenEntities.has(globalId(upperWall)), 'the new storey shows');
    assert.ok(!viewport().hiddenEntities.has(globalId(lowerWall)), 'the storey below shows');
  });

  it('a storey raised above the active one by an edit is hidden with it', () => {
    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: UPPER_STOREY }); });
    assert.ok(!viewport().hiddenEntities.has(globalId(lowerWall)));
    act(() => {
      const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
      view.setAttribute(STOREY, 'Elevation', '6');
      useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 }));
    });
    assert.ok(viewport().hiddenEntities.has(globalId(lowerWall)), 'L0 now sits at 6 m, above L1');
  });

  it('composes with the user\'s hidden, isolated and ghosted sets, and leaving puts them back exactly', () => {
    const userHidden = new Set([globalId(MESH_WALL)]);
    const userIsolated = new Set([globalId(lowerWall), globalId(upperWall)]);
    const userGhost = new Set([globalId(lowerWall), globalId(upperWall), globalId(MESH_WALL)]);
    act(() => {
      useViewerStore.getState().restoreVisibilityState({ hidden: userHidden, isolated: userIsolated, ghostExcept: userGhost });
    });
    const before = { ...viewport() };

    act(() => { useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY }); });
    const inside = viewport();
    assert.ok(inside.hiddenEntities.has(globalId(MESH_WALL)), 'the user\'s hidden element stays hidden');
    assert.ok(inside.hiddenEntities.has(globalId(upperWall)), '…and the floor above joins it');
    assert.equal(inside.isolatedEntities, before.isolatedEntities, 'isolation is untouched');
    assert.equal(inside.ghostExceptEntities, before.ghostExceptEntities, 'the user\'s ghosting is untouched in hide mode');

    act(() => { useViewerStore.getState().setStoreyContextMode('ghost'); });
    assert.deepEqual([...viewport().ghostExceptEntities!].sort(), [globalId(lowerWall), globalId(MESH_WALL)].sort(),
      'ghost above narrows the user\'s own except-set');

    act(() => { useViewerStore.getState().exitModelWorkspace(); });
    const after = viewport();
    assert.equal(after.hiddenEntities, before.hiddenEntities);
    assert.equal(after.isolatedEntities, before.isolatedEntities);
    assert.equal(after.ghostExceptEntities, before.ghostExceptEntities);
    const s = useViewerStore.getState();
    assert.deepEqual([...s.hiddenEntities], [...userHidden]);
    assert.deepEqual([...s.isolatedEntities!], [...userIsolated]);
    assert.deepEqual([...s.ghostExceptEntities!], [...userGhost]);
  });

  it('an explicit Solo wins over the context', () => {
    act(() => {
      useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
      applyLevelDisplayMode('solo', [{ modelId: MODEL_ID, expressId: STOREY }]);
    });
    assert.ok(!viewport().hiddenEntities.has(globalId(upperWall)), 'Solo already isolates the storey; nothing is layered on it');
    assert.ok(isolation?.has(globalId(lowerWall)) && !isolation.has(globalId(upperWall)));
  });

  it('with Solo on, a wall drawn on the soloed storey joins the isolation at once, and leaves it on undo (ledger defect)', () => {
    // In the browser the tree arrives from a worker or the cache, where the
    // storey node's `elements` is a copy of `byStorey`, not the same array.
    const hierarchy = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!.spatialHierarchy!;
    const storeyNode = hierarchy.project.children.find((node) => node.expressId === STOREY)!;
    storeyNode.elements = [...storeyNode.elements];
    act(() => {
      useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
      applyLevelDisplayMode('solo', [{ modelId: MODEL_ID, expressId: STOREY }]);
    });
    let drawn = 0;
    act(() => {
      const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 4, 0], End: [4, 4, 0], ...WALL });
      assert.ok('expressId' in wall);
      drawn = wall.expressId;
    });
    assert.ok(isolation?.has(globalId(drawn)), 'the new wall is in the isolated set, so 3D draws it');
    assert.ok(!viewport().hiddenEntities.has(globalId(drawn)));
    act(() => { useViewerStore.getState().undo(MODEL_ID); });
    assert.ok(!isolation?.has(globalId(drawn)), 'undone, it is gone from the storey again');
  });
});
