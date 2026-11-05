/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Manual real-authoring-tool oracle. Run through tsx with the viewer tsconfig
// and Vite test module hooks, after the root dependency graph has built.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const root = new URL('../../../', import.meta.url);
const load = path => import(new URL(path, root).href);
await load('apps/viewer/src/test/setup-dom.ts');
const require = createRequire(new URL('apps/viewer/package.json', root));
const pdfRequire = createRequire(require.resolve('pdfjs-dist/package.json'));
const { createCanvas } = pdfRequire('@napi-rs/canvas');
const createElement = document.createElement.bind(document);
document.createElement = (name, ...args) => name === 'canvas' ? createCanvas(1, 1) : createElement(name, ...args);
const { parseSymbolicAnnotations } = await load('apps/viewer/src/lib/overlay-parse/symbolic-parse.ts');
const { buildSymbolicLineChannels } = await load('apps/viewer/src/hooks/symbolic-line-channels.ts');
const { buildSymbolicRichChannels } = await load('apps/viewer/src/hooks/symbolic-rich-channels.ts');
const { AnnotationPicker, resolveAnnotationPick } = await load('packages/renderer/src/annotation-picking.ts');
const { Camera } = await load('packages/renderer/src/camera.ts');
const { SymbolicTextPipeline } = await load('packages/renderer/src/symbolic-overlay-pipelines.ts');
const { triangulateFillTo } = await load('packages/renderer/src/symbolic-overlay-geometry.ts');
// Node cannot fetch file: URLs; initialize the same production module from bytes.
const { default: initWasm } = await load('packages/wasm/pkg/ifc-lite.js');
await initWasm({ module_or_path: readFileSync(new URL('packages/wasm/pkg/ifc-lite_bg.wasm', root)) });
const bytes = readFileSync(process.argv[2]);
const cached = await parseSymbolicAnnotations({ source: bytes });
const params = { enabled: true, effectiveGridEnabled: false, clipEnabled: false, clipPos: 0, clipDepth: 0, fallbackY: 0, theme: 'light' };
const lines = buildSymbolicLineChannels([{cached}],params).annotation;
const rich = buildSymbolicRichChannels([{cached}],params);
const camera = new Camera();
const picker = new AnnotationPicker();
const result = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  lineOwners: [], fillOwners: [], textOwners: [], textGlyphs: 0 };
const hit = (x=200,y=200,options,clip) => resolveAnnotationPick(picker.pick(camera,x,y,400,400,options,clip),null);
const verify = (owner,x=200,y=200) => {
  assert.equal(hit(x,y)?.expressId,owner);
  assert.equal(hit(x,y,{hiddenIds:new Set([owner])}),null);
  assert.equal(hit(x,y,{isolatedIds:new Set()}),null);
};
for (const part of 'localVertices' in lines ? [lines] : lines) {
  const v=part.localVertices,o=part.origin;
  for (let i=0;i+5<v.length && result.lineOwners.length<10;i+=6) {
    const owner=part.ownerIds[i/6];
    if (!owner || result.lineOwners.includes(owner)) continue;
    const mid=[o[0]+(v[i]+v[i+3])/2,o[1]+(v[i+1]+v[i+4])/2,o[2]+(v[i+2]+v[i+5])/2];
    picker.setLines({origin:o,localVertices:v.slice(i,i+6),ownerIds:new Uint32Array([owner])},true);
    camera.setPosition(mid[0],mid[1]+5,mid[2]+5);camera.setTarget(...mid);
    verify(owner);result.lineOwners.push(owner);
  }
}
picker.clear();
for (const fill of rich.fills) {
  if (result.fillOwners.length>=10) break;
  const verts=[];triangulateFillTo(verts,fill);
  if (verts.length<21 || !fill.ownerId || !(fill.color[3]>0) || result.fillOwners.includes(fill.ownerId)) continue;
  const o=fill.origin??[0,0,0];
  const mid=[o[0]+(verts[0]+verts[7]+verts[14])/3,o[1]+fill.worldY,o[2]+(verts[2]+verts[9]+verts[16])/3];
  picker.setFills([fill]);camera.setPosition(mid[0],mid[1]+5,mid[2]+5);camera.setTarget(...mid);
  verify(fill.ownerId);result.fillOwners.push(fill.ownerId);
}
picker.clear();
Object.assign(globalThis,{GPUShaderStage:{VERTEX:1,FRAGMENT:2},GPUColorWrite:{ALL:15},
  GPUBufferUsage:{COPY_DST:8,VERTEX:32,UNIFORM:64},GPUTextureUsage:{TEXTURE_BINDING:4,COPY_DST:8,RENDER_ATTACHMENT:16}});
// Only the GPU transport is inert. Parsing, glyph rasterization, layout,
// camera projection and picking are the production implementations.
const device={createBindGroupLayout:()=>({}),createPipelineLayout:()=>({}),createShaderModule:()=>({}),
  createRenderPipeline:()=>({}),createBuffer:()=>({destroy(){}}),createSampler:()=>({}),
  createTexture:()=>({createView:()=>({}),destroy(){}}),createBindGroup:()=>({}),
  queue:{writeBuffer(){},copyExternalImageToTexture(){}}};
const pipeline=new SymbolicTextPipeline(device,'bgra8unorm');
for (const text of rich.texts) {
  if (result.textOwners.length>=10) break;
  if (!text.content.trim() || !text.ownerId || result.textOwners.includes(text.ownerId)) continue;
  pipeline.upload([text]);picker.setGlyphs(pipeline.pickGlyphs);
  const glyph=pipeline.pickGlyphs[0];if (!glyph) continue;
  const a=glyph.anchor;
  const distance=Math.max(.2,text.height*10);
  camera.setPosition(a[0]+text.dirZ*distance,a[1],a[2]-text.dirX*distance);camera.setTarget(...a);
  // Search the label's screen neighbourhood; alignment may put the full row
  // to either side of its anchor. Require an actual hit and rejection under hides.
  let found=false;
  for (let y=100;y<=300&&!found;y++) for (let x=20;x<380;x++) {
    if (hit(x,y)?.expressId===text.ownerId) {verify(text.ownerId,x,y);found=true;break;}
  }
  assert.ok(found,`real label ${text.ownerId} must be selectable`);
  result.textOwners.push(text.ownerId);result.textGlyphs+=pipeline.pickGlyphs.length;
}
pipeline.destroy();picker.clear();
assert.equal(hit(),null);
assert.ok(result.lineOwners.length && result.fillOwners.length && result.textOwners.length,'all primitive families must be exercised');
console.log(JSON.stringify(result,null,2));
