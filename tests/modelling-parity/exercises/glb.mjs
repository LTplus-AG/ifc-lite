/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const mul = (a,b) => Array.from({length:16},(_,i)=>Array.from({length:4},(_,k)=>a[i%4+k*4]*b[k+Math.floor(i/4)*4]).reduce((s,v)=>s+v,0));
export function meshes(path) {
  const b=readFileSync(path), len=b.readUInt32LE(12), j=JSON.parse(b.subarray(20,20+len).toString());
  const bin=b.subarray(28+len), rows=[];
  const accessor = ai => {
    const a=j.accessors[ai], v=j.bufferViews[a.bufferView];
    const n={SCALAR:1,VEC3:3}[a.type], size={5126:4,5125:4,5123:2,5121:1}[a.componentType];
    if(!n||!size) throw new Error('Unsupported GLB accessor');
    const read={5126:'readFloatLE',5125:'readUInt32LE',5123:'readUInt16LE',5121:'readUInt8'}[a.componentType];
    return Array.from({length:a.count},(_,i)=>Array.from({length:n},(_,k)=>bin[read]((v.byteOffset||0)+(a.byteOffset||0)+i*(v.byteStride||n*size)+k*size)));
  };
  const walk=(ni,parent)=>{
    const node=j.nodes[ni];
    if(node.rotation || node.scale) throw new Error('TRS rotation/scale not supported by exercise oracle');
    const local=node.matrix||identity.map((v,i)=>i>=12&&i<15?(node.translation||[0,0,0])[i-12]:v), m=mul(parent,local);
    if(node.mesh!==undefined) {
      const triangles=[], points=[];
      for(const p of j.meshes[node.mesh].primitives) {
        const verts=accessor(p.attributes.POSITION).map(v=>[0,1,2].map(i=>m[i]*v[0]+m[i+4]*v[1]+m[i+8]*v[2]+m[i+12]));
        const ids=p.indices===undefined?verts.map((_,i)=>i):accessor(p.indices).flat();
        points.push(...verts);
        for(let k=0;k<ids.length;k+=3) triangles.push(ids.slice(k,k+3).map(i=>verts[i]));
      }
      rows.push({name:node.name||j.meshes[node.mesh].name,expressId:node.extras?.expressId,triangles,min:[0,1,2].map(k=>Math.min(...points.map(v=>v[k]))),max:[0,1,2].map(k=>Math.max(...points.map(v=>v[k])))});
    }
    for(const c of node.children||[]) walk(c,m);
  };
  for(const n of j.scenes[j.scene||0].nodes) walk(n,identity);
  return rows;
}
// Ray parallel to Y: project triangles onto XZ and test barycentric coverage.
export function wallHit(mesh,x,z) {
  return mesh.triangles.some(([a,b,c])=>{
    const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
    if(Math.abs(d)<1e-10) return false;
    const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(z-c[1]))/d;
    const v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(z-c[1]))/d;
    return u>1e-6&&v>1e-6&&u+v<1-1e-6;
  });
}
