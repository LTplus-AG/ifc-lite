/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createAppearancePlanner, type AppearanceWorker } from './planner-worker-client.js';
import type { CapturedMeshRequest, CapturedMeshPlan, AppearanceWorkerRequest } from './planner-types.js';
const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('annotation creation contract'),'2;1');
FILE_NAME('plane.ifc','2026-09-09',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project000000000000000',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#5);
ENDSEC;
END-ISO-10303-21;`);
const request: CapturedMeshRequest = {
  schema: 'IFC4', sourceRevision: 'annotation-wasm', nextExpressId: 100,
  containerId: 40, GlobalId: '0aaaaaaaaaaaaaaaaaaaaa', containmentGlobalId: '0bbbbbbbbbbbbbbbbbbbbb',
  Name: 'Image reference', imageUri: 'textures/image.png',
  mesh: { positions: [[2,3,4],[3,3,4],[3,4,4],[2,4,5]], triangles: [[0,1,2],[0,2,3]],
    uvs: [[0,0],[1,0],[1,1],[0,1],[0.2,0.2]], uvTriangles: [[0,1,2],[4,2,3]] },
};
test('real WASM annotation creation preserves canonical owner/UV frame and shares cancellation/stale fences (#4380)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm to run annotation contract'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const api = new IfcAPI();
  let result: CapturedMeshPlan;
  try {
    result = JSON.parse(new TextDecoder().decode(api.planCapturedMesh(source, JSON.stringify(request)))) as CapturedMeshPlan;
    assert.equal(result.mesh.express_id, result.objectId);
    assert.equal(result.mesh.geometry_item_id, result.geometryItemId);
    assert.equal(result.coordinateSpace, 'ifc-z-up');
    assert.equal(result.mesh.texture.url, request.imageUri);
    assert.deepEqual(result.mesh.color, [1, 1, 1, 1]);
    assert.equal(result.mesh.indices.length, 6);
    result.mesh.indices.forEach((index, corner) => {
      const face = Math.floor(corner / 3), local = corner % 3;
      const expected = request.mesh.positions[request.mesh.triangles[face][local]];
      const uv = request.mesh.uvs[request.mesh.uvTriangles[face][local]];
      const world = result.mesh.positions.slice(index*3,index*3+3).map((p,axis)=>p+(result.mesh.origin?.[axis]??0)+result.rtcOffset[axis]);
      assert.deepEqual(world, expected);
      assert.ok(Math.abs(result.mesh.uvs[index*2]-uv[0])<1e-6);
      assert.ok(Math.abs(result.mesh.uvs[index*2+1]-(1-uv[1]))<1e-6);
    });
    assert.ok(result.plan.created.some(e => e.type === 'IfcBuildingElementProxy' && e.attributes[0] === request.GlobalId));
    assert.ok(result.plan.created.some(e => e.type === 'IfcRelContainedInSpatialStructure' && e.attributes[5] === '#40'));
    assert.throws(() => api.planCapturedMesh(source, JSON.stringify({ ...request, containerId: 1 })), /IfcSpatialElement/);
  } finally { api.free(); }
  const { runCapturedMeshPlanning } = await import('../../workers/appearance.worker.js');
  assert.equal((await runCapturedMeshPlanning(source, request)).objectId, result.objectId);
  let latest: AppearanceWorkerRequest | undefined;
  let terminated = 0;
  const worker: AppearanceWorker = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message) { latest = structuredClone(message); }, terminate() { terminated++; } };
  const planner = createAppearancePlanner({ workerFactory: () => worker });
  const stale = planner.capturedMeshPlan(source, request);
  assert.equal(latest?.type, 'captured-mesh-plan');
  assert.ok(latest);
  assert.notEqual(latest.source.buffer, source.buffer);
  worker.onmessage?.(new MessageEvent('message', { data: { type: 'captured-mesh-complete', id: latest.id,
    result: { ...result, plan: { ...result.plan, nextExpressId: 999 } } } }));
  await assert.rejects(stale, /stale/);
  const cancelled = planner.capturedMeshPlan(source, request);
  planner.cancel();
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(terminated, 2);
  assert.ok(source.byteLength > 0);
  planner.dispose();
});

test('real WASM authors the public boulder without losing a triangle or UV seam (#4380)', async t => {
  const fixture = process.env.IFCLITE_CAPTURED_MESH_FIXTURE;
  if (!fixture) { t.skip('Set IFCLITE_CAPTURED_MESH_FIXTURE to the public boulder JSON described in native capture evidence'); return; }
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  const bytes = await readFile(fixture);
  const capture = JSON.parse(bytes.toString()) as {
    vertices: CapturedMeshRequest['mesh']['positions']; triangles: CapturedMeshRequest['mesh']['triangles'];
    uvs: CapturedMeshRequest['mesh']['uvs']; uv_triangles: CapturedMeshRequest['mesh']['uvTriangles'];
  };
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const api = new IfcAPI();
  try {
    const input: CapturedMeshRequest = { ...request, imageUri: 'textures/boulder.jpg', mesh: {
      positions: capture.vertices, triangles: capture.triangles, uvs: capture.uvs, uvTriangles: capture.uv_triangles,
    } };
    const result = JSON.parse(new TextDecoder().decode(api.planCapturedMesh(source, JSON.stringify(input)))) as CapturedMeshPlan;
    assert.equal(result.mesh.indices.length, capture.triangles.length * 3);
    assert.equal(result.mesh.texture.url, input.imageUri);
    result.mesh.indices.forEach((index, corner) => {
      const face = Math.floor(corner / 3), local = corner % 3;
      const expected = capture.vertices[capture.triangles[face][local]];
      const uv = capture.uvs[capture.uv_triangles[face][local]];
      for (let axis = 0; axis < 3; axis++) {
        const world = result.mesh.positions[index * 3 + axis] + (result.mesh.origin?.[axis] ?? 0) + result.rtcOffset[axis];
        assert.ok(Math.abs(world - expected[axis]) < 1e-4);
      }
      assert.ok(Math.abs(result.mesh.uvs[index * 2] - uv[0]) < 1e-6);
      assert.ok(Math.abs(result.mesh.uvs[index * 2 + 1] - (1 - uv[1])) < 1e-6);
    });
  } finally { api.free(); }
});
