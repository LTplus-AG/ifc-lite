// SPDX-License-Identifier: MPL-2.0
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const [pkg,outfile]=process.argv.slice(2);
const {initSync,IfcAPI}=await import(pathToFileURL(`${pkg}/ifc-lite.js`));
const {decodeInstancedShard}=await import(pathToFileURL('/tmp/ifc-cold-41de/base52/packages/geometry/dist/packed-instanced-decoder.js'));
const wasm=readFileSync(`${pkg}/ifc-lite_bg.wasm`);initSync({module:wasm});
const source=readFileSync('/tmp/ifc-cold-41de/multipart/rust/geometry/tests/fixtures/mapped_instances_multi_item.ifc','utf8');
const rotated=source.replace('#29=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#28,$,$);','#29=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#66,#67,#28,2.,$);').replace('ENDSEC;\nEND-ISO','#66=IFCDIRECTION((0.,1.,0.));\n#67=IFCDIRECTION((-1.,0.,0.));\nENDSEC;\nEND-ISO');
const scaled=source.replace('#29=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#28,$,$);','#29=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#28,2.,$,3.,4.);');
let extra='';
for(let i=0;i<4;i++){const id=100+i*4;extra+=`#${id}=IFCMAPPEDITEM(#18,#27);\n#${id+1}=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#${id}));\n#${id+2}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${id+1}));\n#${id+3}=IFCBUILDINGELEMENTPROXY('Extra${i}',$,'Extra${i}',$,$,#19,#${id+2},$,$);\n`;}
const eight=source.replace('ENDSEC;\nEND-ISO',extra+'ENDSEC;\nEND-ISO');
function collect(col,rows){
 if(!col)return;
 try{for(let i=0;i<col.length;i++){
  const m=col.get(i);try{
   const p=m.positions,origin=m.origin;rows.push({id:m.expressId,item:m.geometryItemId,
    p:Array.from(p,(v,j)=>v+(origin?.[j%3]??0)),n:Array.from(m.normals),indices:Array.from(m.indices),color:Array.from(m.color)});
  }finally{m.free();}
 }}finally{col.free();}
}
function run(api,content,batchSize,partitioned){
 const rows=[];let occurrences=0;
 try{
  const data=new TextEncoder().encode(content),pre=api.buildPrePassOnce(data);
  if(pre.mappedInstancePlan)api.setMappedInstancePlan(pre.mappedInstancePlan);
  for(let off=0;off<pre.jobs.length;off+=batchSize*3){
   const tail=[pre.jobs.slice(off,off+batchSize*3),pre.unitScale,...pre.rtcOffset,pre.needsShift,pre.voidKeys,pre.voidCounts,pre.voidValues,pre.styleIds,pre.styleColors,pre.planeAngleToRadians,pre.materialElementIds,pre.materialColorCounts,pre.materialColors];
   if(!partitioned){collect(api.processGeometryBatch(data,...tail),rows);continue;}
   const p=api.processGeometryBatchPartitioned(data,...tail);
   try{
    collect(p.takeMeshes(),rows);const bytes=p.takeShard();occurrences+=p.instancedOccurrences;
    if(bytes.length){const shard=decodeInstancedShard(bytes);for(const inst of shard.instances){
     const t=shard.templates[inst.templateIndex],m=inst.transform,points=[],normals=[];
     for(let k=0;k<t.positions.length;k+=3){const [x,y,z]=[0,1,2].map(j=>t.positions[k+j]+t.origin[j]);
      // IFNS is native Z-up; MeshDataJs is already Y-up. Match the renderer's (x,z,-y).
      points.push(m[0]*x+m[1]*y+m[2]*z+m[3],m[8]*x+m[9]*y+m[10]*z+m[11],-(m[4]*x+m[5]*y+m[6]*z+m[7]));}
     for(let k=0;k<t.normals.length;k+=3){
      const a=m[0],b=m[1],c=m[2],d=m[4],e=m[5],f=m[6],g=m[8],h=m[9],i=m[10];
      const nx=t.normals[k],ny=t.normals[k+1],nz=t.normals[k+2];
      const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);assert.ok(Math.abs(det)>1e-12);
      const x=((e*i-f*h)*nx+(f*g-d*i)*ny+(d*h-e*g)*nz)/det;
      const y=((c*h-b*i)*nx+(a*i-c*g)*ny+(b*g-a*h)*nz)/det;
      const z=((b*f-c*e)*nx+(c*d-a*f)*ny+(a*e-b*d)*nz)/det;
      const len=Math.hypot(x,y,z)||1;normals.push(x/len,z/len,-y/len);
     }
     rows.push({id:inst.entityId,item:inst.itemId,p:points,n:normals,indices:Array.from(t.indices),color:Array.from(inst.color)});
    }}
   }finally{p.free();}
  }
 }finally{api.clearPrePassCache();}
 rows.sort((a,b)=>a.id-b.id||a.item-b.item);return {rows,occurrences};
}
const api=new IfcAPI(),records=[];
try{
 for(const [name,content] of [['eight-occurrences',eight],['eight-rotation',rotated.replace('ENDSEC;\nEND-ISO',extra+'ENDSEC;\nEND-ISO')],['eight-nonuniform',scaled.replace('ENDSEC;\nEND-ISO',extra+'ENDSEC;\nEND-ISO')],['translation',source],['rotation-scale',rotated],['nonuniform',scaled],['reused-ids-new-source',source.replace('#11=IFCEXTRUDEDAREASOLID(#8,#10,#9,1.0);','#11=IFCEXTRUDEDAREASOLID(#8,#10,#9,2.0);')]]){
  const flat=run(api,content,4,false);assert.equal(flat.rows.length,name.startsWith('eight-')?16:8);
  for(const batch of [1,2,4,64]){
   const part=run(api,content,batch,true);assert.equal(part.rows.length,flat.rows.length);let maxError=0,maxNormalError=0;
   for(let i=0;i<flat.rows.length;i++){
    const a=flat.rows[i],b=part.rows[i];assert.deepEqual([b.id,b.item,b.indices,b.color],[a.id,a.item,a.indices,a.color]);assert.equal(b.p.length,a.p.length);
    assert.equal(b.n.length,a.n.length);
    for(let k=0;k<a.n.length;k++){const error=Math.abs(a.n[k]-b.n[k]);assert.ok(error<1e-4,`${name} batch ${batch}: normal error ${error}`);maxNormalError=Math.max(maxNormalError,error);}
    for(let k=0;k<a.p.length;k++){const error=Math.abs(a.p[k]-b.p[k]);assert.ok(error<1e-4,`${name} batch ${batch}: coordinate error ${error}`);maxError=Math.max(maxError,error);}
   }
   if(name.startsWith('eight-')&&batch===64)assert.ok(part.occurrences>0,'the actual shard path must fire');
   records.push({name,batch,meshes:part.rows.length,instancedOccurrences:part.occurrences,maxCoordinateError:maxError,maxNormalError});
  }
 }
}finally{api.free();}
writeFileSync(outfile,JSON.stringify({wasmSha256:createHash('sha256').update(wasm).digest('hex'),records},null,2)+'\n');
console.log(records);
