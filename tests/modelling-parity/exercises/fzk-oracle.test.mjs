/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFzk } from './fzk-oracle.mjs';
import { buildFzk, target } from './fzk.mjs';

// #9314: the target's roof is two IfcSlab(ROOF) planes. The oracle must
// accept that representation and still reject a flat replacement.
test('#9314 roof slab planes pass the reference roof checks; flat planes fail', () => {
  const text="#1=IFCSLAB('a',$,$,$,$,$,$,$,.ROOF.);\n#2=IFCSLAB('b',$,$,$,$,$,$,$,.ROOF.);";
  const plane=(slope,id)=>{
    const width=10, depth=target.roof.totalUpwardArea/(2*width*Math.sqrt(1+slope*slope));
    const a=[0,0,0],b=[width,0,0],c=[0,depth*slope,depth],d=[width,depth*slope,depth];
    const triangles=[[a,c,b],[b,c,d]].map(t=>t.map(p=>id===2?[p[0],p[1]+depth*Math.abs(slope),p[2]+depth]:p));
    return {min:[0,0,0],max:[width,depth*Math.abs(slope),depth*2],triangles};
  };
  const inspect=(slope)=>{
    const rows=[];
    compareFzk({text,find:id=>plane(id===1?slope:-slope,id),levels:[],emit:(name,cap,status)=>rows.push({name,status})});
    return rows.filter(r=>['reference-gable-roof','reference-roof-area'].includes(r.name));
  };
  assert.deepEqual(inspect(Math.tan(Math.PI/6)).map(r=>r.status),['pass','pass']);
  assert.equal(inspect(0).find(r=>r.name==='reference-gable-roof').status,'fail');
});

import { floorArea } from './fzk-oracle.mjs';
import { copyCoverage, spaceAreas } from './export-oracles.mjs';
test('#9314 a labelled single 30 degree plane of 165.12 m2 is not a gable',()=>{
  const slope=Math.tan(Math.PI/6), d=165.12/(10*Math.sqrt(1+slope*slope));
  const triangles=[[[0,0,0],[0,d*slope,d],[10,0,0]],[[10,0,0],[0,d*slope,d],[10,d*slope,d]]];
  const rows=[];
  compareFzk({text:"#1=IFCROOF('a',$,$,$,$,$,$,$,.GABLE_ROOF.);",find:()=>({triangles}),levels:[],emit:(name,cap,status)=>rows.push({name,status})});
  assert.equal(rows.find(r=>r.name==='reference-gable-roof').status,'fail');
  assert.equal(rows.find(r=>r.name==='reference-roof-area').status,'pass');
});
test('#9314 L shaped floor counts triangles rather than its bounding rectangle',()=>{
  const mesh={min:[0,0,0],max:[2,3,2],triangles:[[[0,0,0],[2,0,0],[0,0,1]],[[2,0,0],[2,0,1],[0,0,1]],[[0,0,1],[1,0,1],[0,0,2]],[[1,0,1],[1,0,2],[0,0,2]]]};
  assert.equal(floorArea(mesh),3);
});
test('#9314 target gross area cannot be replaced by a matching net quantity',()=>{
  const wanted=target.spaces[0], area=wanted.area;
  const mesh={triangles:[[[0,0,0],[area,0,0],[0,0,1]],[[area,0,0],[area,0,1],[0,0,1]]]};
  const inspect=(quantity)=>{
    const rows=[];
    compareFzk({text:`#1=IFCSPACE('a',$,'${wanted.name}');\n#2=IFCRELDEFINESBYPROPERTIES('b',$,$,$,(#1),#3);\n#3=IFCELEMENTQUANTITY('c',$,'BaseQuantities',$,$,(#4));\n#4=IFCQUANTITYAREA('${quantity}',$,$,${area});`,find:()=>mesh,levels:[],emit:(name,cap,status)=>rows.push({name,status})});
    return rows.find(r=>r.name===`reference-space-${wanted.name}`).status;
  };
  assert.equal(inspect('GrossFloorArea'),'pass');
  assert.equal(inspect('NetFloorArea'),'fail');
});
test('#9314 missing, shortened and uncontained copy sets fail the planned counts',()=>{
  for(const ids of [[],[1],[1,2]]) {
    const result=copyCoverage([{count:2,storeyId:10,ids}],"#99=IFCRELCONTAINEDINSPATIALSTRUCTURE('a',$,$,$,(#1),#10);");
    assert.equal(result.ok,false); assert.equal(result.expected,2);
  }
  assert.equal(copyCoverage([{count:2,storeyId:10,ids:[1,2]}],"#99=IFCRELCONTAINEDINSPATIALSTRUCTURE('a',$,$,$,(#1,#2),#10);").ok,true);
});
test('#9314 F1 quantity must belong to the intended space',()=>{
  const text="#1=IFCSPACE('a');#2=IFCWALL('b');#3=IFCQUANTITYAREA('NetFloorArea',$,$,20);#4=IFCELEMENTQUANTITY('c',$,'BaseQuantities',$,$,(#3));";
  assert.ok(Number.isNaN(spaceAreas(text+"#5=IFCRELDEFINESBYPROPERTIES('d',$,$,$,(#2),#4);",[1])[0]));
  assert.deepEqual(spaceAreas(text+"#5=IFCRELDEFINESBYPROPERTIES('d',$,$,$,(#1),#4);",[1]),[20]);
});

