/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { importDxf, type SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';
import { dxfUnderlayToDrawing } from './dxfUnderlayMath';
// A production revert removes the new frame module; keep the tests loadable
// so its absence fails an assertion rather than aborting module discovery.
async function loadReferencePlane() {
  const module = await import('./dxfReferencePlane').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(module, 'DXF plane registration must be available');
  return module;
}
const bounds = {min:{x:0,y:0,z:0},max:{x:10,y:10,z:10}};
function state(rtc = 0) {
  return {...useViewerStore.getState(),models:new Map(),modelPlacement:emptyPlacementState(),geometryResult:{meshes:[],totalTriangles:0,totalVertices:0,
    coordinateInfo:{originShift:{x:0,y:0,z:0},wasmRtcOffset:{x:rtc,y:0,z:0},originalBounds:bounds,shiftedBounds:bounds,hasLargeCoordinates:false}}};
}
const front:SectionPlaneConfig = {axis:'z',position:5,flipped:false};
function entry(captureDxfReferenceFrame: typeof import('./dxfReferencePlane').captureDxfReferenceFrame):DxfUnderlayState {
  const underlay=importDxf('0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nwall\n10\n0\n20\n0\n11\n4\n21\n3\n0\nENDSEC\n0\nEOF','elevation');
  return {id:'reference',name:'elevation',underlay,visible:true,visible3D:true,opacity:1,layerVisibility:{},placement:{offsetX:0,offsetY:0,rotationDeg:0,scale:1},referenceFrame:captureDxfReferenceFrame(state(),front)};
}
test('vertical DXF landmarks share engineering plane across flip and parallel cut motion (#6615)',async()=>{
  const { captureDxfReferenceFrame, dxfPlaneDrawingMapper, dxfReferenceStatus, dxfReferenceRenderBasis, dxfReferencePointToRender } = await loadReferencePlane();
  const e=entry(captureDxfReferenceFrame), s=state();
  const mapper=dxfPlaneDrawingMapper(e,s,front)!;
  const mapped=dxfUnderlayToDrawing(e,{x:0,y:0},false,undefined,false,mapper);
  assert.deepEqual(mapped.lines[0].points,[{x:0,y:0},{x:4,y:3}]);
  const moved=dxfPlaneDrawingMapper(e,s,{...front,position:99})!;
  assert.deepEqual(moved({x:4,y:3}),{x:4,y:3});
  const flipped=dxfPlaneDrawingMapper(e,s,{...front,flipped:true})!;
  assert.deepEqual(flipped({x:4,y:3}),{x:-4,y:3});
  const basis=dxfReferenceRenderBasis(e.referenceFrame!,s)!;
  assert.deepEqual(dxfReferencePointToRender({x:4,y:3},e,basis),[4,3,5]);
  assert.equal(dxfReferenceStatus(e,s,{axis:'y',position:0,flipped:false}),'edge-on');
});
test('frozen DXF placement survives RTC rebase and rejects corrupt frames (#6615)',async()=>{
  const { captureDxfReferenceFrame, dxfPlaneDrawingMapper, isDxfReferenceFrame } = await loadReferencePlane();
  const e=entry(captureDxfReferenceFrame);
  const mapper=dxfPlaneDrawingMapper(e,state(100),front)!;
  assert.deepEqual(mapper({x:4,y:3}),{x:-96,y:3});
  assert.equal(isDxfReferenceFrame(e.referenceFrame),true);
  assert.equal(isDxfReferenceFrame({...e.referenceFrame,uIfc:[2,0,0]}),false);
  assert.equal(isDxfReferenceFrame({...e.referenceFrame,vIfc:[1,0,0]}),false);
  assert.equal(isDxfReferenceFrame({...e.referenceFrame,originIfc:[NaN,0,0]}),false);
});
test('legacy site plans stay plan-only and offsets and rotation apply once in local plane (#6615)',async()=>{
  const { captureDxfReferenceFrame, dxfPlaneDrawingMapper, dxfReferenceStatus } = await loadReferencePlane();
  const e=entry(captureDxfReferenceFrame),s=state(); delete e.referenceFrame;
  assert.equal(dxfReferenceStatus(e,s,front),'edge-on');
  assert.equal(dxfReferenceStatus(e,s,{axis:'y',position:0,flipped:false}),'ready');
  e.referenceFrame=captureDxfReferenceFrame(s,front);
  e.placement={offsetX:10,offsetY:20,rotationDeg:90,scale:2};
  const point=dxfPlaneDrawingMapper(e,s,front)!({x:4,y:3});
  assert.ok(Math.abs(point.x-16)<1e-10); assert.ok(Math.abs(point.y-12)<1e-10);
});

test('centering converts drawing translations to plane axes through the same projection (#6615)',async()=>{
  const { captureDxfReferenceFrame, dxfDrawingDeltaToPlacement } = await loadReferencePlane();
  const e=entry(captureDxfReferenceFrame),s=state(), flipped={...front,flipped:true};
  assert.deepEqual(dxfDrawingDeltaToPlacement(e,s,flipped,{x:10,y:20}),{x:-10,y:20});
  e.referenceFrame=captureDxfReferenceFrame(s,{axis:'y',position:0,flipped:false});
  assert.deepEqual(dxfDrawingDeltaToPlacement(e,s,{axis:'y',position:0,flipped:false},{x:10,y:20}),{x:10,y:-20});
});
