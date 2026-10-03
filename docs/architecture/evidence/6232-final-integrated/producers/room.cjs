// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const { runSuite, assert } = require('./common.cjs');
runSuite('room', async ({ modelId, baseline, send, capture, undo, redo, sameGraphGeometry }) => {
  const walls=[], box=[[[0,-8,0],[4,-8,0]],[[4,-8,0],[4,-4,0]],[[4,-4,0],[0,-4,0]],[[0,-4,0],[0,-8,0]]];
  for(const [Start,End] of box) {
    const wall=await send('addWall',[modelId,42,{Start,End,Height:3,Thickness:.2}]); walls.push(wall.expressId);
    await capture(`wall-${walls.length}`,walls);
  }
  const before=await capture('room-before',walls);
  const query=await send('roomCommand',[modelId,42,{action:'query'}]);
  assert.ok(query.candidates.length>0); sameGraphGeometry(await capture('room-query',walls),before);
  const picked=await send('roomCommand',[modelId,42,{action:'pick',point:[2,-6],namePattern:'Qualified Room {n}'}]);
  assert.equal(picked.created.length,1); const ref=picked.created[0];
  const pickState=await capture('room-pick',[...walls,ref.expressId]);
  assert.equal(pickState.undo,before.undo+1); assert.notEqual(pickState.graphHash,before.graphHash);
  const cut=await send('roomCommand',[modelId,42,{action:'edit',operation:{kind:'split',a:[2,-8],b:[2,-4]}}]);
  assert.equal(cut.created.length,1);
  const cutState=await capture('room-cut',[...walls,ref.expressId,cut.created[0].expressId]);
  assert.equal(cutState.undo,pickState.undo+1); assert.notEqual(cutState.graphHash,pickState.graphHash);
  await undo(); sameGraphGeometry(await capture('room-cut-undo',[...walls,ref.expressId]),pickState);
  await redo(); sameGraphGeometry(await capture('room-cut-redo',[...walls,ref.expressId,cut.created[0].expressId]),cutState);
  await undo(); sameGraphGeometry(await capture('room-cut-undo-again',[...walls,ref.expressId]),pickState);
  await undo(); sameGraphGeometry(await capture('room-pick-undo',walls),before);
  // Auto, Footprint, Update, Drag/Remove/Prune are separately qualified through
  // actual native MCP controls. This browser producer claims only query/Pick/cut.
  for(let i=walls.length;i>0;i--) { await undo(); await capture(`wall-${i}-undo`,i>1?walls.slice(0,i-1):[1222]); }
  sameGraphGeometry(await capture('room-final',[1222]),baseline);
}).catch(error=>{console.error(error);process.exitCode=1;});
