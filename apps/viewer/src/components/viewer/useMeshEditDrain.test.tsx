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
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useRef, type MutableRefObject } from 'react';
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
  const lastReplacementVersionRef = useRef(0);
  const processedMeshIdsRef = useRef(new Set<string>());
  useMeshEditDrain({
    rendererRef, isInitialized: true, isStreaming: false, geometry,
    pendingMeshRemovals: null, clearPendingMeshRemovals: () => {}, pruneGeometryMeshes: () => {},
    lastGeometryLengthRef, lastGeometryRef, processedMeshIdsRef,
    geometryReplacementVersion: 0, lastReplacementVersionRef,
  });
  refs({ length: lastGeometryLengthRef, array: lastGeometryRef });
  return null;
}

/** Mount at `renderedTick`, then land a replacement (and whatever else moved the tick) in one update. */
async function drain(geometry: MeshData[], renderedTick: number, edit: { since: number; tick: number }, storeTick = edit.tick) {
  const log: SceneLog = { removed: [], appended: [], rebuilt: 0 };
  useViewerStore.setState({ pendingMeshEdits: null, geometryUpdateTick: renderedTick });
  let refs!: Refs;
  render(<Harness renderer={scriptedRenderer(log)} geometry={geometry} refs={(r) => { refs = r; }} />);
  act(() => useViewerStore.setState({ geometryUpdateTick: storeTick, pendingMeshEdits: { ids: new Set([7]), ...edit } }));
  await waitFor(() => useViewerStore.getState().pendingMeshEdits === null, 'the drain clears the queued edit');
  return { log, refs };
}

describe('useMeshEditDrain (#6232)', () => {
  afterEach(cleanup);

  it('swaps the edited entity in the scene and advances the main effect past it', async () => {
    // Entity 7 re-meshed into two meshes, now at the tail; 8 untouched.
    const geometry = [mesh(8), mesh(7), mesh(7)];
    const { log, refs } = await drain(geometry, 4, { since: 4, tick: 5 });
    assert.deepEqual(log.removed, [[7]]);
    assert.deepEqual(log.appended, [[7, 7]], 'only the edited entity is uploaded');
    assert.equal(refs.length.current, 3, 'the main effect sees no length change');
    assert.equal(refs.array.current, geometry);
  });

  it('forces the keep-camera rebuild when the geometry changed again after the replacement', async () => {
    const geometry = [mesh(8), mesh(7), mesh(9)];
    const { refs } = await drain(geometry, 4, { since: 4, tick: 5 }, 6);
    assert.ok(refs.length.current > geometry.length, 'reads as a shrink, which rebuilds keeping the camera');
  });

  it('forces the keep-camera rebuild when a batch was appended in the same render, before the replacement', async () => {
    // Tick 3 → 4 appended #9, 4 → 5 is the replacement; the main effect saw neither.
    const geometry = [mesh(8), mesh(9), mesh(7)];
    const { log, refs } = await drain(geometry, 3, { since: 4, tick: 5 });
    assert.deepEqual(log.appended, [[7]]);
    assert.ok(refs.length.current > geometry.length, "the main effect still uploads #9 instead of being advanced past it");
  });

  it('an entity re-meshed to nothing is removed and its buckets rebuilt', async () => {
    const { log } = await drain([mesh(8)], 4, { since: 4, tick: 5 });
    assert.deepEqual(log.appended, []);
    assert.equal(log.rebuilt, 1);
  });
});
