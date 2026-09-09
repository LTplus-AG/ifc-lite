/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { parseGLBToMeshData } from './glb.js';
import { parseGLBImageResources } from './glb-images.js';
import type { GLTFDocument } from './glb-types.js';

function capture(): { json: GLTFDocument; bin: Uint8Array } {
  // Two triangles duplicate the shared geometric corner with distinct UVs: an atlas seam.
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,1, 0,0,0, 0,1,1, -1,0,0]);
  const uvs = new Float32Array([0,0, 0.5,0, 0.5,1, 1,0, 1,1, 0.5,0]);
  const png = new Uint8Array([137,80,78,71,13,10,26,10]);
  const bin = new Uint8Array(positions.byteLength + uvs.byteLength + png.byteLength);
  bin.set(new Uint8Array(positions.buffer)); bin.set(new Uint8Array(uvs.buffer), positions.byteLength); bin.set(png, positions.byteLength + uvs.byteLength);
  return { bin, json: {
    asset: { version:'2.0' }, nodes:[{ mesh:0, translation:[1000000,20,30], rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2], scale:[2,3,4] }],
    meshes:[{primitives:[{ attributes:{ POSITION:0, TEXCOORD_0:1 }, material:0 }]}],
    buffers:[{byteLength:bin.length}], bufferViews:[{buffer:0,byteLength:positions.byteLength},{buffer:0,byteOffset:positions.byteLength,byteLength:uvs.byteLength},{buffer:0,byteOffset:positions.byteLength+uvs.byteLength,byteLength:png.byteLength}],
    accessors:[{bufferView:0,componentType:5126,count:6,type:'VEC3'},{bufferView:1,componentType:5126,count:6,type:'VEC2'}],
    materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0},baseColorFactor:[0.25,0.5,1,1]}}],
    textures:[{source:0}], images:[{bufferView:2,mimeType:'image/png'}],
  }};
}

describe('captured GLB appearance #4380', () => {
  it('keeps seam UVs, encoded bytes, tint, and georeferenced TRS with inverse-transpose normals', () => {
    const {json,bin}=capture(); const [mesh]=parseGLBToMeshData(json,bin);
    expect([...mesh.uvs!]).toEqual([0,0,0.5,0,0.5,1,1,0,1,1,0.5,0]);
    expect(mesh.origin).toEqual([1000000,20,30]);
    expect(mesh.positions[3]).toBeCloseTo(0); expect(mesh.positions[4]).toBeCloseTo(2);
    expect(mesh.positions[6]).toBeCloseTo(-3); expect(mesh.positions[8]).toBeCloseTo(4);
    const e1=[mesh.positions[3]-mesh.positions[0],mesh.positions[4]-mesh.positions[1],mesh.positions[5]-mesh.positions[2]];
    const e2=[mesh.positions[6]-mesh.positions[0],mesh.positions[7]-mesh.positions[1],mesh.positions[8]-mesh.positions[2]];
    expect(e1.reduce((sum,x,i)=>sum+x*mesh.normals[i],0)).toBeCloseTo(0);
    expect(e2.reduce((sum,x,i)=>sum+x*mesh.normals[i],0)).toBeCloseTo(0);
    expect(mesh.color[0]).toBeCloseTo(0.5370987);
    expect([...parseGLBImageResources(json,bin).get(mesh.textureRef!.url)!]).toEqual([137,80,78,71,13,10,26,10]);
  });
  it('honours OPAQUE material alpha independently of the stored factor', () => {
    const {json,bin}=capture(); json.materials![0].pbrMetallicRoughness!.baseColorFactor=[1,1,1,0];
    expect(parseGLBToMeshData(json,bin)[0].color[3]).toBe(1);
  });
  it('bakes KHR_texture_transform once without flipping glTF top-down V', () => {
    const {json,bin}=capture(); json.materials![0].pbrMetallicRoughness!.baseColorTexture!.extensions={KHR_texture_transform:{offset:[0.2,0.3],scale:[2,3],rotation:Math.PI/2}};
    const [mesh]=parseGLBToMeshData(json,bin); expect(mesh.uvs![2]).toBeCloseTo(0.2); expect(mesh.uvs![3]).toBeCloseTo(1.3);
  });
  it('reverses mirrored winding without reversing UV ownership', () => {
    const {json,bin}=capture(); json.nodes![0].scale=[-1,1,1];
    const [mesh]=parseGLBToMeshData(json,bin); expect([...mesh.indices]).toEqual([0,2,1,3,5,4]); expect(mesh.uvs![6]).toBe(1);
  });
  it('rejects unsupported alpha, wrap, required compression, and image ranges explicitly', () => {
    const {json,bin}=capture(); json.materials![0].alphaMode='BLEND'; expect(()=>parseGLBToMeshData(json,bin)).toThrow(/MASK\/BLEND/);
    delete json.materials![0].alphaMode; json.samplers=[{wrapS:33648}];json.textures![0].sampler=0;expect(()=>parseGLBToMeshData(json,bin)).toThrow(/mirrored/);
    delete json.textures![0].sampler;json.extensionsRequired=['KHR_draco_mesh_compression'];expect(()=>parseGLBToMeshData(json,bin)).toThrow(/required extension/);
    delete json.extensionsRequired;json.bufferViews![2].byteLength=bin.length;expect(()=>parseGLBImageResources(json,bin)).toThrow(/exceeds/);
  });
  it('bounds deep scene walks without consuming the call stack', () => {
    const {json,bin}=capture(); const leaf=json.nodes![0];json.nodes=Array.from({length:12000},(_,i)=>i===11999?leaf:{children:[i+1]});json.scenes=[{nodes:[0]}];
    expect(parseGLBToMeshData(json,bin)).toHaveLength(1);
  });
});
