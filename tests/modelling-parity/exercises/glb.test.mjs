/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { meshes, wallHit } from './glb.mjs';

test('#9296 GLB bounds use transformed vertex data, not accessor hints',()=>{
  const out=mkdtempSync(resolve(tmpdir(),'parity-glb-'));
  try {
    const positions=new Float32Array([0,0,0,2,0,0,0,3,0]);
    const document={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{translation:[10,20,30],children:[1]},{matrix:[0,1,0,0,-1,0,0,0,0,0,1,0,1,2,3,1],mesh:0,extras:{expressId:42}}],meshes:[{primitives:[{attributes:{POSITION:0}}]}],buffers:[{byteLength:positions.byteLength}],bufferViews:[{buffer:0,byteLength:positions.byteLength}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-999,-999,-999],max:[999,999,999]}]};
    const json=Buffer.from(JSON.stringify(document).padEnd(Math.ceil(JSON.stringify(document).length/4)*4,' '));
    const buffer=Buffer.alloc(28+json.length+positions.byteLength);
    buffer.writeUInt32LE(0x46546c67,0);buffer.writeUInt32LE(2,4);buffer.writeUInt32LE(buffer.length,8);
    buffer.writeUInt32LE(json.length,12);buffer.writeUInt32LE(0x4e4f534a,16);json.copy(buffer,20);
    buffer.writeUInt32LE(positions.byteLength,20+json.length);buffer.writeUInt32LE(0x004e4942,24+json.length);Buffer.from(positions.buffer).copy(buffer,28+json.length);
    const path=resolve(out,'triangle.glb');writeFileSync(path,buffer);
    const [row]=meshes(path);
    assert.equal(row.expressId,42);
    assert.deepEqual(row.min,[8,22,33]);assert.deepEqual(row.max,[11,24,33]);
  } finally { rmSync(out,{recursive:true,force:true}); }
});

test('#9296 wall ray distinguishes an actual doorway gap from adjacent solid faces',()=>{
  const quad=(x0,x1)=>[[[x0,0,0],[x1,0,0],[x1,3,0]],[[x0,0,0],[x1,3,0],[x0,3,0]]];
  const cut={triangles:[...quad(0,1),...quad(2,5)]};
  assert.equal(wallHit(cut,1.4,1.1),false);
  assert.equal(wallHit(cut,2.4,1.1),true);
  assert.equal(wallHit({triangles:quad(0,5)},1.4,1.1),true);
});