test('#9357 F2 requests two opposing 30 degree pitches and the reference overhang', () => {
  const roofs = [];
  const levels = target.storeys.map((s, i) => ({ expressId: i + 1, GlobalId: `level-${i}`, Name: s.name, elevation: s.elevation }));
  const bim = { store: {
    listStoreyLevels: () => levels,
    addRoof: (_model, _storey, params) => roofs.push(params),
  } };
  let id = 100;
  buildFzk(bim, {
    M: 'f2', expected: [], openings: [], step: () => {},
    // Isolate the exercise's roof request; the other element callbacks are
    // exercised by F2 itself. References let its wall bookkeeping complete.
    add: (name, _capability, action) => {
      if (name === 'gable-roof-attempt') action();
      return { expressId: id++ };
    },
  });
  assert.equal(roofs.length, 1);
  const roof = roofs[0];
  assert.deepEqual(roof.EdgeSlopes, [Math.PI / 6, 0, Math.PI / 6, 0]);
  assert.equal(roof.Thickness, 0.3);
  assert.deepEqual(roof.Position, [0, 0, 2.7]);
  const area = (roof.Width + 2 * roof.Overhang) * (roof.Depth + 2 * roof.Overhang) / Math.cos(roof.EdgeSlopes[0]);
  assert.ok(Math.abs(area - target.roof.totalUpwardArea) < 0.01, `Expected reference roof area, got ${area}`);
});

// #9357: the roof has no own mesh; the two aggregated slabs carry all geometry.
test('#9357 the F2 gable oracle aggregates roof planes exactly once', () => {
  const text="#10=IFCROOF('r',$,$,$,$,$,$,$,.GABLE_ROOF.);\n#1=IFCSLAB('a',$,$,$,$,$,$,$,.ROOF.);\n#2=IFCSLAB('b',$,$,$,$,$,$,$,.ROOF.);\n#11=IFCRELAGGREGATES('rel',$,$,$,#10,(#1,#2));";
  const slope=Math.tan(Math.PI/6), width=13, depth=5.5, height=depth*slope;
  const a=[0,0,0], b=[width,0,0], c=[0,height,depth], d=[width,height,depth];
  const e=[0,0,2*depth], f=[width,0,2*depth];
  const meshes=new Map([[1,{triangles:[[a,c,b],[b,c,d]]}],[2,{triangles:[[c,e,d],[d,e,f]]}]]);
  const rows=[];
  compareFzk({text,find:id=>meshes.get(id),levels:[],emit:(name,cap,status,reason,metrics)=>rows.push({name,status,metrics})});
  assert.deepEqual(rows.filter(r=>['reference-gable-roof','reference-roof-area'].includes(r.name)).map(r=>r.status),['pass','pass']);
  const area=rows.find(r=>r.name==='reference-roof-area').metrics.area;
  assert.ok(Math.abs(area-165.122177)<1e-5,`aggregate upward area ${area}`);
});

test('#9328 overlapping opposing roof panels cannot certify a gable', () => {
  const slope=Math.tan(Math.PI/6), width=10, depth=target.roof.totalUpwardArea/(2*width*Math.sqrt(1+slope*slope));
  const panel=sign=>{const a=[0,0,0],b=[width,0,0],c=[0,sign*depth*slope,depth],d=[width,sign*depth*slope,depth];return {triangles:[[a,c,b],[b,c,d]]};};
  const rows=[];
  compareFzk({text:"#1=IFCSLAB('a',$,$,$,$,$,$,$,.ROOF.);\n#2=IFCSLAB('b',$,$,$,$,$,$,$,.ROOF.);",find:id=>panel(id===1?1:-1),levels:[],emit:(name,cap,status)=>rows.push({name,status})});
  assert.equal(rows.find(r=>r.name==='reference-gable-roof').status,'fail');
});

test('#9328 opposing roof plans require the same positive-length ridge', async () => {
  const {opposingRoofPlans}=await import('./gable-plan.mjs');
  const up=tri=>{
    const [a,b,c]=tri;
    return (b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2])>0?tri:[a,c,b];
  };
  const face=(z,from,to)=>{
    const a=[0,0,z],b=[10,0,z],c=[from,3,5],d=[to,3,5];
    return [[a,c,b],[b,c,d]].map(up);
  };
  assert.equal(opposingRoofPlans([...face(0,0,10),...face(10,0,10)]),true);
  assert.equal(opposingRoofPlans([...face(0,0,10),...face(10,.5,9.5)]),false);
  // Repeated apex occurrences from two triangles are still a zero-length ridge.
  const apex=(z,x)=>{const a=[0,0,z],b=[10,0,z],m=[5,0,z],p=[x,3,5];return [[a,p,m],[m,p,b]].map(up);};
  assert.equal(opposingRoofPlans([...apex(0,0),...apex(10,10)]),false);
});
