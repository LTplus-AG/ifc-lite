/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useMeshEditDrain` (#6232 WP1): a re-meshed entity's renderer meshes are
 * swapped in place and the main geometry effect's length/array refs are
 * advanced past the swap, so that effect neither reshapes the scene nor
 * appends the wrong tail. A scripted scene records what the drain did.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { render, cleanup, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useMeshEditDrain } from './useMeshEditDrain.js';

interface SceneLog { removed: number[][]; appended: number[][]; rebuilt: number }

function scriptedRenderer(log: SceneLog): Renderer {
  const scene = {
    removeMeshesForEntities: (ids: Iterable<number>) => { log.removed.push([...ids]); return 0; },
    appendToBatches: (meshes: MeshData[]) => { log.appended.push(meshes.map((m) => m.expressId)); },
    hasPendingBatches: () => true,
    rebuildPendingBatches: () => { log.rebuilt++; },
  };
  return {
    getGPUDevice: () => ({}),
    getPipeline: () => ({}),
    getScene: () => scene,
    clearCaches: () => {},
    requestRender: () => {},
  } as unknown as Renderer;
}

const mesh = (expressId: number) => ({ expressId }) as MeshData;

interface Refs { length: MutableRefObject<number>; array: MutableRefObject<MeshData[] | null> }

function Harness({ renderer, geometry, refs }: { renderer: Renderer; geometry: MeshData[]; refs: (r: Refs) => void }) {
  const rendererRef = useRef<Renderer | null>(renderer);
  const lastGeometryLengthRef = useRef(2);
  const lastGeometryRef = useRef<MeshData[] | null>(null);
  const processedMeshIdsRef = useRef(new Set<string>());
  useMeshEditDrain({
    rendererRef, isInitialized: true, isStreaming: false, geometry,
    pendingMeshRemovals: null, clearPendingMeshRemovals: () => {}, pruneGeometryMeshes: () => {},
    lastGeometryLengthRef, lastGeometryRef, processedMeshIdsRef,
  });
  refs({ length: lastGeometryLengthRef, array: lastGeometryRef });
  return null;
}

describe('useMeshEditDrain (#6232)', () => {
  beforeEach(() => useViewerStore.setState({ pendingMeshEdits: null, geometryUpdateTick: 5 }));
  afterEach(cleanup);

  it('swaps the edited entity in the scene and advances the main effect past it', async () => {
    const log: SceneLog = { removed: [], appended: [], rebuilt: 0 };
    // Entity 7 re-meshed into two meshes, now at the tail; 8 untouched.
    const geometry = [mesh(8), mesh(7), mesh(7)];
    useViewerStore.setState({ pendingMeshEdits: { ids: new Set([7]), tick: 5 } });
    let refs!: Refs;
    render(<Harness renderer={scriptedRenderer(log)} geometry={geometry} refs={(r) => { refs = r; }} />);
    await waitFor(() => useViewerStore.getState().pendingMeshEdits === null, 'the drain clears the queued edit');
    assert.deepEqual(log.removed, [[7]]);
    assert.deepEqual(log.appended, [[7, 7]], 'only the edited entity is uploaded');
    assert.equal(refs.length.current, 3, 'the main effect sees no length change');
    assert.equal(refs.array.current, geometry);
  });

  it('forces the keep-camera rebuild when other geometry changed in the same render', async () => {
    const log: SceneLog = { removed: [], appended: [], rebuilt: 0 };
    const geometry = [mesh(8), mesh(7), mesh(9)];
    // The replacement ended on tick 5; something else has bumped it since.
    useViewerStore.setState({ pendingMeshEdits: { ids: new Set([7]), tick: 4 } });
    let refs!: Refs;
    render(<Harness renderer={scriptedRenderer(log)} geometry={geometry} refs={(r) => { refs = r; }} />);
    await waitFor(() => useViewerStore.getState().pendingMeshEdits === null, 'the drain clears the queued edit');
    assert.ok(refs.length.current > geometry.length, 'reads as a shrink, which rebuilds keeping the camera');
  });

  it('an entity re-meshed to nothing is removed and its buckets rebuilt', async () => {
    const log: SceneLog = { removed: [], appended: [], rebuilt: 0 };
    useViewerStore.setState({ pendingMeshEdits: { ids: new Set([7]), tick: 5 } });
    render(<Harness renderer={scriptedRenderer(log)} geometry={[mesh(8)]} refs={() => {}} />);
    await waitFor(() => useViewerStore.getState().pendingMeshEdits === null, 'the drain clears the queued edit');
    assert.deepEqual(log.appended, []);
    assert.equal(log.rebuilt, 1);
  });
});
