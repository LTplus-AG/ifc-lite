// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
'use strict';
const { runSuite, assert } = require('./common.cjs');
runSuite('placement', async ({ modelId, baseline, send, capture, undo, sameGraphGeometry }) => {
  const nativeIds = snapshot => [...new Set(snapshot.meshes.map(mesh => mesh.localId))];
  const isType = (row, type) => row.type.toUpperCase() === type.toUpperCase();
  const rowOf = (snapshot, id, type) => {
    const row = snapshot.graph.find(row => row.id === id);
    assert.ok(row && isType(row, type), `Actual exported #${id} must be ${type}`);
    return row;
  };
  const boundsOf = (snapshot, id) => {
    const box = snapshot.sourceNative.bounds.find(box => box.id === id);
    assert.ok(box, `Actual native bounds required for #${id}`); return box;
  };
  const changed = async (stage, action, before = baseline, explicitIds) => {
    const ref = await action();
    assert.equal(ref.modelId, modelId, `${stage} resolves the selected model`);
    const provisional = await capture(`${stage}-graph`);
    assert.notEqual(provisional.graphHash, before.graphHash, `${stage} changes exported IFC`);
    assert.equal(provisional.undo, before.undo + 1, `${stage} records exactly one Undo`);
    const previousIds = new Set(before.graph.map(row => row.id));
    const meshedTypes = new Set(['IFCSLAB','IFCBEAM','IFCSTAIRFLIGHT','IFCRAILING','IFCMEMBER','IFCPLATE','IFCCOLUMN']);
    const ids = explicitIds ? explicitIds(ref) : provisional.graph.filter(row => !previousIds.has(row.id) && meshedTypes.has(row.type.toUpperCase())).map(row => row.id);
    assert.ok(ids.length, `${stage} must create or change real meshes`);
    const after = await capture(stage, ids);
    assert.notEqual(after.geometryHash, before.geometryHash, `${stage} changes actual owning-model geometry`);
    await undo();
    sameGraphGeometry(await capture(`${stage}-undo`, nativeIds(before)), before);
    return { ref, after };
  };
  for (const [stage, method, type, params] of [
    ['slab', 'addSlab', 'IfcSlab', { Position:[0,-6,0], Width:4, Depth:3, Thickness:.2, Name:'Qualified browser slab' }],
    ['beam', 'addBeam', 'IfcBeam', { Start:[0,-6,3], End:[4,-6,3], Width:.2, Height:.3, Name:'Qualified browser beam' }],
    ['stair', 'addStair', 'IfcStair', { Position:[0,-6,0], NumberOfRisers:10, RiserHeight:.18, TreadLength:.28, Width:1, Name:'Qualified browser stair' }],
    ['railing', 'addRailing', 'IfcRailing', { Path:[[0,-6,0],[4,-6,0]], Height:1.1, PostSpacing:1, Name:'Qualified browser railing' }],
    ['curtain-wall', 'addCurtainWall', 'IfcCurtainWall', { Start:[0,-6,0], End:[4,-6,0], Height:3, UGrid:2, VGrid:2, Name:'Qualified browser curtain wall' }],
  ]) {
    const { ref, after } = await changed(stage, () => send(method, [modelId,42,params]));
    rowOf(after, ref.expressId, type);
    if (stage === 'stair') {
      assert.ok(after.graph.some(row => isType(row,'IfcRelAggregates') && row.attributes[4] === ref.expressId));
      assert.ok(after.graph.some(row => isType(row,'IfcStairFlight') && after.sourceNative.bounds.some(box => box.id === row.id)));
    }
    if (stage === 'curtain-wall') for (const type of ['IfcMember','IfcPlate']) {
      assert.ok(after.graph.some(row => isType(row,type) && after.sourceNative.bounds.some(box => box.id === row.id)), `${type} has actual native geometry`);
    }
  }
  // IfcGrid axes are persisted curves, not triangle meshes. The grid-bound
  // column proves their actual native placement; no fabricated grid bounds.
  const grid = await send('addGrid', [modelId,42,{ UAxes:[{Tag:'U',Start:[0,-6],End:[4,-6]}], VAxes:[{Tag:'V',Start:[2,-8],End:[2,-4]}], Name:'Qualified browser grid' }]);
  assert.equal(grid.modelId, modelId);
  const gridBefore = await capture('grid', [1222]);
  const gridRow = rowOf(gridBefore, grid.expressId, 'IfcGrid');
  assert.notEqual(gridBefore.graphHash, baseline.graphHash);
  assert.equal(gridBefore.undo, baseline.undo+1);
  const axes = [...gridRow.attributes[7],...gridRow.attributes[8]];
  assert.equal(axes.length,2);
  for (const id of axes) rowOf(gridBefore,id,'IfcGridAxis');
  const {ref: column, after: boundColumn} = await changed('grid-column', () => send('addColumnOnGrid', [modelId,42,{ Position:[2,-6,0], Profile:{Type:'Circle',Radius:.2}, Height:3, Name:'Qualified grid-bound column' },{GridId:grid.expressId,IntersectingAxes:axes}]), gridBefore);
  rowOf(boundColumn,column.expressId,'IfcColumn');
  assert.ok(boundColumn.graph.some(row=>isType(row,'IfcVirtualGridIntersection') && JSON.stringify(row.attributes[0])===JSON.stringify(axes)));
  const box=boundsOf(boundColumn,column.expressId);
  assert.ok(Math.abs((box.min[0]+box.max[0])/2-2)<.002 && Math.abs((box.min[1]+box.max[1])/2+6)<.002, 'Native column centre coincides with persisted grid intersection');
  assert.ok(Math.abs(box.min[2])<.002 && Math.abs(box.max[2]-3)<.002, 'Native grid column has requested height');
  await undo(); sameGraphGeometry(await capture('grid-undo', [1222]),baseline);

  const host = await send('addWall',[modelId,42,{Start:[0,-8,0],End:[10,-8,0],Height:3,Thickness:.2,Name:'Qualified browser host'}]);
  const hostBefore=await capture('host',[host.expressId]);
  for (const [stage,method,type,params] of [
    ['opening','addOpening','IfcOpeningElement',{Offset:2,Sill:1,Width:1,Height:1}],
    ['door','addHostedDoor','IfcDoor',{Offset:2,Width:.9,Height:2.1}],
    ['window','addHostedWindow','IfcWindow',{Offset:5,Sill:1,Width:1.2,Height:1.2}],
  ]) {
    const {ref,after}=await changed(stage,()=>send(method,[modelId,host.expressId,params]),hostBefore,ref=>stage==='opening'?[host.expressId]:[host.expressId,ref.expressId]);
    rowOf(after,ref.expressId,type);
    const beforeHost=hostBefore.meshes.filter(mesh=>mesh.localId===host.expressId), afterHost=after.meshes.filter(mesh=>mesh.localId===host.expressId);
    assert.notDeepEqual(afterHost,beforeHost,`${stage} cuts the actual host mesh`);
    const voids=after.graph.filter(row=>isType(row,'IfcRelVoidsElement') && row.attributes[4]===host.expressId);
    assert.ok(voids.length);
    if(stage!=='opening') assert.ok(after.graph.some(row=>isType(row,'IfcRelFillsElement') && row.attributes[5]===ref.expressId));
  }
  const filling=await send('addHostedDoor',[modelId,host.expressId,{Offset:2,Width:.9,Height:2.1}]);
  const fillingBefore=await capture('slide-door',[host.expressId,filling.expressId]);
  // editHostedElement is the existing canonical hosted.slide writer.
  const slide=await send('editHostedElement',[filling,{Offset:3}]);
  const afterSlide=await capture('hosted-slide',[host.expressId,filling.expressId]);
  assert.notEqual(afterSlide.graphHash,fillingBefore.graphHash);
  assert.notEqual(afterSlide.geometryHash,fillingBefore.geometryHash);
  assert.equal(afterSlide.undo,fillingBefore.undo+1);
  const oldBox=boundsOf(fillingBefore,filling.expressId),newBox=boundsOf(afterSlide,filling.expressId);
  for(const edge of ['min','max']) {
    assert.ok(Math.abs(newBox[edge][0]-oldBox[edge][0]-1)<.002,'Native filling slides one metre along host');
    for(const axis of [1,2]) assert.ok(Math.abs(newBox[edge][axis]-oldBox[edge][axis])<.002,'Slide preserves orthogonal coordinates');
  }
  assert.ok(slide !== undefined, 'Public hosted writer returns its canonical result');
  await undo(); sameGraphGeometry(await capture('hosted-slide-undo',[host.expressId,filling.expressId]),fillingBefore);
  await undo(); sameGraphGeometry(await capture('slide-door-undo',[host.expressId]),hostBefore);
  await undo(); sameGraphGeometry(await capture('host-undo',[1222]),baseline);
}).catch(error=>{ console.error(error); process.exitCode=1; });
