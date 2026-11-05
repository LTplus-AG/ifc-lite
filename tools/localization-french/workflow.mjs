/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Real-GPU browser acceptance. Run through ~/build-workers/ifc-gpu-check.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectPageErrors, workflowFailed } from './workflow-verdict.mjs';
const root = process.cwd();
const out = path.join(root, 'tools/localization-french/evidence', process.env.FRENCH_WORKFLOW_ATTEMPT ?? 'final');
fs.mkdirSync(out, { recursive: true });
const dependency = fs.readdirSync('node_modules/.pnpm').find(n => /^playwright@/.test(n));
const { chromium } = await import(pathToFileURL(path.resolve('node_modules/.pnpm', dependency, 'node_modules/playwright/index.mjs')));
const chromeRoot = path.join(os.homedir(), '.t3/tools/chrome-headless-shell/linux64');
const executablePath = process.env.IFC_GPU_CHROME_PATH ?? path.join(chromeRoot, fs.readdirSync(chromeRoot).sort().at(-1), 'chrome-headless-shell');
assert.ok(process.env.IFC_GPU_CDP_URL || process.env.IFC_GPU_CHROME_ARGS, 'Use ifc-gpu-check; do not bypass GPU admission');
const browser = process.env.IFC_GPU_CDP_URL
  ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
  : await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...process.env.IFC_GPU_CHROME_ARGS.split(/\s+/)] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const hashes=Object.fromEntries(['apps/viewer/dist/index.html','packages/wasm/pkg/ifc-lite_bg.wasm','apps/viewer/public/samples/building-architecture.ifc','apps/viewer/public/samples/building-architecture.ids'].map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const report = { mode: process.env.FRENCH_INSPECT === '1' ? 'inspection' : 'acceptance', untimed: true, url: process.env.FRENCH_WORKFLOW_URL, hashes, at: new Date().toISOString(), host: os.hostname(), source: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), dirty: true, executablePath, gpuArgs: process.env.IFC_GPU_CHROME_ARGS, vulkanDriver: process.env.VK_DRIVER_FILES, checks: [], errors: [], httpErrors: [], wasm: [] };
