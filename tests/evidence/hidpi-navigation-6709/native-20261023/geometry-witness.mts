/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6709: actual published flat fields and canonical placed triangles, including instances.
// Self-contained so Playwright can install the same function without viewer modifications.
export async function captureGeometryBrowser() {
   const state=globalThis.__ifc_lite_viewer_store__.getState(),models=[...state.models.values()];
   if(models.length!==1 || models[0].idOffset!==0 || state.loading || state.geometryStreamingActive) throw Error('Expected the complete canonical single-model publication');
   const model=models[0],result=model.geometryResult;
   if(!result || model.loadState!=='complete' || model.loadError) throw Error('Incomplete geometry publication');
   if(result.pointClouds?.length)throw Error('Unexpected point-cloud domain in the public FZK mesh fixture');
   const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
   const hash=async bytes=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
   const textHash=value=>hash(new TextEncoder().encode(JSON.stringify(value)));
   const normalize=async value=>{
    if(value===undefined)return {kind:'undefined'};
    if(value===null || typeof value==='string' || typeof value==='boolean')return value;
    if(typeof value==='bigint')return {kind:'bigint',value:value.toString()};
    if(typeof value==='number')return {kind:'float64',bytes:hex(new Uint8Array(new Float64Array([value]).buffer))};
    if(ArrayBuffer.isView(value))return {kind:value.constructor.name,length:value.byteLength,sha256:await hash(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))};
    if(value instanceof Map){const rows=[];for(const [key,item] of value)rows.push([await normalize(key),await normalize(item)]);rows.sort((a,b)=>JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));return {kind:'map',rows};}
    if(Array.isArray(value)){const rows=[];for(const item of value)rows.push(await normalize(item));return rows;}
    if(Object.getPrototypeOf(value)!==Object.prototype)throw Error('Unsupported geometry payload type');
    const normalized={};for(const key of Object.keys(value).sort())normalized[key]=await normalize(value[key]);return normalized;
   };
   const source=[];let flatTriangles=0;
   for(const mesh of result.meshes){source.push(await textHash(await normalize(mesh)));flatTriangles+=mesh.indices.length/3;}
   source.sort();
   const ids=[...new Set(model.ifcDataStore.entities.expressId)].sort((a,b)=>a-b);
   const placed=[];let placedTriangles=0,instancedOwners=0;
   for(const id of ids){
    const owner=globalThis.__ifc_lite_scene_owner__(id);
    if(!owner.corners.length)continue;
    if(owner.corners.length%9)throw Error('Malformed canonical placed triangle corners');
    placedTriangles+=owner.corners.length/9;if(owner.instance)instancedOwners++;
    const bytes=new Uint8Array(new Float64Array(owner.corners).buffer);
    placed.push({id,instance:owner.instance,corners:owner.corners.length,sha256:await hash(bytes),parts:await normalize(owner.flat)});
   }
   if(!source.length || !placed.length || !placedTriangles)throw Error('Empty geometry witness');
   const placement=await normalize(result.coordinateInfo);
   const sourceHash=await textHash(source),placedHash=await textHash(placed);
   return {schema:'6709-source-and-all-placed-triangles-v3',models:1,meshes:source.length,flatTriangles,placedTriangles,placedOwners:placed.length,instancedOwners,
    sourceSha256:sourceHash,placedSha256:placedHash,coordinateSha256:await textHash(placement),
    sha256:await textHash({sourceHash,placedHash,placement}),
    scope:'All published flat mesh fields/typed arrays and canonical Scene triangle corners for every semantic owner, including instances; not GPU buffer identity or a raw IFNS byte comparison'};
}

// Match frameProbeInitScript: tsx keep-names helpers are module-scoped.
export function geometryWitnessExpression() {
 return `(() => { const __name = target => target; return (${captureGeometryBrowser.toString()})(); })()`;
}
