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
const attempt = process.env.ITALIAN_WORKFLOW_ATTEMPT ?? `run-${Date.now()}-${process.pid}`;
assert.match(attempt, /^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use a single attempt directory name');
const out = path.join(root, 'tools/localization-italian/evidence', attempt);
fs.mkdirSync(path.dirname(out), { recursive: true });
// Preserve prior reports: an existing attempt must never be overwritten.
fs.mkdirSync(out);
const dependency = fs.readdirSync('node_modules/.pnpm').find(n => /^playwright@/.test(n));
const { chromium } = await import(pathToFileURL(path.resolve('node_modules/.pnpm', dependency, 'node_modules/playwright/index.mjs')));
assert.ok(process.env.IFC_GPU_CDP_URL || process.env.IFC_GPU_CHROME_ARGS, 'Use ifc-gpu-check; do not bypass GPU admission');
const chromeRoot = path.join(os.homedir(), '.t3/tools/chrome-headless-shell/linux64');
// A CDP worker owns its browser installation; local Chrome is only for launch.
const executablePath = process.env.IFC_GPU_CDP_URL ? undefined
  : process.env.IFC_GPU_CHROME_PATH ?? path.join(chromeRoot, fs.readdirSync(chromeRoot).sort().at(-1), 'chrome-headless-shell');
const browser = process.env.IFC_GPU_CDP_URL
  ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
  : await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...process.env.IFC_GPU_CHROME_ARGS.split(/\s+/)] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', acceptDownloads: true });
const page = await context.newPage();
// Windows Chrome reached through WSL CDP cannot write a Linux /tmp path.
// Keep a real browser download, using its GUID file through the WSL share.
const windowsCdp = Boolean(process.env.IFC_GPU_CDP_URL)
  && process.platform === 'linux' && /microsoft/i.test(os.release());
let downloadSession;
if (windowsCdp) {
  const targetSession = await context.newCDPSession(page);
  const { targetInfo } = await targetSession.send('Target.getTargetInfo');
  await targetSession.detach();
  downloadSession = await browser.newBrowserCDPSession();
  await downloadSession.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName', browserContextId: targetInfo.browserContextId,
    downloadPath: execFileSync('wslpath', ['-w', out], {encoding:'utf8'}).trim(), eventsEnabled: true,
  });
}