page.on('console',m=>{if(m.type()==='error'||/device|GPU/i.test(m.text()))fs.appendFileSync(path.join(out,'browser-console.log'),m.text()+'\n');});
collectPageErrors(page, report);
page.on('response', r => { if(r.status()>=400)report.httpErrors.push({url:r.url(),status:r.status()}); if (/\.wasm(?:\?|$)/.test(r.url())) report.wasm.push({ url:r.url(), status:r.status() }); });
const base = process.env.FRENCH_WORKFLOW_URL ?? 'http://127.0.0.1:5189/';
const model = '?model=/samples/building-architecture.ifc&lang=fr';
const save = async name => { await page.screenshot({path:path.join(out, name+'.png')}); fs.writeFileSync(path.join(out,name+'.txt'), await page.locator('body').innerText()); fs.writeFileSync(path.join(out,name+'-aria.txt'),await page.locator('body').ariaSnapshot()); };
const check = async (name, fn) => { console.log('START',name); try { const detail = await fn(); report.checks.push({name,status:'pass',detail}); console.log('PASS',name); } catch(e) { report.checks.push({name,status:'fail',error:String(e)}); console.log('FAIL',name,String(e)); await save('failure-'+name.replace(/\W/g,'-')); } };
try {
  // Readiness bounded to two minutes; no server or build is started by this harness.
  for (let i=0;i<60;i++) { try { const r=await fetch(base); if(r.ok && (await r.text()).includes('<html'))break; } catch(e) { report.readinessError=String(e); } if(i===59)throw Error('Preview did not serve built HTML within 120 seconds'); await new Promise(r=>setTimeout(r,2000)); }
  await page.goto(base+model);
  await page.waitForFunction(() => document.documentElement.lang === 'fr');
  report.gpu = await page.evaluate(async()=>{ const a=await navigator.gpu.requestAdapter(); if(!a)return null; return {...a.info.toJSON?.(),vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description,isFallbackAdapter:a.info.isFallbackAdapter??a.isFallbackAdapter}; });
  assert.ok(report.gpu && !report.gpu.isFallbackAdapter && !/swiftshader|llvmpipe/i.test(JSON.stringify(report.gpu)), 'Real GPU adapter required');
  await page.waitForFunction(()=>{const s=globalThis.__ifc_lite_viewer_store__?.getState();return s?.models.size>0&&!s.isLoading&&[...s.models.values()].some(m=>m.geometryResult?.meshes?.length>0);},null,{timeout:120000});
  report.idsLocale=await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().idsLocale);
  assert.equal(report.idsLocale,'fr');
  report.loaded=await page.evaluate(()=>{const s=globalThis.__ifc_lite_viewer_store__.getState();return [...s.models.values()].map(m=>({name:m.name,meshes:m.geometryResult.meshes.length,entities:m.ifcDataStore?.entities?.count}));});
  await save('wide-loaded');
  fs.writeFileSync(path.join(out,'wide-aria.txt'),await page.locator('body').ariaSnapshot());
  if(report.mode === 'inspection') { console.log(await page.locator('body').ariaSnapshot()); }
  else {
    await check('render-device-health',async()=>{assert.doesNotMatch(await page.locator('body').innerText(),/graphics device was lost|could not recover|WebGPU indisponible/); assert.ok(report.wasm.some(w=>w.status===200)); await save('render-device-health');});
    await check('hierarchy-properties',async()=>{
      await page.getByRole('button',{name:'Développer Single-family house',exact:true}).click();
      fs.writeFileSync(path.join(out,'hierarchy-aria.txt'),await page.locator('body').ariaSnapshot());
      await page.getByRole('button',{name:'Développer 00 groundfloor',exact:true}).click();
      await page.getByRole('textbox',{name:'Rechercher dans la hiérarchie',exact:true}).fill('house - outer wall - house right front');
      const fallback=page.getByRole('treeitem').filter({hasText:'IfcWall'}).last();
      await fallback.click({position:{x:150,y:17}});
      await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId!=null);
      await page.locator('[data-tour="properties-panel"]').waitFor();
      await page.getByRole('textbox',{name:'Rechercher dans la hiérarchie',exact:true}).fill('');
      assert.match(await page.locator('[data-tour="properties-panel"]').innerText(),/1AQAupaRP1txwK1AGiN61V/);
      await save('hierarchy-properties');
      return await page.evaluate(()=>({selected:globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId}));
    });
    await check('measurement',async()=>{
      await page.getByRole('tab',{name:'Accueil',exact:true}).click();
      await page.getByRole('button',{name:'Mesure',exact:true}).click();
      await page.getByTestId('measure-toolbar').waitFor();
      const canvas=page.locator('canvas').first(); const box=await canvas.boundingBox();
      await page.mouse.move(box.x+box.width*0.45,box.y+box.height*0.5); await page.mouse.down();
      await page.mouse.move(box.x+box.width*0.55,box.y+box.height*0.5,{steps:12}); await page.mouse.up();
      await save('measurement');
      const count=await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().measurements.length);
      assert.ok(count>0,'two model picks must create a measurement'); return {count};
    });
    await check('section',async()=>{
      await page.getByRole('tab',{name:'Accueil',exact:true}).click();
      await page.getByRole('button',{name:'Coupe',exact:true}).click();
      await page.getByRole('button',{name:'Dessus (Z)',exact:true}).click();
      await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__.getState().sectionPlane.enabled);
      await save('section');
      return await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().sectionPlane);
    });
    await check('ids-findings-export',async()=>{
      await page.getByRole('button',{name:'Validation des données',exact:true}).click();
      const idsTab=page.getByRole('tab',{name:'Validation IDS',exact:true});
      if(await idsTab.count()) await idsTab.click();
      else await page.getByRole('button',{name:/^Validation IDS Vérifiez le modèle/}).click();
      await page.locator('input[type=file][accept=".ids,.xml"]').first().setInputFiles(path.join(root,'apps/viewer/public/samples/building-architecture.ids'));
      await page.locator('[data-tour="ids-run"]').click();
      await page.locator('[data-tour="ids-summary"]').waitFor({timeout:60000});
      // Round 5: verify corrected library actions through actual accessible controls.
      for (const name of ['Importer un autre contrôle', 'Nouveau à partir de ce contrôle', 'Supprimer le contrôle']) {
        await page.getByRole('button', {name, exact:true}).waitFor({state:'visible'});
      }
      assert.equal(await page.getByRole('option', {name:'Aucun contrôle sélectionné', exact:true}).count(), 1);
      await page.getByRole('button', {name:/^Non conforme Walls are external/}).click();
      await page.getByText('La propriété \"Pset_WallCommon.IsExternal\" doit être égale à \"true\"', {exact:true}).first().waitFor();
      await save('ids-findings');
      fs.writeFileSync(path.join(out,'ids-aria.txt'),await page.locator('body').ariaSnapshot());
      const summary=await page.locator('[data-tour="ids-summary"]').innerText();
      assert.match(summary,/conformes/i);
      assert.match(await page.locator('body').innerText(),/Non conformes/);
      const downloadPromise=page.waitForEvent('download');
      await page.getByRole('button',{name:"Choisir le format d’export",exact:true}).click();
      await page.getByRole('menuitem',{name:/JSON/}).click();
      const download=await downloadPromise; await download.saveAs(path.join(out,download.suggestedFilename()));
      const exported=JSON.parse(fs.readFileSync(path.join(out,download.suggestedFilename()),'utf8'));
      assert.equal(exported.source.kind,'ids');
      assert.deepEqual(exported.summary,{totalSpecifications:3,passedSpecifications:1,failedSpecifications:2,totalEntitiesChecked:11,totalEntitiesPassed:8,totalEntitiesFailed:3,overallPassRate:72});
      const wallResults=exported.specificationResults.find(s=>s.specification.name==='Walls are external');
      assert.ok(wallResults.entityResults.some(e=>!e.passed));
      for(const entity of wallResults.entityResults) assert.equal(entity.requirementResults[0].checkedDescription,'La propriété \"Pset_WallCommon.IsExternal\" doit être égale à \"true\"');
      return {summary,download:download.suggestedFilename(),exportedSummary:exported.summary};
    });
    await check('narrow-layout',async()=>{
      await page.setViewportSize({width:390,height:844});
      // Let the resized GPU canvas present before recording pixels.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.waitForTimeout(500);
      await save('narrow');
      fs.writeFileSync(path.join(out,'narrow-aria.txt'),await page.locator('body').ariaSnapshot());
      const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      assert.ok(widths.document<=widths.viewport,'document must not overflow horizontally'); return widths;
    });
    // Workflow steps below exercise the actual UI; store reads are assertions only.
    await check('locale-url',async()=>{assert.equal(await page.locator('html').getAttribute('lang'),'fr');assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'fr');});
    await check('locale-persistence',async()=>{
      await page.setViewportSize({width:1600,height:1000});
      await page.goto(base); await page.waitForFunction(()=>document.documentElement.lang==='fr');
      await page.reload(); await page.waitForFunction(()=>document.documentElement.lang==='fr');
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'fr');
    });
    await check('locale-english-url',async()=>{
      await page.goto(base+'?lang=en'); await page.waitForFunction(()=>document.documentElement.lang==='en');
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'en');
      await page.getByRole('tab',{name:'Home',exact:true}).waitFor();
    });
    await check('locale-fr-CH-negotiation',async()=>{
      const fresh=await browser.newContext({locale:'fr-CH'});
      try {const p=await fresh.newPage(); collectPageErrors(p, report); await p.goto(base); await p.waitForFunction(()=>document.documentElement.lang==='fr'); await p.getByRole('tab',{name:'Accueil',exact:true}).waitFor(); assert.equal(await p.evaluate(()=>navigator.language),'fr-CH');}
      finally {await fresh.close();}
    });
  }
} catch(e) { report.fatal=String(e); process.exitCode=1; }
finally { await context.close(); await browser.close(); if(workflowFailed(report))process.exitCode=1; fs.writeFileSync(path.join(out,report.mode === 'inspection' ? 'inspection.json' : 'workflow.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2)); }
