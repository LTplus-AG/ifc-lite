// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire('/tmp/ifc-lite-6610-docstack/package.json');
const { chromium } = require('@playwright/test');
const dir='/tmp/6610-final-proof'; mkdirSync(dir,{recursive:true});
const document=JSON.parse(readFileSync('/tmp/6610-takeover-proof/persisted-document-before.json','utf8'));
const profile=mkdtempSync('/tmp/6610-final-chrome-'); let context;
const errors=[];
try {
 context=await chromium.launchPersistentContext(profile,{executablePath:'/usr/bin/google-chrome',headless:true,acceptDownloads:true,viewport:{width:1920,height:1400},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-vulkan=swiftshader','--use-angle=vulkan']});
 const page=context.pages()[0]; page.on('pageerror',e=>errors.push({kind:'pageerror',message:e.message}));page.on('console',m=>{if(m.type()==='error')errors.push({kind:'console',message:m.text()});});
 await page.goto('http://localhost:7992/?model=/samples/building-architecture.ifc',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>globalThis.__ifc_lite_viewer_store__?.getState().models.size>0,{timeout:120000});
 await page.getByRole('button',{name:'Privacy settings',exact:true}).waitFor({state:'visible',timeout:20000});
 await page.getByRole('button',{name:'Privacy settings',exact:true}).locator('..').getByRole('button',{name:'Dismiss notification',exact:true}).click();
 await page.evaluate(doc=>{const s=globalThis.__ifc_lite_viewer_store__.getState();s.upsertDocument(doc);s.setActiveDocumentId(doc.id);s.showWorkspacePanel('document');s.setSidebarActivePanel('document');},document);
 await page.waitForFunction(()=>[...window.document.querySelectorAll('[data-document-preview]')].some(p=>p.querySelectorAll('[data-preview-section]').length===11&&p.getAttribute('data-layout-pending')!=='true'),{timeout:120000});
 await page.screenshot({path:dir+'/whole-viewer.png'});
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Export PDF',exact:true}).last().click();const download=await downloadPromise;await download.saveAs(dir+'/eleven-pages.pdf');
 const notices=page.getByRole('button',{name:'Dismiss notification',exact:true});
 for (let guard=0;guard<10&&await notices.count()>0;guard++) await notices.first().click();
 const models=await page.evaluate(()=>[...globalThis.__ifc_lite_viewer_store__.getState().models.values()].map(m=>({name:m.name,schema:m.sourceSchema,sourceFingerprint:m.sourceFingerprint,sourceContentHash:m.sourceContentHash,meshCount:m.geometryResult?.meshes.length})));
 const before=await page.evaluate(id=>globalThis.__ifc_lite_viewer_store__.getState().documents.find(d=>d.id===id),document.id);
 await page.getByRole('button',{name:'Maximize',exact:true}).last().click();
 const panel=page.locator('[data-document-panel]:visible').last();const sheets=panel.locator('[data-preview-section]');await sheets.first().screenshot({path:dir+'/first-page.png'});await sheets.last().screenshot({path:dir+'/last-page.png'});
 const witness=await sheets.evaluateAll(nodes=>nodes.map((n,i)=>({page:i+1,text:n.textContent,images:[...n.querySelectorAll('img')].map(img=>({complete:img.complete,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight}))})));
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(id=>globalThis.__ifc_lite_viewer_store__?.getState().documents.some(d=>d.id===id)&&globalThis.__ifc_lite_viewer_store__.getState().models.size>0,document.id,{timeout:120000});
 const after=await page.evaluate(id=>globalThis.__ifc_lite_viewer_store__.getState().documents.find(d=>d.id===id),document.id);
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Persisted document differs');
 await page.screenshot({path:dir+'/reloaded-viewer.png'});
 writeFileSync(dir+'/receipt.json',JSON.stringify({models,witness,document:before,persistenceEqual:true,errors},null,2));
 console.log(JSON.stringify({models,pages:witness.length,persistenceEqual:true,errors}));
}finally{if(context)await context.close();rmSync(profile,{recursive:true,force:true});}
