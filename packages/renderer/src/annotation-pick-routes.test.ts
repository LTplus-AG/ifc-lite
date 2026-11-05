/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './camera.js';
import { Scene } from './scene.js';
import { PickingManager } from './picking-manager.js';
import { AnnotationPicker } from './annotation-picking.js';
import type { Picker } from './picker.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { PickResult } from './types.js';

function harness(overBudget: boolean) {
  const camera = new Camera();
  camera.setPosition(0,0,10); camera.setTarget(0,0,0);
  const scene = new Scene();
  const annotations = new AnnotationPicker();
  annotations.setLines({origin:[0,0,0],localVertices:new Float32Array([-1,0,0,1,0,0]),ownerIds:new Uint32Array([71])},true);
  // Real scene mesh-data budget and real triangle raycast, without allocating GPU buffers.
  if (overBudget) {
    for (let id=1000;id<=1500;id++) scene.addMeshData({expressId:id,positions:new Float32Array([20,0,0,21,0,0,20,1,0]),
      indices:new Uint32Array([0,1,2]),normals:new Float32Array(9),color:[1,1,1,1]} as MeshData);
    scene.getBatchedMeshes = () => [{}] as ReturnType<Scene['getBatchedMeshes']>;
  }
  let readbacks = 0;
  let readback: () => Promise<PickResult | null> = async () => null;
  const gpu = {pick: async () => {readbacks++;return readback();}} as unknown as Picker;
  const canvas = {width:400,height:400,getBoundingClientRect:()=>({width:200,height:200})} as HTMLCanvasElement;
  const manager = new PickingManager(camera,scene,gpu,canvas,()=>{throw new Error('unexpected hydration');});
  manager.setAnnotationPickProvider((...args)=>annotations.pick(camera,...args));
  return {camera,scene,annotations,manager,readbacks:()=>readbacks,setReadback:(fn:typeof readback)=>{readback=fn;}};
}

for (const overBudget of [false,true]) test(`#8783 annotation selection reaches ${overBudget?'over-budget CPU':'GPU readback'} route at DPR 2`, async () => {
  const h = harness(overBudget);
  assert.equal((await h.manager.pick(100,103))?.expressId,71);
  assert.equal(h.readbacks(),overBudget?0:1,'assert actual route');
  assert.equal(await h.manager.pick(100,103,{hiddenIds:new Set([71])}),null);
  assert.equal(await h.manager.pick(100,103,{isolatedIds:new Set()}),null);
  assert.equal(await h.manager.pick(100,103,{isStreaming:true}),null);
  const mesh: MeshData = {expressId:800,positions:new Float32Array([-2,-2,1,2,-2,1,0,2,1]),
    normals:new Float32Array(9),indices:new Uint32Array([0,1,2]),color:[1,1,1,1]} as MeshData;
  if (overBudget) h.scene.addMeshData(mesh);
  else h.setReadback(async()=>({expressId:800,worldXYZ:{x:0,y:0,z:1}}));
  assert.equal((await h.manager.pick(100,100))?.expressId,800,'foreground surface occludes annotation');
});

for (const update of ['clear', 'replace'] as const) {
  for (const mesh of [null, { expressId: 800, modelIndex: 2, worldXYZ: { x: 0, y: 0, z: -1 } }] satisfies (PickResult | null)[]) {
    test(`#8783 annotation ${update} during GPU readback preserves ${mesh ? 'current mesh hit' : 'mesh miss'}`, async () => {
      const h = harness(false);
      let finish!: (result: PickResult | null) => void;
      h.setReadback(() => new Promise(resolve => { finish = resolve; }));
      const pending = h.manager.pick(100, 100);
      if (update === 'clear') h.annotations.clear();
      else h.annotations.setLines({ origin: [0, 0, 0], localVertices: new Float32Array([-1, 0, 0, 1, 0, 0]), ownerIds: new Uint32Array([82]) }, true);
      finish(mesh);
      // The overlay snapshot is stale, but the manager validated this mesh readback.
      // Neither the old owner (71) nor the replacement owner (82) can win this request.
      assert.deepEqual(await pending, mesh);
      assert.equal(h.readbacks(), 1);
    });
  }
}
