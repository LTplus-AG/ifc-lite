/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A modeling commit re-meshes through the wasm re-mesh service (#6297) by
 * default, and remembers its batch so undo / redo re-mesh it too (charter
 * #6232, WP1 × WP2). A scripted worker stands in for the wasm one.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { RemeshRequest, RemeshResult, StyleWire } from '@ifc-lite/geometry/remesh';
import { useViewerStore } from '@/store';
import { setRemeshClientFactory, type RemeshClientLike } from '@/lib/remesh/remesh-service';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { runTransaction } from './transaction.js';
import type { CommandContext, ModelingCommand } from './types.js';

class ScriptedClient implements RemeshClientLike {
  alive = true;
  readonly requests: RemeshRequest[] = [];
  remesh(request: RemeshRequest): Promise<RemeshResult> {
    this.requests.push(request);
    return new Promise(() => {});
  }
  styleWire(): Promise<StyleWire> {
    return Promise.resolve({
      styleIds: new Uint32Array(), styleColors: new Uint8Array(),
      materialElementIds: new Uint32Array(), materialColorCounts: new Uint32Array(), materialColors: new Uint8Array(),
    });
  }
  setConfig(): void {}
  dispose(): void { this.alive = false; }
}

const ctx: CommandContext = { get: useViewerStore.getState, modelId: MODEL_ID, storeyId: STOREY, workplane: null };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PLACE_WALL: ModelingCommand = {
  id: 'test.placeWall', labelKey: 'modelingCommand.closeAria', hud: {}, snap: 'modeling',
  init: () => null, pointerMove: (g) => g, pointerDown: (g) => g,
  commit(_g, tx) {
    const wall = tx.store.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    if ('error' in wall) throw new Error(wall.error);
    return { created: [wall.expressId], deleted: [], remesh: [wall.expressId] };
  },
};

let client: ScriptedClient;

beforeEach(async () => {
  setRemeshClientFactory(async () => (client = new ScriptedClient()));
  await seedModelingSession();
  // A model loaded through the wasm path carries its RTC frame; the re-mesh
  // service meshes in it (and refuses a model without one).
  const model = useViewerStore.getState().models.get(MODEL_ID)!;
  const geometryResult = {
    ...model.geometryResult,
    coordinateInfo: { ...model.geometryResult!.coordinateInfo, wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } },
  } as GeometryResult;
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, geometryResult }]]), geometryResult });
});
afterEach(() => setRemeshClientFactory(null));

describe('runTransaction re-mesh (#6232 WP1 × WP2)', () => {
  it('re-meshes the committed element, and again on redo', async () => {
    const outcome = runTransaction(useViewerStore, PLACE_WALL, null, ctx);
    assert.ok(outcome.ok && outcome.batchId);
    const wall = outcome.result.created[0];
    await flush();
    assert.equal(client.requests.length, 1, 'the commit asked the worker for the new wall');
    assert.ok([...client.requests[0].targets].includes(wall));

    useViewerStore.getState().undo(MODEL_ID);
    await flush();
    const afterUndo = client.requests.length;
    useViewerStore.getState().redo(MODEL_ID);
    await flush();
    assert.equal(client.requests.length, afterUndo + 1, 'redo re-meshed the restored wall');
    assert.ok([...client.requests[afterUndo].targets].includes(wall));
  });
});
