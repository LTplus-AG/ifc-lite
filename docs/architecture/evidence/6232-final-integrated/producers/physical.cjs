// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const { runSuite, assert } = require('./common.cjs');
runSuite('physical', async ({ modelId, baseline, send, capture, undo, sameGraphGeometry }) => {
  const changed = async (label, action, nativeIds, before = baseline) => {
    const result = await action();
    const ids = typeof nativeIds === 'function' ? nativeIds(result) : nativeIds;
    const after = await capture(label, ids);
    assert.notEqual(after.graphHash, before.graphHash, `${label} changes exported IFC`);
    assert.notEqual(after.geometryHash, before.geometryHash, `${label} changes actual geometry`);
    assert.equal(after.undo, before.undo + 1, `${label} records one Undo`);
    await undo(); sameGraphGeometry(await capture(`${label}-undo`, before.planBounds?.map(box=>box.id) ?? [1222]), before);
    return result;
  };
  await changed('paste', () => send('copyElements', [modelId,[1222,1262],[{offset:[0,-4,0]}]]), rows => {
    assert.equal(rows.length,1); return rows.map(row=>row.expressId);
  });
  await changed('duplicate', () => send('duplicateElement', [{modelId,expressId:1222},{offset:[0,-4,0],Name:'Qualified duplicate'}]), row=>[row.expressId]);
  await changed('array', () => send('arrayElements', [modelId,[1222,1262],{mode:'linear',count:3,anchor:[0,0],cursor:[0,-1],distance:4}]), rows=> {
    assert.equal(rows.length,2); return rows.map(row=>row.expressId);
  });
  await changed('move', ()=>send('transformElements',[modelId,[1222],{kind:'move',delta:[0,-2]}]), [1222]);
  await changed('rotate', ()=>send('transformElements',[modelId,[1222],{kind:'rotate',pivot:[0,0],angle:Math.PI/6}]), [1222]);
  const wall = await send('addWall',[modelId,42,{Start:[0,-4,0],End:[4,-4,0],Height:3,Thickness:.2,Name:'Physical parity wall'}]);
  const authored = await capture('authored-wall',[wall.expressId]);
  await changed('size',()=>send('setElementSize',[wall,{kind:'wall',Height:4}]),[wall.expressId],authored);
  await changed('endpoints',()=>send('resizeWall',[wall,[0,-4,0],[5,-4,0]]),[wall.expressId],authored);
  await changed('trim',()=>send('trimExtendElement',[wall,{mode:'trim',click:[3.5,-4],boundary:{a:[3,-5],b:[3,-3],tMin:0,tMax:1,reach:10}}]),[wall.expressId],authored);
  await changed('split',()=>send('splitElements',[modelId,[{expressId:wall.expressId,cut:{kind:'wall',distance:1.5}}]]),rows=> {
    assert.equal(rows.length,1); return [wall.expressId,rows[0].added.expressId];
  },authored);
  await undo(); sameGraphGeometry(await capture('authored-wall-undo',[1222]),baseline);
}).catch(error=>{ console.error(error); process.exitCode=1; });
