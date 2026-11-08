/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { target } from './fzk.mjs';
// This parses exported STEP data, never implementation source text.
export function fields(record) {
  const body=record.slice(record.indexOf('(')+1,-1), result=[];
  let depth=0, quoted=false, start=0;
  for(let i=0;i<body.length;i++) {
    if(body[i]==="'") { if(quoted&&body[i+1]==="'") i++; else quoted=!quoted; }
    if(quoted) continue;
    if(body[i]==='(') depth++;
    if(body[i]===')') depth--;
    if(body[i]===','&&!depth) {result.push(body.slice(start,i));start=i+1;}
  }
  result.push(body.slice(start)); return result;
}
const refs=s=>[...(s||'').matchAll(/#(\d+)/g)].map(m=>Number(m[1]));
export function compareFzk({text,find,levels,emit}) {
  const records=new Map([...text.matchAll(/#(\d+)\s*=\s*([^;]+);/g)].map(m=>[Number(m[1]),m[2]]));
  const type=id=>records.get(id)?.split('(')[0];
  const args=id=>fields(records.get(id)||'X()');
  const children=new Map(), quantities=new Map();
  for(const record of records.values()) {
    if(record.startsWith('IFCRELCONTAINEDINSPATIALSTRUCTURE(')||record.startsWith('IFCRELAGGREGATES(')) {
      const a=fields(record), aggregate=record.startsWith('IFCRELAGGREGATES('), parent=refs(a[aggregate?4:5])[0], ids=refs(a[aggregate?5:4]);
      children.set(parent,[...(children.get(parent)||[]),...ids]);
    }
    if(record.startsWith('IFCRELDEFINESBYPROPERTIES(')) {const a=fields(record);for(const id of refs(a[4])) quantities.set(id,[...(quantities.get(id)||[]),...refs(a[5])]);}
  }
  const check=(name,cap,ok,reason,metrics={})=>emit(`reference-${name}`,cap,ok?'pass':'fail',ok?null:reason,metrics,['tests/modelling-parity/exercises/f2-fzk-haus.target']);
  for(const wanted of target.storeys) {
    const level=levels.find(s=>s.Name===wanted.name), ids=children.get(level?.expressId)||[];
    check(`level-${wanted.name}`,'storeys',level&&Math.abs(level.elevation-wanted.elevation)<=target.tolerances.elevationM.value,`Expected ${wanted.name} at ${wanted.elevation}m`,{actual:level?.elevation});
    for(const [kind,types] of [['walls',['IFCWALL','IFCWALLSTANDARDCASE']],['doors',['IFCDOOR']],['windows',['IFCWINDOW']]]) {
      const actual=ids.filter(id=>types.includes(type(id))), expected=wanted[kind].count;
      const tolerance=kind==='walls'?target.tolerances.wallCountPerStorey.value*expected:0;
      check(`${wanted.name}-${kind}` ,kind==='walls'?'wall-chains-autojoin':'hosted-doors-windows-from-types',Math.abs(actual.length-expected)<=tolerance,`Expected ${expected} ${kind}, got ${actual.length}`,{actual:actual.length,expected});
      if(kind==='walls') {
        const boxes=actual.map(find).filter(Boolean), length=boxes.reduce((n,b)=>n+Math.max(b.max[0]-b.min[0],b.max[2]-b.min[2]),0);
        check(`${wanted.name}-wall-length`,'wall-chains-autojoin',boxes.length===actual.length&&Math.abs(length-wanted.walls.totalLength)<=wanted.walls.totalLength*target.tolerances.wallTotalLengthPerStorey.value,`Expected wall length ${wanted.walls.totalLength}m ±5%, got mesh-axis extents ${length}m`,{length});
      } else {
        const sizes=Object.entries(wanted[kind].widthXHeight).flatMap(([s,n])=>Array.from({length:n},()=>s.split('x').map(Number)));
        let matches=0;
        for(const id of actual) {const a=args(id), h=Number(a[8]),w=Number(a[9]);const index=sizes.findIndex(([W,H])=>Math.abs(w-W)<=target.tolerances.openingSizeM.value&&Math.abs(h-H)<=target.tolerances.openingSizeM.value);if(index>=0){matches++;sizes.splice(index,1);}}
        check(`${wanted.name}-${kind}-sizes`,'hosted-doors-windows-from-types',matches===actual.length&&!sizes.length,`Opening sizes do not match target histogram (${matches} matched; ${sizes.length} missing)`,{matches});
      }
    }
  }
  const all=[...records.keys()];
  for(const [kind,T,cap] of [['stairs','IFCSTAIR','stairs-railings'],['spaces','IFCSPACE','rooms-with-area'],['beams','IFCBEAM','columns-beams-on-grid-follow-levels'],['slabs','IFCSLAB','slab-with-openings']]) {
    const count=all.filter(id=>type(id)===T&&(T!=='IFCSLAB'||args(id)[8]!=='.ROOF.')).length;
    check(`${kind}-total`,cap,count===target.totals[kind],`Expected ${target.totals[kind]} ${kind}; got ${count}`,{count});
  }
  const ground=levels.find(s=>s.Name===target.footprint.storey);
  const boxes=(children.get(ground?.expressId)||[]).filter(id=>['IFCWALL','IFCWALLSTANDARDCASE','IFCSLAB'].includes(type(id))).map(find).filter(Boolean);
  const extent=k=>Math.max(...boxes.map(b=>b.max[k]))-Math.min(...boxes.map(b=>b.min[k]));
  const width=extent(0), depth=extent(2), tol=target.tolerances.footprintBboxM.value;
  check('footprint','wall-chains-autojoin',Math.abs(width-target.footprint.bboxWidthX)<=tol&&Math.abs(depth-target.footprint.bboxDepthY)<=tol,`Expected 12×10m footprint ±${tol}m; got ${width}×${depth}`,{width,depth});
  for(const wanted of target.spaces) {
    const id=all.find(id=>type(id)==='IFCSPACE'&&args(id)[2]===`'${wanted.name}'`), mesh=id&&find(id);
    const area=mesh?floorArea(mesh):NaN;
    const qtos=quantities.get(id)||[], areaIds=qtos.flatMap(q=>refs(args(q).at(-1))), quantity=areaIds.find(q=>type(q)==='IFCQUANTITYAREA'&&args(q)[0]===`'${wanted.areaProperty.name.split('.').at(-1)}'`);
    const qArea=quantity?Number(args(quantity)[3]):NaN, allowed=wanted.area*target.tolerances.spaceAreaM2.value;
    check(`space-${wanted.name}`,'rooms-with-area',Math.abs(area-wanted.area)<=allowed&&Math.abs(qArea-wanted.areaProperty.value)<=allowed,`Space ${wanted.name}: expected ${wanted.area}m² ±5%; mesh ${area}, quantity ${qArea}`,{area,quantity:qArea,expected:wanted.area});
  }
  const roofs=all.filter(id=>type(id)==='IFCROOF'||(type(id)==='IFCSLAB'&&args(id)[8]==='.ROOF.'));
  // Flatten roof aggregates once so a roof slab represented under IfcRoof is
  // neither omitted nor counted twice when its parent mesh includes children.
  const pending=[...roofs], seen=new Set(), parts=[];
  while(pending.length) {
    const id=pending.pop(); if(seen.has(id)) continue; seen.add(id);
    const nested=children.get(id)||[];
    if(nested.length) pending.push(...nested); else parts.push(id);
  }
  const roofMeshes=parts.map(find).filter(Boolean);
  let total=0, inclined=0;
  const directions=[];
  for(const mesh of roofMeshes) for(const [a,b,c] of mesh.triangles) {
    const u=b.map((v,k)=>v-a[k]),v=c.map((n,k)=>n-a[k]),n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n);
    if(n[1]<=1e-8) continue;
    const area=length/2, tilt=Math.acos(Math.min(1,n[1]/length))*180/Math.PI;total+=area;
    if(Math.abs(tilt-30)<=target.tolerances.roofSlopeDeg.value) {
      inclined+=area; const horizontal=Math.hypot(n[0],n[2]);
      if(horizontal>0) directions.push([n[0]/horizontal,n[2]/horizontal]);
    }
  }
  check('gable-roof','roof-by-footprint',total>0&&inclined>total*0.9&&(directions.some(a=>directions.some(b=>a[0]*b[0]+a[1]*b[1]<-0.99))),'Expected two opposing roof planes at 30° within tolerance',{upwardArea:total,areaAt30Deg:inclined});
  check('roof-area','roof-by-footprint',Math.abs(total-target.roof.totalUpwardArea)<=target.roof.totalUpwardArea*target.tolerances.roofSlopeAreaShare.value,`Reference upward roof area ${target.roof.totalUpwardArea}m² ±10%; got ${total}`,{area:total});
}

// #9314: project only downward-facing floor triangles, not the bounding box.
export function floorArea(mesh) {
  return mesh.triangles.reduce((sum,[a,b,c])=>{
    const ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);
    return sum+(ny < -1e-8 ? -ny/2 : 0);
  },0);
}