page.setDefaultTimeout(20000);
const hashes=Object.fromEntries(['apps/viewer/dist/index.html','packages/wasm/pkg/ifc-lite_bg.wasm','apps/viewer/public/samples/building-architecture.ifc','apps/viewer/public/samples/building-architecture.ids'].map(p=>[p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const report = { mode: process.env.ITALIAN_INSPECT === '1' ? 'inspection' : 'acceptance', hashes, at: new Date().toISOString(), host: os.hostname(), source: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), dirty: Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()), executablePath, gpuArgs: process.env.IFC_GPU_CHROME_ARGS, vulkanDriver: process.env.VK_DRIVER_FILES, checks: [], errors: [], wasm: [] };
page.on('console',m=>{if(m.type()==='error'||/device|GPU/i.test(m.text()))fs.appendFileSync(path.join(out,'browser-console.log'),m.text()+'\n');});
collectPageErrors(page, report);
page.on('response', r => { if (/\.wasm(?:\?|$)/.test(r.url())) report.wasm.push({ url:r.url(), status:r.status() }); });
const base = process.env.ITALIAN_WORKFLOW_URL ?? 'http://127.0.0.1:5190/';
const model = '?model=/samples/building-architecture.ifc';
const save = async name => { await page.screenshot({path:path.join(out, name+'.png')}); fs.writeFileSync(path.join(out,name+'.txt'), await page.locator('body').innerText()); fs.writeFileSync(path.join(out,name+'-aria.txt'),await page.locator('body').ariaSnapshot()); };
const check = async (name, fn) => { console.log('START',name); try { const detail = await fn(); report.checks.push({name,status:'pass',detail}); console.log('PASS',name); } catch(e) { report.checks.push({name,status:'fail',error:String(e)}); console.log('FAIL',name,String(e)); try { await save('failure-'+name.replace(/\W/g,'-')); } catch (error) { console.warn('Failure snapshot unavailable', name, error); report.errors.push('Failure snapshot: '+String(error)); } } };
try {
  // Bound network and body reads by elapsed time, including stalled responses.
  const readyDeadline=Date.now()+120000;
  while (Date.now()<readyDeadline) {
    try {
      const response=await fetch(base,{signal:AbortSignal.timeout(Math.min(5000,readyDeadline-Date.now()))});
      const html=await response.text();
      if (response.ok && html.includes('<html')) break;
      report.readinessError='HTTP '+response.status+' or response missing HTML';
    } catch(error) {report.readinessError=String(error);}
    const remaining=readyDeadline-Date.now();
    if (remaining<=0) throw Error('Preview did not serve built HTML within 120 seconds: '+report.readinessError);
    await new Promise(resolve=>setTimeout(resolve,Math.min(2000,remaining)));
  }
  if (Date.now()>=readyDeadline) throw Error('Preview readiness deadline exceeded: '+report.readinessError);
  await page.goto(base+model);
  await check('locale-settings',async()=>{
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('#settings-language').click();
  await page.getByRole('option',{name:'Italiano',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='it');
  await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'it');
  });
  await page.waitForFunction(() => document.documentElement.lang === 'it');
  report.gpu = await page.evaluate(async()=>{ const a=await navigator.gpu.requestAdapter(); if(!a)return null; return {...a.info.toJSON?.(),vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description,isFallbackAdapter:a.info.isFallbackAdapter??a.isFallbackAdapter}; });
  assert.ok(report.gpu && !report.gpu.isFallbackAdapter && !/swiftshader|llvmpipe/i.test(JSON.stringify(report.gpu)), 'Real GPU adapter required');
  await page.waitForFunction(()=>{const s=globalThis.__ifc_lite_viewer_store__?.getState();return s?.models.size>0&&!s.isLoading&&[...s.models.values()].some(m=>m.geometryResult?.meshes?.length>0);},null,{timeout:120000});
  report.idsLocale=await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().idsLocale);
  assert.equal(report.idsLocale,'it');
  report.loaded=await page.evaluate(()=>{const s=globalThis.__ifc_lite_viewer_store__.getState();return [...s.models.values()].map(m=>({name:m.name,meshes:m.geometryResult.meshes.length,entities:m.ifcDataStore?.entities?.count}));});
  await save('wide-loaded');
  fs.writeFileSync(path.join(out,'wide-aria.txt'),await page.locator('body').ariaSnapshot());
  if(report.mode === 'inspection') { console.log(await page.locator('body').ariaSnapshot()); }
  else {
    await check('render-device-health',async()=>{assert.doesNotMatch(await page.locator('body').innerText(),/graphics device was lost|could not recover|WebGPU non disponibile|Rendering 3D non riuscito|Failed to get GPU adapter/); assert.ok(report.wasm.some(w=>w.status===200)); await save('render-device-health');});
    await check('hierarchy-properties',async()=>{
      await page.getByRole('button',{name:'Espandi Single-family house',exact:true}).click();
      fs.writeFileSync(path.join(out,'hierarchy-aria.txt'),await page.locator('body').ariaSnapshot());
      await page.getByRole('button',{name:'Espandi 00 groundfloor',exact:true}).click();
      await page.getByRole('textbox',{name:'Cerca nella gerarchia',exact:true}).fill('house - outer wall - house right front');
      const fallback=page.getByRole('treeitem').filter({hasText:'IfcWall'}).last();
      await fallback.click({position:{x:150,y:17}});
      await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId!=null);
      await page.locator('[data-tour="properties-panel"]').waitFor();
      await page.getByRole('textbox',{name:'Cerca nella gerarchia',exact:true}).fill('');
      assert.match(await page.locator('[data-tour="properties-panel"]').innerText(),/1AQAupaRP1txwK1AGiN61V/);
      await save('hierarchy-properties');
      return await page.evaluate(()=>({selected:globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId}));
    });
    await check('measurement',async()=>{
      await page.getByRole('tab',{name:'Home',exact:true}).click();
      await page.getByRole('button',{name:'Misura',exact:true}).click();
      await page.getByTestId('measure-toolbar').waitFor();
      const canvas=page.locator('canvas').first(); const box=await canvas.boundingBox();
      await page.mouse.move(box.x+box.width*0.45,box.y+box.height*0.5); await page.mouse.down();
      await page.mouse.move(box.x+box.width*0.55,box.y+box.height*0.5,{steps:12}); await page.mouse.up();
      await save('measurement');
      const count=await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().measurements.length);
      assert.ok(count>0,'two model picks must create a measurement'); return {count};
    });
    await check('section',async()=>{
      await page.getByRole('tab',{name:'Home',exact:true}).click();
      await page.getByRole('button',{name:'Sezione',exact:true}).click();
      await page.getByRole('button',{name:'Dall’alto (Z)',exact:true}).click();
      await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__.getState().sectionPlane.enabled);
      await save('section');
      return await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().sectionPlane);
    });
    await check('ids-findings-export',async()=>{
      await page.getByRole('button',{name:'Validazione dei dati',exact:true}).click();
      // #8892: the shared validation panel now exposes IDS as a named region.
      await page.getByRole('region',{name:'Validazione IDS',exact:true}).waitFor();
      await page.getByRole('button',{name:'Carica file IDS',exact:true}).waitFor();
      await page.locator('input[type=file][accept=".ids,.xml"]').first().setInputFiles(path.join(root,'apps/viewer/public/samples/building-architecture.ids'));
      await page.locator('[data-tour="ids-run"]').click();
      await page.locator('[data-tour="ids-summary"]').waitFor({timeout:60000});
      // Round 5: verify corrected library actions through actual accessible controls.
      for (const name of ['Importa un altro controllo', 'Nuovo da questo controllo', 'Elimina controllo']) {
        await page.getByRole('button', {name, exact:true}).waitFor({state:'visible'});
      }
      assert.equal(await page.getByRole('option', {name:'Nessun controllo selezionato', exact:true}).count(), 1);
      await page.getByRole('button',{name:/^Non superato Walls are external/}).click();
      await page.getByText('La proprietà "Pset_WallCommon.IsExternal" deve essere uguale a "true"', {exact:true}).first().waitFor();
      await save('ids-findings');
      fs.writeFileSync(path.join(out,'ids-aria.txt'),await page.locator('body').ariaSnapshot());
      const summary=await page.locator('[data-tour="ids-summary"]').innerText();
      assert.match(summary,/superat/i);
      const downloadPromise=page.waitForEvent('download');
      let progressListener;
      const nativeDownload = downloadSession ? new Promise((resolve, reject) => {
        progressListener = event => {
          if (event.state === 'completed') resolve(event.guid);
          if (event.state === 'canceled') reject(new Error('Windows browser canceled IDS download'));
        };
        downloadSession.on('Browser.downloadProgress', progressListener);
      }) : null;
      await page.getByRole('button',{name:'Scegli il formato di esportazione',exact:true}).click();
      await page.getByRole('menuitem',{name:/JSON/}).click();
      const download=await downloadPromise;
      const savedPath=path.join(out,path.basename(download.suggestedFilename()));
      if (nativeDownload) {
        try {
          const guid=await Promise.race([nativeDownload, new Promise((_,reject)=>{
            const timer=setTimeout(()=>reject(new Error('IDS download did not complete in 30 seconds')),30000);
            timer.unref();
          })]);
          fs.renameSync(path.join(out,guid),savedPath);
        } finally {downloadSession.off('Browser.downloadProgress',progressListener);}
      } else await download.saveAs(savedPath);
      const exported=JSON.parse(fs.readFileSync(savedPath,'utf8'));
      assert.equal(exported.source.kind,'ids');
      assert.deepEqual(exported.summary,{totalSpecifications:3,passedSpecifications:1,failedSpecifications:2,totalEntitiesChecked:11,totalEntitiesPassed:8,totalEntitiesFailed:3,overallPassRate:72});
      const wallResults=exported.specificationResults.find(s=>s.specification.name==='Walls are external');
      assert.ok(wallResults.entityResults.some(e=>!e.passed));
      for(const entity of wallResults.entityResults) assert.equal(entity.requirementResults[0].checkedDescription,'La proprietà "Pset_WallCommon.IsExternal" deve essere uguale a "true"');
      return {summary,download:download.suggestedFilename(),exportedSummary:exported.summary};
    });
    await check('narrow-layout',async()=>{
      await page.keyboard.press('Escape');
      const notice = page.getByRole('button', {name:'Chiudi la notifica', exact:true});
      if (await notice.isVisible()) await notice.click();
      await page.setViewportSize({width:390,height:844});
      // Let the resized GPU canvas present before recording pixels.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.waitForTimeout(500);
      // #8892: a retained model/store and a 390px document can still show a blank canvas.
      // Inspect the composited canvas pixels where this fixture's selected blue wall
      // or orange roof must remain visible, away from toolbar and privacy overlays.
      const canvasPng=await page.locator('canvas').first().screenshot();
      const modelPixels=await page.evaluate(async encoded=>{
        const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
        const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
        try {
          const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
          const context=canvas.getContext('2d');
          context.drawImage(bitmap,0,0);
          const {data}=context.getImageData(0,0,bitmap.width,bitmap.height);
          const scan=pixels=>{
            let painted=0,sampled=0,edges=0;
            for(let y=Math.floor(bitmap.height*0.4);y<bitmap.height*0.7;y++) {
              for(let x=Math.floor(bitmap.width*0.2);x<bitmap.width*0.8;x++) {
                const offset=(y*bitmap.width+x)*4;
                const [r,g,b]=pixels.subarray(offset,offset+3);
                sampled++;
                if ((b>r+35 && b>g+10) || (r>g+25 && g>b+20)) painted++;
                const next=offset+4;
                if (Math.abs(r-pixels[next])+Math.abs(g-pixels[next+1])+Math.abs(b-pixels[next+2])>60) edges++;
              }
            }
            return {painted,sampled,edges};
          };
          const visible=({painted,sampled,edges})=>painted>200 && painted<sampled*0.6 && edges>100;
          const negativeControls=[];
          for(const rgb of [[100,150,200],[229,230,232]]) {
            const flat=new Uint8ClampedArray(data.length);
            for(let i=0;i<flat.length;i+=4) {flat.set(rgb,i);flat[i+3]=255;}
            negativeControls.push(visible(scan(flat)));
          }
          const actual=scan(data);
          return {...actual,visible:visible(actual),negativeControls};
        } finally {bitmap.close();}
      },canvasPng.toString('base64'));
      assert.deepEqual(modelPixels.negativeControls,[false,false],'flat sky-blue and blank-grey canvases must fail');
      assert.ok(modelPixels.visible,'the narrow house needs bounded model-colour coverage and spatial edges, not a flat background');
      await save('narrow-model');
      // The observed phone UI replaces the ribbon with a compact toolbar (#8892).
      await page.getByRole('button', {name:'Home', exact:true}).waitFor({state:'visible'});
      await page.getByRole('button', {name:'Altre azioni', exact:true}).click();
      await page.getByRole('menuitem', {name:'Impostazioni…', exact:true}).waitFor({state:'visible'});
      await page.keyboard.press('Escape');
      await page.getByRole('button', {name:'Pannelli', exact:true}).click();
      await page.getByRole('button', {name:'Validazione dei dati', exact:true}).click();
      await page.locator('[data-tour="ids-summary"]').waitFor({state:'visible'});
      const exportButton = page.getByRole('button', {name:'Scegli il formato di esportazione', exact:true});
      await exportButton.waitFor({state:'visible'});
      const exportBox = await exportButton.boundingBox();
      assert.ok(exportBox && exportBox.x >= 0 && exportBox.x + exportBox.width <= 390,
        'mobile export control must fit inside the viewport');
      await save('narrow');
      fs.writeFileSync(path.join(out,'narrow-aria.txt'),await page.locator('body').ariaSnapshot());
      const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      assert.ok(widths.document<=widths.viewport,'document must not overflow horizontally'); return {...widths,modelPixels};
    });
    // Workflow steps below exercise the actual UI; store reads are assertions only.
    await check('locale-persistence',async()=>{
      await page.setViewportSize({width:1600,height:1000});
      await page.goto(base); await page.waitForFunction(()=>document.documentElement.lang==='it');
      await page.reload(); await page.waitForFunction(()=>document.documentElement.lang==='it');
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'it');
    });
    await check('locale-english-settings',async()=>{
      await page.getByRole('button',{name:'Impostazioni',exact:true}).click();
      await page.locator('#settings-language').click();
      await page.getByRole('option',{name:'English',exact:true}).click();
      await page.waitForFunction(()=>document.documentElement.lang==='en');
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'en');
      // Auto removes the saved override and follows this en-US browser again.
      await page.locator('#settings-language').click();
      await page.getByRole('option',{name:'Auto (browser language)',exact:true}).click();
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),null);
      await page.keyboard.press('Escape');
      await page.getByRole('tab',{name:'Home',exact:true}).waitFor();
      // An obsolete URL parameter must neither select nor pin Italian (#9075).
      await page.goto(base+'?lang=it');
      await page.waitForLoadState('networkidle');
      await page.getByRole('tab',{name:'Home',exact:true}).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'),'en');
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),null);
    });
    await check('locale-it-CH-negotiation',async()=>{
      const fresh=await browser.newContext({locale:'it-CH'});
      try {const p=await fresh.newPage(); collectPageErrors(p, report); await p.goto(base); await p.waitForFunction(()=>document.documentElement.lang==='it'); await p.getByRole('tab',{name:'Home',exact:true}).waitFor(); assert.equal(await p.evaluate(()=>navigator.language),'it-CH');}
      finally {await fresh.close();}
    });
  }
} catch(e) { report.fatal=String(e); process.exitCode=1; }
finally {
  const writeReport=()=>fs.writeFileSync(path.join(out,report.mode === 'inspection' ? 'inspection.json' : 'workflow.json'),JSON.stringify(report,null,2));
  if(workflowFailed(report))process.exitCode=1;
  try { writeReport(); }
  catch(error) {console.warn('Initial report write failed',error);report.errors.push('Report write: '+String(error));process.exitCode=1;}
  for (const resource of [context,browser]) {
    try { await resource.close(); }
    catch(error) {console.warn('Browser cleanup failed',error);report.errors.push('Cleanup: '+String(error));process.exitCode=1;}
  }
  try { writeReport(); }
  catch(error) {console.warn('Final report write failed',error);report.errors.push('Report write: '+String(error));process.exitCode=1;}
  console.log(JSON.stringify(report,null,2));
}
