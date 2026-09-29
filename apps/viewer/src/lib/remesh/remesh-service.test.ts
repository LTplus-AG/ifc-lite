/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `requestRemesh` end to end in the store (#6232 WP1), with a scripted
 * worker in place of the wasm one. The real store runs: a wall authored by
 * `addWall`, resized by `resizeWall`, undone by `undo`. What the worker is
 * sent is checked against the model (targets, frame, a parseable subgraph);
 * what it answers is checked in `geometryResult` and `pendingMeshEdits`.
 * Mesh parity with the load is `scripts/lib/wasm-remesh-contracts.mjs`.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { RemeshRequest, RemeshResult, StyleWire } from '@ifc-lite/geometry/remesh';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { disposeRemeshClient, requestRemesh, setRemeshClientFactory, watchModelUnloads, type RemeshClientLike } from './remesh-service';

const MODEL_ID = 'ifc';
const STOREY = 40;
const FRAME = { x: 100, y: 200, z: 0, needsShift: true };
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;
`;

interface Call { request: RemeshRequest; resolve: (result: RemeshResult) => void; reject: (error: Error) => void }

class ScriptedClient implements RemeshClientLike {
  alive = true;
  readonly calls: Call[] = [];
  remesh(request: RemeshRequest): Promise<RemeshResult> {
    return new Promise((resolve, reject) => this.calls.push({ request, resolve, reject }));
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

let clients: ScriptedClient[] = [];

function mesh(expressId: number, x: number): MeshData {
  return {
    expressId, ifcType: 'IfcWall',
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.5, 0.5, 1],
  } as MeshData;
}

const answer = (meshes: MeshData[]): RemeshResult => ({ meshes, csgFailures: 0, ms: { prepass: 1, produce: 1 } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function seed(frame: typeof FRAME | null = FRAME): Promise<void> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const geometry = {
    meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
      ...(frame ? { wasmRtcFrame: frame } : {}),
    },
  } as unknown as GeometryResult;
  const model = { ...fixtureModel(MODEL_ID), ifcDataStore: dataStore, geometryResult: geometry } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model),
    editEnabled: true,
    geometryResult: geometry,
    mutationViews: new Map([[MODEL_ID, new MutablePropertyView(dataStore.properties || null, MODEL_ID)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    removedNewEntities: new Map(), removedMeshes: new Map(),
    pendingMeshRemovals: null, pendingMeshEdits: null, geometryContentVersion: 0, mutationVersion: 0,
  });
}

/**
 * Author a wall and let its creation re-mesh land (an add re-meshes what it
 * creates, #6232), so each test starts from a wall with a mesh and a worker
 * with no calls.
 */
async function addWall(): Promise<number> {
  const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.25, Height: 2.8 });
  assert.ok('expressId' in wall);
  await flush();
  for (const client of clients) {
    for (const call of client.calls.splice(0)) call.resolve(answer([mesh(wall.expressId, 0)]));
  }
  await flush();
  return wall.expressId;
}

function wallMeshes(id: number): MeshData[] {
  return (useViewerStore.getState().models.get(MODEL_ID)?.geometryResult?.meshes ?? []).filter((m) => m.expressId === id);
}

describe('requestRemesh (#6232)', () => {
  beforeEach(async () => {
    clients = [];
    setRemeshClientFactory(async () => {
      const client = new ScriptedClient();
      clients.push(client);
      return client;
    });
    await seed();
  });
  afterEach(() => setRemeshClientFactory(null));

  it('a resize sends the wall to the worker in the load frame and swaps its mesh in', async () => {
    const wall = await addWall();
    const authored = wallMeshes(wall);
    useViewerStore.getState().resizeWall(MODEL_ID, wall, [-1, 0, 0], [5, 0, 0]);
    await flush();
    const [call] = clients[0].calls;
    assert.deepEqual([...call.request.targets], [wall]);
    assert.deepEqual(call.request.frame, FRAME);
    const text = new TextDecoder().decode(call.request.buffer);
    assert.match(text, new RegExp(`#${wall}=IFCWALL\\(`));
    // The resize's own edit is in the buffer: the new start point.
    assert.match(text, /IFCCARTESIANPOINT\(\(-1\.,0\.,0\.\)\)/);

    call.resolve(answer([mesh(wall, 7)]));
    await flush();
    const meshes = wallMeshes(wall);
    assert.equal(meshes.length, 1);
    assert.notEqual(meshes[0], authored[0]);
    assert.equal(meshes[0].positions[0], 7);
    const edits = useViewerStore.getState().pendingMeshEdits;
    assert.ok(edits?.ids.has(wall));
    assert.equal(edits?.tick, useViewerStore.getState().geometryUpdateTick);
  });

  it('drops a result a later request for the same element superseded', async () => {
    const wall = await addWall();
    const first = requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape');
    await flush();
    // An edit in between: an identical request with no edit in between shares the first.
    useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 }));
    const second = requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape');
    await flush();
    const [older, newer] = clients[0].calls;
    newer.resolve(answer([mesh(wall, 2)]));
    assert.equal((await second).status, 'applied');
    older.resolve(answer([mesh(wall, 1)]));
    assert.equal((await first).status, 'stale');
    assert.equal(wallMeshes(wall)[0].positions[0], 2, 'the newer mesh stays');
  });

  it('drops a result for an element deleted while it was meshed', async () => {
    const wall = await addWall();
    const pending = requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape');
    await flush();
    useViewerStore.getState().removeEntity(MODEL_ID, wall);
    clients[0].calls[0].resolve(answer([mesh(wall, 1)]));
    assert.equal((await pending).status, 'stale');
    assert.equal(wallMeshes(wall).length, 0);
  });

  it('undo and redo of a resize re-mesh the wall from the restored data', async () => {
    const wall = await addWall();
    useViewerStore.getState().resizeWall(MODEL_ID, wall, [-1, 0, 0], [5, 0, 0]);
    await flush();
    clients[0].calls[0].resolve(answer([mesh(wall, 1)]));
    await flush();

    useViewerStore.getState().undo(MODEL_ID);
    await flush();
    assert.equal(clients[0].calls.length, 2, 'undo re-meshes');
    const undone = new TextDecoder().decode(clients[0].calls[1].request.buffer);
    assert.doesNotMatch(undone, /IFCCARTESIANPOINT\(\(-1\.,0\.,0\.\)\)/, 'the undone start point is gone');

    useViewerStore.getState().redo(MODEL_ID);
    await flush();
    assert.equal(clients[0].calls.length, 3, 'redo re-meshes');
    assert.match(new TextDecoder().decode(clients[0].calls[2].request.buffer), /IFCCARTESIANPOINT\(\(-1\.,0\.,0\.\)\)/);
  });

  it('a dead worker is reported and replaced by the next request', async () => {
    const wall = await addWall();
    const pending = requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape');
    await flush();
    clients[0].alive = false;
    clients[0].calls[0].reject(new Error('Re-mesh worker failed: boom'));
    const outcome = await pending;
    assert.equal(outcome.status, 'failed');
    const next = requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape');
    await flush();
    assert.equal(clients.length, 2, 'a new worker is started');
    clients[1].calls[0].resolve(answer([mesh(wall, 3)]));
    assert.equal((await next).status, 'applied');
  });

  it('unloading a model terminates the worker', async () => {
    const wall = await addWall();
    const pending = requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape');
    await flush();
    clients[0].calls[0].resolve(answer([mesh(wall, 1)]));
    assert.equal((await pending).status, 'applied');
    const unwatch = watchModelUnloads(useViewerStore.subscribe);
    try {
      useViewerStore.setState({ models: new Map() });
      await flush();
      assert.equal(clients[0].alive, false, 'the idle worker is gone with the model');
    } finally {
      unwatch();
    }
  });

  it('a request cut off by that termination is sent again, not reported as a failure', async () => {
    const wall = await addWall();
    const pending = requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape');
    await flush();
    // Another model unloaded: the worker goes, and its in-flight request rejects.
    disposeRemeshClient();
    clients[0].calls[0].reject(new Error('RemeshClient is disposed'));
    await flush();
    assert.equal(clients.length, 2, 'a new worker is started');
    clients[1].calls[0].resolve(answer([mesh(wall, 4)]));
    assert.equal((await pending).status, 'applied');
    assert.equal(wallMeshes(wall)[0].positions[0], 4);
  });

  it('refuses a model loaded without a wasm frame, and a colour-merged mesh', async () => {
    await seed(null);
    const wall = await addWall();
    assert.deepEqual(await requestRemesh(useViewerStore.getState, MODEL_ID, [wall], 'shape'), { status: 'refused', reason: 'noFrame' });

    await seed();
    const merged = await addWall();
    const host = wallMeshes(merged)[0];
    host.entityIds = new Uint32Array(host.positions.length / 3).fill(merged);
    host.entityIds[0] = 999_999;
    assert.deepEqual(await requestRemesh(useViewerStore.getState, MODEL_ID, [merged], 'shape'), { status: 'refused', reason: 'colourMerged' });
    assert.equal(clients.flatMap((c) => c.calls).length, 0, 'nothing was sent to a worker');
  });
});
