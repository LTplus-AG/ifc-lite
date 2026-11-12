/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assignedLayerMaterials } from '../lib/measured-oracles.mjs';
import { task } from '../lib/driver.mjs';
import { oracleModel, escape, tool } from '../lib/model-ui.mjs';
import { check, field, wall, layer, inspector, applyLayers, finish } from '../lib/authoring-helpers.mjs';

export const colourMatches = (actual, expected) => Array.isArray(actual) && actual.length === 3 &&
  actual.every((v,i) => Number.isFinite(v) && Math.abs(v-expected[i]) < .001);
export function slabMaterials(step) {
  const slabs=step.of('IFCSLAB');
  if(slabs.length!==1) return [];
  return step.of('IFCRELASSOCIATESMATERIAL')
    .filter(r=>(r.args[4]??[]).some(o=>o.ref===slabs[0].id))
    .map(r=>step.get(r.args[5])?.args[0]);
}

const hue = ([r,g,b]) => {
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max-min;
  if (d < 12) return null;
  return ((max===r ? (g-b)/d : max===g ? (b-r)/d+2 : (r-g)/d+4)*60+360)%360;
};
const distance = (a,b) => Math.min(Math.abs(a-b),360-Math.abs(a-b));
async function renderedBrick(s) {
  const [x,y] = await s.worldToScreen([2.5,0,1.5]);
  const png = await s.page.screenshot({ scale: 'css' });
  return s.page.evaluate(async ({base64,x,y}) => {
    const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width=img.width; canvas.height=img.height;
    const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0);
    return Array.from(ctx.getImageData(Math.round(x)-3,Math.round(y)-3,7,7).data);
  },{base64:png.toString('base64'),x,y});
}
async function createMaterial(s, name, colour) {
  await s.ui.click(s.page.locator('[data-model-inspector]').getByRole('button',{name:'Properties',exact:true}));
  await s.ui.click(s.page.getByRole('button',{name:'Add material',exact:true}));
  await field(s,s.page.getByLabel('Material Name',{exact:true}),name);
  await field(s,s.page.getByLabel('Material colour hex',{exact:true}),colour);
  await s.ui.click(s.page.getByRole('button',{name:'Add Material',exact:true}),{settle:1500});
  await inspector(s);
}
export default {
  id:'ui.materials', capability:'materials', title:'Material colour, rendering and replacement assignment',
  async run(s) {
    const tasks=[await task(s,'create Brick #b5523b on a wall layer',async()=>{
      await layer(s,1,.2,'Brick');
      await field(s,s.page.getByLabel('Material colour hex',{exact:true}),'#b5523b');
      await applyLayers(s); await wall(s);
    })];
    // Deselect so selection highlighting cannot masquerade as the material.
    await escape(s);
    let pixels = [];
    let renderError = null;
    try {
      await s.page.waitForFunction(() => {
        const st=window.__ifc_lite_viewer_store__?.getState();
        return st && !st.pendingMeshEdits && [...st.models.values()].some(m=>m.geometryResult?.meshes.some(mesh=>mesh.positions.length>0));
      },null,{timeout:30000});
      await s.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      pixels=await renderedBrick(s);
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error);
    }
    const target=hue([181,82,59]);
    const hues=[];
    for(let i=0;i<pixels.length;i+=4) { const h=hue(pixels.slice(i,i+3)); if(h!==null) hues.push(h); }
    const brickShot=await s.shot('brick-colour');
    let concreteMaterials=[];
    tasks.push(await task(s,'create a slab and replace Concrete with Steel in the inspector',async()=>{
      await tool(s,'slab.place');
      await s.ui.click(s.page.getByRole('radio',{name:'Polygon',exact:true}));
      for(const p of [[0,2,0],[4,2,0],[4,5,0],[0,5,0]]) await s.ui.clickWorld(p);
      await s.ui.key('Enter'); await escape(s);
      await s.ui.clickWorld([2,3,0]); await inspector(s);
      await createMaterial(s,'Concrete','#808080');
      await createMaterial(s,'Steel','#404080');
      for(const name of ['Concrete','Steel']) {
        await s.ui.click(s.page.getByRole('combobox',{name:'Material Name',exact:true}));
        await s.ui.click(s.page.getByRole('option',{name,exact:true}),{settle:1500});
        if(name==='Concrete') concreteMaterials=slabMaterials((await oracleModel(s)).step);
      }
    }));
    const {step}=await oracleModel(s);
    const walls=step.of('IFCWALL');
    const assigned=walls.map(w=>assignedLayerMaterials(step,w.id));
    const brick=step.of('IFCMATERIAL').find(m=>m.args[0]==='Brick');
    const definitions=step.of('IFCMATERIALDEFINITIONREPRESENTATION').filter(r=>r.args[3]?.ref===brick?.id);
    const colors=definitions.flatMap(d=>(d.args[2]??[]).flatMap(r=>(step.get(r)?.args[3]??[]).flatMap(i=>(step.get(i)?.args[1]??[]).flatMap(st=>(step.get(st)?.args[2]??[]).map(sh=>step.get(step.get(sh)?.args[0])?.args.slice(1,4))))));
    const steelMaterials=slabMaterials(step);
    const result=await finish(s,tasks,[
      check('named material assigned through exported layers',walls.length===1 && assigned.every(n=>n.length===1&&n[0]==='Brick'),JSON.stringify(assigned)),
      check('Brick appearance exports its chosen colour',colors.some(c=>colourMatches(c,[181,82,59].map(v=>v/255))),JSON.stringify(colors)),
      check('rendered wall hue matches Brick within 10 degrees',renderError===null&&hues.length>=25&&hues.filter(h=>distance(h,target)<10).length>=25,renderError??JSON.stringify({hues,target})),
      check('slab initially has exactly one association to Concrete',concreteMaterials.length===1&&concreteMaterials[0]==='Concrete',JSON.stringify(concreteMaterials)),
      check('slab has exactly one association to Steel',steelMaterials.length===1&&steelMaterials[0]==='Steel',JSON.stringify(steelMaterials)),
    ]);
    result.evidence.push(brickShot); return result;
  },
};
