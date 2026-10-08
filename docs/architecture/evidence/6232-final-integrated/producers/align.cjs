// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const { runSuite, assert } = require('./common.cjs');
runSuite('align', async ({ modelId, baseline, send, capture, undo, sameGraphGeometry }) => {
  const reference = 1222;
  const a = await send('addColumn',[modelId,42,{Position:[20,20,0],Width:.4,Depth:.6,Height:3}]);
  await capture('column-a',[reference,a.expressId]);
  const b = await send('addColumn',[modelId,42,{Position:[30,25,0],Width:.8,Depth:.3,Height:3}]);
  const ids = [reference,a.expressId,b.expressId], before = await capture('align-before',ids);
  const edge = (box, mode) => {
    if (mode==='left') return box.min[0];
    if (mode==='right') return box.max[0];
    if (mode==='top') return box.max[1];
    if (mode==='bottom') return box.min[1];
    const axis=mode==='centre'?0:1; return (box.min[axis]+box.max[axis])/2;
  };
  for(const mode of ['left','centre','right','top','middle','bottom']) {
    await send('alignElements',[modelId,reference,[a.expressId,b.expressId],mode]);
    const after=await capture(`align-${mode}`,ids), ref=after.planBounds.find(box=>box.id===reference);
    const axis=['left','centre','right'].includes(mode)?0:1, deltas=[];
    for(const id of [a.expressId,b.expressId]) {
      const box=after.planBounds.find(box=>box.id===id), old=before.planBounds.find(box=>box.id===id);
      assert.ok(Math.abs(edge(box,mode)-edge(ref,mode))<1e-4, `actual fresh native ${mode} edge #${id}`);
      for(const side of ['min','max']) assert.ok(Math.abs(box[side][1-axis]-old[side][1-axis])<1e-4,'orthogonal coordinates stay fixed');
      deltas.push(box.min[axis]-old.min[axis]);
    }
    assert.ok(Math.abs(deltas[0]-deltas[1])>1,'targets require distinct translations');
    const oldRef=before.planBounds.find(box=>box.id===reference);
    for(const side of ['min','max']) for(let axis=0;axis<2;axis++) assert.ok(Math.abs(ref[side][axis]-oldRef[side][axis])<1e-4,'reference native bounds unchanged');
    assert.equal(after.undo,before.undo+1,'one atomic Align history entry');
    await undo(); sameGraphGeometry(await capture(`align-${mode}-undo`,ids),before);
  }
  await undo(); await capture('column-b-undo',[reference,a.expressId]);
  await undo(); sameGraphGeometry(await capture('column-a-undo',[reference]),baseline);
}).catch(error=>{console.error(error);process.exitCode=1;});
