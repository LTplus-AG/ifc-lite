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
const out = path.join(root, 'tools/localization-german/evidence');
fs.mkdirSync(out, { recursive: true });
const dependency = fs.readdirSync('node_modules/.pnpm').find(n => /^playwright@/.test(n));
const { chromium } = await import(pathToFileURL(path.resolve('node_modules/.pnpm', dependency, 'node_modules/playwright/index.mjs')));
const chromeRoot = path.join(os.homedir(), '.t3/tools/chrome-headless-shell/linux64');
// A CDP worker owns its browser installation; local Chrome is only for launch.
const executablePath = process.env.IFC_GPU_CDP_URL ? undefined
  : process.env.IFC_GPU_CHROME_PATH ?? path.join(chromeRoot, fs.readdirSync(chromeRoot).sort().at(-1), 'chrome-headless-shell');
assert.ok(process.env.IFC_GPU_CDP_URL || process.env.IFC_GPU_CHROME_ARGS, 'Use ifc-gpu-check; do not bypass GPU admission');
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
const report = { mode: process.env.GERMAN_INSPECT === '1' ? 'inspection' : 'acceptance', hashes, at: new Date().toISOString(), host: os.hostname(), source: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), dirty: true, executablePath, gpuArgs: process.env.IFC_GPU_CHROME_ARGS, vulkanDriver: process.env.VK_DRIVER_FILES, checks: [], errors: [], wasm: [] };
page.on('console',m=>{if(m.type()==='error'||/device|GPU/i.test(m.text()))fs.appendFileSync(path.join(out,'browser-console.log'),m.text()+'\n');});
collectPageErrors(page, report);
page.on('response', r => { if (/\.wasm(?:\?|$)/.test(r.url())) report.wasm.push({ url:r.url(), status:r.status() }); });
const base = process.env.GERMAN_WORKFLOW_URL ?? 'http://127.0.0.1:5188/';
const model = '?model=/samples/building-architecture.ifc';
const save = async name => { await page.screenshot({path:path.join(out, name+'.png')}); fs.writeFileSync(path.join(out,name+'.txt'), await page.locator('body').innerText()); fs.writeFileSync(path.join(out,name+'-aria.txt'),await page.locator('body').ariaSnapshot()); };
const check = async (name, fn) => { console.log('START',name); try { const detail = await fn(); report.checks.push({name,status:'pass',detail}); console.log('PASS',name); } catch(e) { report.checks.push({name,status:'fail',error:String(e)}); console.log('FAIL',name,String(e)); await save('failure-'+name.replace(/\W/g,'-')); } };
try {
  // Readiness bounded to two minutes; no server or build is started by this harness.
  for (let i=0;i<60;i++) { try { const r=await fetch(base); if(r.ok && (await r.text()).includes('<html'))break; } catch(e) { report.readinessError=String(e); } if(i===59)throw Error('Preview did not serve built HTML within 120 seconds'); await new Promise(r=>setTimeout(r,2000)); }
  await page.goto(base+model);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('#settings-language').click();
  await page.getByRole('option',{name:'Deutsch',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.lang==='de');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.documentElement.lang === 'de');
  report.gpu = await page.evaluate(async()=>{ const a=await navigator.gpu.requestAdapter(); if(!a)return null; return {...a.info.toJSON?.(),vendor:a.info.vendor,architecture:a.info.architecture,device:a.info.device,description:a.info.description,isFallbackAdapter:a.info.isFallbackAdapter??a.isFallbackAdapter}; });
  assert.ok(report.gpu && !report.gpu.isFallbackAdapter && !/swiftshader|llvmpipe/i.test(JSON.stringify(report.gpu)), 'Real GPU adapter required');
  await page.waitForFunction(()=>{const s=globalThis.__ifc_lite_viewer_store__?.getState();return s?.models.size>0&&!s.isLoading&&[...s.models.values()].some(m=>m.geometryResult?.meshes?.length>0);},null,{timeout:120000});
  report.loaded=await page.evaluate(()=>{const s=globalThis.__ifc_lite_viewer_store__.getState();return [...s.models.values()].map(m=>({name:m.name,meshes:m.geometryResult.meshes.length,entities:m.ifcDataStore?.entities?.count}));});
  await save('wide-loaded');
  fs.writeFileSync(path.join(out,'wide-aria.txt'),await page.locator('body').ariaSnapshot());
  if(report.mode === 'inspection') { console.log(await page.locator('body').ariaSnapshot()); }
  else {
    await check('render-device-health',async()=>{assert.doesNotMatch(await page.locator('body').innerText(),/graphics device was lost|could not recover|WebGPU Nicht verfügbar|3D-Rendering fehlgeschlagen|Failed to get GPU adapter/); assert.ok(report.wasm.some(w=>w.status===200)); await save('render-device-health');});
    await check('hierarchy-properties',async()=>{
      await page.getByRole('button',{name:'Single-family house ausklappen',exact:true}).click();
      fs.writeFileSync(path.join(out,'hierarchy-aria.txt'),await page.locator('body').ariaSnapshot());
      await page.getByRole('button',{name:'00 groundfloor ausklappen',exact:true}).click();
      await page.getByRole('textbox',{name:'Hierarchie durchsuchen',exact:true}).fill('house - outer wall - house right front');
      const fallback=page.getByRole('treeitem').filter({hasText:'IfcWall'}).last();
      await fallback.click({position:{x:150,y:17}});
      await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId!=null);
      await page.locator('[data-tour="properties-panel"]').waitFor();
      await page.getByRole('textbox',{name:'Hierarchie durchsuchen',exact:true}).fill('');
      assert.match(await page.locator('[data-tour="properties-panel"]').innerText(),/1AQAupaRP1txwK1AGiN61V/);
      await save('hierarchy-properties');
      return await page.evaluate(()=>({selected:globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId}));
    });
    await check('measurement',async()=>{
      await page.getByRole('tab',{name:'Start',exact:true}).click();
      await page.getByRole('button',{name:'Messen',exact:true}).click();
      await page.getByTestId('measure-toolbar').waitFor();
      const canvas=page.locator('canvas').first(); const box=await canvas.boundingBox();
      await page.mouse.move(box.x+box.width*0.45,box.y+box.height*0.5); await page.mouse.down();
      await page.mouse.move(box.x+box.width*0.55,box.y+box.height*0.5,{steps:12}); await page.mouse.up();
      await save('measurement');
      const count=await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().measurements.length);
      assert.ok(count>0,'two model picks must create a measurement'); return {count};
    });
    await check('section',async()=>{
      await page.getByRole('tab',{name:'Start',exact:true}).click();
      await page.getByRole('button',{name:'Schnitt',exact:true}).click();
      await page.getByRole('button',{name:'Unten (Z)',exact:true}).click();
      await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__.getState().sectionPlane.enabled);
      await save('section');
      return await page.evaluate(()=>globalThis.__ifc_lite_viewer_store__.getState().sectionPlane);
    });
    await check('ids-findings-export',async()=>{
      await page.getByRole('button',{name:'Datenvalidierung',exact:true}).click();
      // #8890: the shared validation panel now exposes IDS as a named region.
      await page.getByRole('region',{name:'IDS-Validierung',exact:true}).waitFor();
      await page.getByRole('button',{name:'IDS-Datei laden',exact:true}).waitFor();
      await page.locator('input[type=file][accept=".ids,.xml"]').first().setInputFiles(path.join(root,'apps/viewer/public/samples/building-architecture.ids'));
      await page.locator('[data-tour="ids-run"]').click();
      await page.locator('[data-tour="ids-summary"]').waitFor({timeout:60000});
      // Round 5: verify corrected library actions through actual accessible controls.
      for (const name of ['Weitere Prüfung importieren', 'Neue Prüfung aus dieser erstellen', 'Prüfung löschen']) {
        await page.getByRole('button', {name, exact:true}).waitFor({state:'visible'});
      }
      assert.equal(await page.getByRole('option', {name:'Keine Prüfung ausgewählt', exact:true}).count(), 1);
      await save('ids-findings');
      fs.writeFileSync(path.join(out,'ids-aria.txt'),await page.locator('body').ariaSnapshot());
      const summary=await page.locator('[data-tour="ids-summary"]').innerText();
      assert.match(summary,/bestanden/i);
      const downloadPromise=page.waitForEvent('download');
      let progressListener;
      const nativeDownload = downloadSession ? new Promise((resolve, reject) => {
        progressListener = event => {
          if (event.state === 'completed') resolve(event.guid);
          if (event.state === 'canceled') reject(new Error('Windows browser canceled IDS download'));
        };
        downloadSession.on('Browser.downloadProgress', progressListener);
      }) : null;
      await page.getByRole('button',{name:'Exportformat wählen',exact:true}).click();
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
      return {summary,download:download.suggestedFilename(),exportedSummary:exported.summary};
    });
    await check('narrow-layout',async()=>{
      await page.setViewportSize({width:390,height:844}); await save('narrow');
      fs.writeFileSync(path.join(out,'narrow-aria.txt'),await page.locator('body').ariaSnapshot());
      const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      assert.ok(widths.document<=widths.viewport,'document must not overflow horizontally'); return widths;
    });
    // Workflow steps below exercise the actual UI; store reads are assertions only.
    await check('locale-settings',async()=>{assert.equal(await page.locator('html').getAttribute('lang'),'de');assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'de');});
    await check('locale-persistence',async()=>{
      await page.setViewportSize({width:1600,height:1000});
      await page.goto(base); await page.waitForFunction(()=>document.documentElement.lang==='de');
      await page.reload(); await page.waitForFunction(()=>document.documentElement.lang==='de');
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),'de');
    });
    await check('locale-english-settings',async()=>{
      await page.getByRole('button',{name:'Einstellungen',exact:true}).click();
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
      // An obsolete URL parameter must neither select nor pin German (#9075).
      await page.goto(base+'?lang=de');
      await page.getByRole('tab',{name:'Home',exact:true}).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'),'en');
      assert.equal(await page.evaluate(()=>localStorage.getItem('ifc-lite:locale')),null);
    });
    await check('locale-de-CH-negotiation',async()=>{
      const fresh=await browser.newContext({locale:'de-CH'});
      try {const p=await fresh.newPage(); collectPageErrors(p, report); await p.goto(base); await p.waitForFunction(()=>document.documentElement.lang==='de'); await p.getByRole('tab',{name:'Start',exact:true}).waitFor(); assert.equal(await p.evaluate(()=>navigator.language),'de-CH');}
      finally {await fresh.close();}
    });
  }
} catch(e) { report.fatal=String(e); process.exitCode=1; }
finally { await context.close(); await browser.close(); if(workflowFailed(report))process.exitCode=1; fs.writeFileSync(path.join(out,report.mode === 'inspection' ? 'inspection.json' : 'workflow.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2)); }
