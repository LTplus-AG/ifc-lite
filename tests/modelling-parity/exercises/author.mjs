/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { writeFileSync, appendFileSync } from 'node:fs';

// Executed by the real CLI run command; every mutation uses its headless SDK.
export async function author(bim) {
  const { EXERCISE: id, EXERCISE_OUT: out } = process.env;
  const floors = Number(process.env.FLOORS);
  const M = bim.model.activeId(), start = performance.now();
  let peak = 0, elements = 0, actions = 0;
  const expected = [], openings = [], shafts = []; let movedWall=null; const quantityIds=[];
  const sample = () => { peak = Math.max(peak, process.memoryUsage().heapUsed); writeFileSync(`${out}/progress.state`,JSON.stringify({elements,peakHeap:peak,ms:performance.now()-start,actions})); };
  const step = (name, capability, fn) => {
    const t = performance.now(); sample();
    try { const r = fn(); sample(); actions++;
      appendFileSync(`${out}/author.jsonl`, JSON.stringify({ name, capability, status: 'pass', metrics: { ms: performance.now()-t, peakHeap:peak, elements } })+'\n'); return r;
    } catch (e) {
      appendFileSync(`${out}/author.jsonl`, JSON.stringify({ name, capability, status: 'fail', reason: e.message, metrics: { ms: performance.now()-t, peakHeap:peak, elements } })+'\n');
      return null;
    }
  };
  const levels = () => bim.store.listStoreyLevels(M).slice().sort((a,b)=>a.elevation-b.elevation);
  const base = levels()[0];
  const add = (name, cap, fn) => { const ref = step(name, cap, fn); if (ref) { elements++; if(id==='F6') quantityIds.push(ref.expressId); } return ref; };
  if (id === 'F6') {
    const walls = bim.query().byType('IfcWall').toArray().concat(bim.query().byType('IfcWallStandardCase').toArray());
    const wall = walls[0]?.ref; movedWall=wall?.expressId; if(wall) quantityIds.push(wall.expressId);
    step('add-storey', 'storeys', () => bim.store.addStorey(M, { Name:'Parity new storey', Elevation: Math.max(...levels().map(s=>s.elevation))+3 }));
    step('move-wall', 'transforms-move-copy-rotate-mirror-array', () => {
      if (!wall) throw new Error('Fixture has no wall');
      return bim.store.transformElements(M, [wall.expressId], { kind:'move', delta:[1,0] });
    });
    add('door', 'hosted-doors-windows-from-types', () => bim.store.addHostedDoor(M, wall.expressId, { Offset:1, Width:0.9, Height:2.1 }));
  } else {
    const tall = id === 'F4' || id === 'F5';
    const W = id==='F1'?5:id==='F2'?10:id==='F4'?24:36;
    const D = id==='F1'?4:id==='F2'?8:id==='F4'?18:36;
    const h = tall ? 3.8 : 3;
    for (let i=1;i<=floors;i++) step(`storey-${i}`, 'storeys', () => bim.store.addStorey(M, { Name:i===floors?'Roof':`L${i}`, Elevation:i*h }));
    const ls = levels(), typical = [];
    const make = (name,cap,fn) => { const r=add(name,cap,fn); if(r&&cap!=='rooms-with-area') typical.push(r.expressId); return r; };
    const s = base.expressId;
    if (tall) {
      const xs = Array.from({length:7},(_,i)=>i*W/6), ys = Array.from({length:7},(_,i)=>i*D/6);
      const grid = add('grid', 'grids', () => bim.store.addGrid(M,s, { UAxes:xs.map((x,i)=>({Tag:`U${i}`,Start:[x,-1],End:[x,D+1]})), VAxes:ys.map((y,i)=>({Tag:`V${i}`,Start:[-1,y],End:[W+1,y]})) }));
      const axes = Object.fromEntries(bim.query().byType('IfcGridAxis').toArray().map(a=>[bim.attributes(a.ref).find(x=>x.name==='AxisTag')?.value,a.ref.expressId]));
      for(let i=0;i<7;i++) for(let j=0;j<7;j++) {
        if(i>=2&&i<=4&&j>=2&&j<=4) continue;
        const r=make(`column-${i}-${j}`,'columns-beams-on-grid-follow-levels',()=>bim.store.addColumnOnGrid(M,s,{Position:[xs[i],ys[j],0],Width:0.6,Depth:0.6,Height:h},{GridId:grid.expressId,IntersectingAxes:[axes[`U${i}`],axes[`V${j}`]]}));
        if(r) expected.push({expressId:r.expressId,kind:'column',min:0,max:6});
      }
    }
    const corners = tall ? [[W/3,D/3],[2*W/3,D/3],[2*W/3,2*D/3],[W/3,2*D/3]] : [[0,0],[W,0],[W,D],[0,D]];
    const walls = corners.map((a,i)=>make(`wall-${i}`,'wall-chains-autojoin',()=>bim.store.addWall(M,s,{Start:[...a,0],End:[...corners[(i+1)%4],0],Thickness:0.25,Height:h,Name:`Parity wall ${i}`})));
    for(let i=0;i<4;i++) if(walls[i]) {
      step(`attach-${i}`,'wall-top-base-constraints',()=>bim.mutate.setProperty(walls[i], 'IfcLite_StoreyAttachment','TopConstraint',ls[1].GlobalId,'IfcLabel'));
      step(`join-${i}`,'wall-chains-autojoin',()=>bim.store.joinWalls(M,walls[i].expressId,walls[(i+1)%4].expressId));
      expected.push({expressId:walls[i].expressId,kind:'wall',min:0,max:tall?6:3.3});
    }
    const slab=make('slab','slab-with-openings',()=>bim.store.addSlab(M,s,{Position:[0,0,0],Width:W,Depth:D,Thickness:0.2,ExtrudedDirection:[0,0,-1]}));
    if(tall&&slab) {
      add('shaft-opening','slab-with-openings',()=>bim.store.addOpening(M,slab.expressId,{Position:[W/2-1,D/2],Width:2,Depth:2}));
      shafts.push({expressId:slab.expressId,x:W/2-1,y:D/2});
    }
    make('door','hosted-doors-windows-from-types',()=>bim.store.addHostedDoor(M,walls[0].expressId,{Offset:1,Width:0.9,Height:2.1}));
    // Door centre: a ray through the host must miss the wall, beside it must hit.
    openings.push({expressId:walls[0].expressId,x:corners[0][0]+1.13,z:1,y:corners[0][1]});
    if(!tall) {
      make('window','hosted-doors-windows-from-types',()=>bim.store.addHostedWindow(M,walls[2].expressId,{Offset:1,Sill:0.9,Width:1.2,Height:1.4}));
      openings.push({expressId:walls[2].expressId,x:W-1.13,z:1.6,y:D});
      make('space','rooms-with-area',()=>bim.store.addSpace(M,s,{Position:[0,0,0],Width:W,Depth:D,Height:h}));
    } else {
      make('shaft','slab-with-openings',()=>bim.store.addWall(M,s,{Start:[W/2,D/3,0],End:[W/2,2*D/3,0],Thickness:0.2,Height:h}));
      for(let i=0;i<4;i++) {
        const a=[[0,0],[W,0],[W,D],[0,D]][i], b=[[W,0],[W,D],[0,D],[0,0]][i];
        const r=make(`curtain-${i}`,'curtain-walls',()=>bim.store.addCurtainWall(M,s,{Start:[...a,0],End:[...b,0],Height:h,UGrid:6,VGrid:2}));
        if(r) expected.push({expressId:r.expressId,kind:'curtain',min:0,max:6});
      }
    }
    if(id!=='F1') {
      const r=make('stair','stairs-railings',()=>bim.store.addStair(M,s,{Position:[W/3+1,D/3+1,0],NumberOfRisers:20,RiserHeight:h/20,TreadLength:0.25,Width:1}));
      if(r) expected.push({expressId:r.expressId,kind:'stair',min:0,max:tall?6:3.3});
      make('railing','stairs-railings',()=>bim.store.addRailing(M,s,{Path:[[1,1,0.9],[1,5,h+0.9]],Height:0.9}));
    }
    for(let i=1;i<floors;i++) {
      const copies=step(`copy-level-${i}`,'copy-to-levels',()=>bim.store.copyElements(M,typical,[{offset:[0,0,0],targetStoreyId:ls[i].expressId}]));
      if(copies) {
        elements+=copies.length;
        // A copied wall must follow its own next level, not the original GUID.
        for(let k=0;k<copies.length;k++) {
          const origin=expected.find(e=>e.expressId===typical[k]);
          if(origin) expected.push({...origin,expressId:copies[k].expressId,min:i*h+(tall?6:3.3)-h,max:(i+1)*h+(tall?6:3.3)-h,copied:true});
        }
      }
    }
    if(id==='F2') make('upper-space','rooms-with-area',()=>bim.store.addSpace(M,ls[1].expressId,{Position:[0,0,0],Width:W,Depth:D,Height:h}));
    if(id==='F2') add('hip-roof-attempt','roof-by-footprint',()=>bim.store.addRoof(M,ls.at(-1).expressId,{Profile:'polygon',OuterCurve:[[-0.3,-0.3],[W+0.3,-0.3],[W+0.3,D+0.3],[-0.3,D+0.3]],Thickness:0.3,RoofType:'HIP_ROOF',Slope:30}));
    step('raise-floor','storeys',()=>bim.store.editStorey(M,{kind:'floorHeight',storeyId:s,Height:tall?6:3.3}));
    const actual=levels();
    step('storey-elevations-oracle','storeys',()=>{
      for(let i=1;i<actual.length;i++) if(Math.abs(actual[i].elevation-(i*h+(tall?6:3.3)-h))>1e-6) throw new Error(`Storey ${i}: ${actual[i].elevation}`);
    });
  }
  for(const schema of ['IFC4','IFC2X3']) step(`export-${schema}`,'psets-classification-valid-ifc4',()=>writeFileSync(`${out}/${schema}.ifc`,bim.export.ifc(null,{schema})));
  sample();
  writeFileSync(`${out}/expected.state`,JSON.stringify({expected,openings,shafts,movedWall,quantityIds,levels:levels(),elements,peakHeap:peak,actions,ms:performance.now()-start}));
}
