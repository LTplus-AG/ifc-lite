/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Bounded diagnostic of the evidence algorithm, not viewer correctness coverage.
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';
import { captureGeometryBrowser, geometryWitnessExpression } from './geometry-witness.mts';
const mesh={expressId:7,positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2]),uvs:new Float32Array([0,0,1,0,0,1]),color:[1,0,0,1]};
const corners=[0,0,0,1,0,0,0,1,0];
const result={meshes:[mesh],coordinateInfo:{originShift:{x:0,y:0,z:0}}};
const state={models:new Map([['one',{idOffset:0,geometryResult:result,loadState:'complete',ifcDataStore:{entities:{expressId:[7,11]}}}]]),loading:false,geometryStreamingActive:false};
globalThis.__ifc_lite_viewer_store__={getState:()=>state};
globalThis.__ifc_lite_scene_owner__=id=>({instance:id===11,corners:[...corners],flat:id===7?[{color:[1,0,0,1],triangles:1}]:null});
const base=await captureGeometryBrowser();
assert.equal((await runInThisContext(geometryWitnessExpression())).sha256,base.sha256,'serialized page expression must match the actual algorithm under tsx');
assert.equal(base.instancedOwners,1);assert.equal(base.placedTriangles,2);
mesh.uvs[0]=0.5;
const uv=await captureGeometryBrowser();assert.notEqual(uv.sourceSha256,base.sourceSha256);assert.equal(uv.placedSha256,base.placedSha256);
mesh.uvs[0]=0;
const beforeInstanced=globalThis.__ifc_lite_scene_owner__;
globalThis.__ifc_lite_scene_owner__=id=>{const value=beforeInstanced(id);if(id===11)value.corners[0]=0.25;return value;};
const instance=await captureGeometryBrowser();assert.notEqual(instance.placedSha256,base.placedSha256);assert.equal(instance.sourceSha256,base.sourceSha256);
globalThis.__ifc_lite_scene_owner__=beforeInstanced;
result.coordinateInfo.originShift.x=4;
const placement=await captureGeometryBrowser();assert.notEqual(placement.coordinateSha256,base.coordinateSha256);assert.notEqual(placement.sha256,base.sha256);
result.coordinateInfo.originShift.x=0;
state.models.get('one').ifcDataStore.entities.expressId=[11,7];
assert.equal((await captureGeometryBrowser()).sha256,base.sha256,'semantic entity iteration order must not change the witness');
mesh.positions[0]=-0;
assert.notEqual((await captureGeometryBrowser()).sourceSha256,base.sourceSha256,'original typed-array bits must remain visible');
console.log(JSON.stringify({ok:true,invariants:['UV-byte mutation changes flat source digest','instance-only triangle mutation changes placed digest','placement mutation changes coordinate and combined digests','semantic owner ordering is canonical','signed-zero array bits preserved'],scope:'Evidence algorithm diagnostic only; not a native GPU/model acceptance run'}));
