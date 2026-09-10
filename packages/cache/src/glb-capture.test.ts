/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { parseGLBToMeshData } from './glb.js';
import { parseGLBImageResources } from './glb-images.js';
import type { GLTFDocument } from './glb-types.js';

function capture(png = new Uint8Array([137,80,78,71,13,10,26,10])): { json: GLTFDocument; bin: Uint8Array } {
  // Two triangles duplicate the shared geometric corner with distinct UVs: an atlas seam.
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,1, 0,0,0, 0,1,1, -1,0,0]);
  const uvs = new Float32Array([0,0, 0.5,0, 0.5,1, 1,0, 1,1, 0.5,0]);
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
  it('retains the supported base colour from a typical photogrammetry material', () => {
    const {json,bin}=capture();
    const material=json.materials![0];
    material.alphaMode='BLEND'; material.normalTexture={index:1}; material.occlusionTexture={index:2};
    material.emissiveTexture={index:3}; material.pbrMetallicRoughness!.metallicRoughnessTexture={index:4};
    material.extensions={KHR_materials_specular:{specularFactor:0.5}};
    json.meshes![0].primitives[0].targets=[{POSITION:4}];
    json.meshes![0].primitives[0].attributes.COLOR_0=5;
    json.extensionsRequired=['KHR_materials_specular'];
    expect(parseGLBToMeshData(json,bin)[0].textureRef?.url).toBe('textures/glb-image-0.png');
  });
  it('reads the base colour texture coordinate set selected by the material', () => {
    const {json,bin}=capture();
    json.meshes![0].primitives[0].attributes.TEXCOORD_1=json.meshes![0].primitives[0].attributes.TEXCOORD_0;
    delete json.meshes![0].primitives[0].attributes.TEXCOORD_0;
    json.materials![0].pbrMetallicRoughness!.baseColorTexture!.texCoord=1;
    expect([...parseGLBToMeshData(json,bin)[0].uvs!]).toEqual([0,0,0.5,0,0.5,1,1,0,1,1,0.5,0]);
  });
  it('rejects unsupported wrap, required compression, and image ranges explicitly', () => {
    const {json,bin}=capture(); json.samplers=[{wrapS:33648}];json.textures![0].sampler=0;expect(()=>parseGLBToMeshData(json,bin)).toThrow(/mirrored/);
    delete json.textures![0].sampler;json.extensionsRequired=['KHR_draco_mesh_compression'];expect(()=>parseGLBToMeshData(json,bin)).toThrow(/Draco-compressed.*uncompressed/);
    delete json.extensionsRequired;json.bufferViews![2].byteLength=bin.length;expect(()=>parseGLBImageResources(json,bin)).toThrow(/exceeds/);
  });
  it('rejects required legacy specular-glossiness instead of inventing a base colour', () => {
    const {json,bin}=capture(); json.extensionsRequired=['KHR_materials_pbrSpecularGlossiness'];
    expect(()=>parseGLBToMeshData(json,bin)).toThrow(/specular-glossiness.*base-colour/);
  });
  it('rejects mismatched MIME/signatures before geometry or resource copying', () => {
    const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DAAAAEAQEARwbK3gAAAABJRU5ErkJggg==', 'base64'));
    const {json,bin} = capture(png);
    expect(parseGLBImageResources(json,bin).get('textures/glb-image-0.png')).toEqual(png);
    json.images![0].mimeType='image/jpeg';
    expect(()=>parseGLBToMeshData(json,bin)).toThrow(/signature.*MIME/);
    expect(()=>parseGLBImageResources(json,bin)).toThrow(/signature.*MIME/);
    for (const bytes of [new Uint8Array([137,80,78]), new Uint8Array([255,216,0])]) {
      const invalid=capture(bytes);
      expect(()=>parseGLBImageResources(invalid.json,invalid.bin)).toThrow(/signature.*MIME/);
    }
  });
  it('retains a genuine encoded JPEG and rejects it when declared PNG', () => {
    const jpeg = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDx/9k=', 'base64'));
    const {json,bin}=capture(jpeg); json.images![0].mimeType='image/jpeg';
    const [mesh]=parseGLBToMeshData(json,bin);
    expect(parseGLBImageResources(json,bin).get(mesh.textureRef!.url)).toEqual(jpeg);
    expect(mesh.textureRef!.url).toMatch(/\.jpg$/);
    json.images![0].mimeType='image/png';
    expect(()=>parseGLBImageResources(json,bin)).toThrow(/signature.*MIME/);
  });
  it('bounds deep scene walks without consuming the call stack', () => {
    const {json,bin}=capture(); const leaf=json.nodes![0];json.nodes=Array.from({length:12000},(_,i)=>i===11999?leaf:{children:[i+1]});json.scenes=[{nodes:[0]}];
    expect(parseGLBToMeshData(json,bin)).toHaveLength(1);
  });
});
