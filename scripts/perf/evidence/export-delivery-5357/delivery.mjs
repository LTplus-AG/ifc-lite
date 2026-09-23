// SPDX-License-Identifier: MPL-2.0
import {createRequire} from 'node:module';import{readFileSync,writeFileSync}from'node:fs';
const require=createRequire('/home/louistrue/.t3/worktrees/ifc-lite/t3code-41de0393/package.json');const{chromium}=require('@playwright/test');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();await page.goto('https://www.ifclite.com/',{waitUntil:'domcontentloaded',timeout:60000});
 const result=await page.evaluate(async url=>{
  const start=performance.now();const response=await fetch(url,{cache:'no-store'});const headers=Object.fromEntries(response.headers);const copy=response.clone();
  const compiled=await WebAssembly.compileStreaming(response);const elapsed=performance.now()-start;const bytes=await copy.arrayBuffer();
  return{url,status:response.status,headers,decodedBytes:bytes.byteLength,fetch_compile_ms:elapsed,exports:WebAssembly.Module.exports(compiled).length,resources:performance.getEntriesByName(url).map(r=>r.toJSON()),userAgent:navigator.userAgent,caveat:'Single live delivery/compile observation on contended host; no changed deployment and not a completed model-load benchmark.'};
 },readFileSync('/tmp/ifc-export-spikes/wasm-url.txt','utf8'));
 writeFileSync('/tmp/ifc-export-spikes/delivery.json',JSON.stringify(result,null,2));console.log(result.decodedBytes,result.fetch_compile_ms);
}finally{await browser.close();}
