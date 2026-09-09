/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createAppearancePlanner, type AppearanceWorker } from './planner-worker-client.js';
import type { AnnotationPlaneRequest, AnnotationPlanePlan, AppearanceWorkerRequest } from './planner-types.js';
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
const request: AnnotationPlaneRequest = {
  schema: 'IFC4', sourceRevision: 'annotation-wasm', nextExpressId: 100,
  containerId: 40, GlobalId: '0aaaaaaaaaaaaaaaaaaaaa', containmentGlobalId: '0bbbbbbbbbbbbbbbbbbbbb',
  Name: 'Image reference', imageUri: 'textures/image.png',
  frame: { origin: [2, 3, 4], axisU: [1, 0, 0], axisV: [0, 0, 1], sizeMetres: [2, 1] },
};
test('real WASM annotation creation preserves canonical owner/UV frame and shares cancellation/stale fences (#4308)', async t => {
  const wasmUrl = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm to run annotation contract'); return;
  }
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const api = new IfcAPI();
  let result: AnnotationPlanePlan;
  try {
    result = JSON.parse(new TextDecoder().decode(api.planAnnotationPlane(source, JSON.stringify(request)))) as AnnotationPlanePlan;
    assert.equal(result.mesh.express_id, result.annotationId);
    assert.equal(result.mesh.geometry_item_id, result.geometryItemId);
    assert.equal(result.coordinateSpace, 'ifc-z-up');
    assert.equal(result.mesh.texture.url, request.imageUri);
    assert.deepEqual(result.mesh.color, [1, 1, 1, 1]);
    assert.equal(result.mesh.indices.length, 6);
    for (let i = 0; i < result.mesh.positions.length / 3; i++) {
      const u = result.mesh.uvs[i * 2], v = 1 - result.mesh.uvs[i * 2 + 1];
      const world = result.mesh.positions.slice(i * 3, i * 3 + 3).map((p, axis) => p + (result.mesh.origin?.[axis] ?? 0) + result.rtcOffset[axis]);
      assert.deepEqual(world, [2 + u * 2, 3, 4 + v]);
    }
    assert.ok(result.plan.created.some(e => e.type === 'IfcAnnotation' && e.attributes[0] === request.GlobalId));
    assert.ok(result.plan.created.some(e => e.type === 'IfcRelContainedInSpatialStructure' && e.attributes[5] === '#40'));
    assert.throws(() => api.planAnnotationPlane(source, JSON.stringify({ ...request, containerId: 1 })), /IfcSpatialElement/);
  } finally { api.free(); }
  const { runAnnotationPlanePlanning } = await import('../../workers/appearance.worker.js');
  assert.equal((await runAnnotationPlanePlanning(source, request)).annotationId, result.annotationId);
  let latest: AppearanceWorkerRequest | undefined;
  let terminated = 0;
  const worker: AppearanceWorker = { onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message) { latest = structuredClone(message); }, terminate() { terminated++; } };
  const planner = createAppearancePlanner({ workerFactory: () => worker });
  const stale = planner.annotationPlan(source, request);
  assert.equal(latest?.type, 'annotation-plan');
  assert.ok(latest);
  assert.notEqual(latest.source.buffer, source.buffer);
  worker.onmessage?.(new MessageEvent('message', { data: { type: 'annotation-complete', id: latest.id,
    result: { ...result, plan: { ...result.plan, nextExpressId: 999 } } } }));
  await assert.rejects(stale, /stale/);
  const cancelled = planner.annotationPlan(source, request);
  planner.cancel();
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(terminated, 2);
  assert.ok(source.byteLength > 0);
  planner.dispose();
});
