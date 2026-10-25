/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root='/home/louistrue/build-workers/worker-state/checkouts/be5c740cb9f1c57e4d1531ed574e2708839996be';
const out=fileURLToPath(new URL('.',import.meta.url));
const variants={
 'vulkan-blit':['--use-angle=vulkan','--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan','--disable-vulkan-surface'],
 'gl-vulkan-compositor':['--use-gl=angle','--use-angle=gl','--enable-features=Vulkan'],
 'wayland-default':['--ozone-platform=wayland'],
 'vulkan-independent':['--use-angle=vulkan','--enable-features=Vulkan','--disable-vulkan-surface'],
};
const selected=process.argv[2];
if(!selected){
 const results=[];
 for(const name of Object.keys(variants)){
  const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),name],{encoding:'utf8',timeout:45000,env:{...process.env,DEBUG:'pw:browser'},maxBuffer:4*1024*1024});
  writeFileSync(out+name+'.log',result.stdout+'\n'+result.stderr);
  let record;try{record=JSON.parse(result.stdout.trim().split('\n').at(-1));}catch(error){record={name,error:String(error),processError:String(result.error)};}
  const driverErrors=result.stderr.split('\n').filter(line=>/ERROR:gpu\/|GL_INVALID_|uninitialized SharedImage|GPU process.*crash/i.test(line));
  results.push({...record,exitCode:result.status,driverErrors,capabilityOnly:true});
  writeFileSync(out+'results.json',JSON.stringify(results,null,2));
  console.log(name,record.adapter,record.error,'driverErrors',driverErrors.length);
 }
 process.exit(0);
}
const {chromium}=createRequire(root+'/package.json')('@playwright/test');
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><body><canvas id="gpu" width="400" height="300"></canvas><canvas id="gl" width="400" height="300"></canvas></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;const record={name:selected,flags:variants[selected],errors:[]};
try{
 browser=await chromium.launch({headless:false,executablePath:'/home/louistrue/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--ignore-gpu-blocklist','--enable-logging=stderr',...(selected.startsWith('wayland')?[]:['--ozone-platform=x11']),...variants[selected]]});
 record.browserVersion=browser.version();
 const page=await browser.newPage({viewport:{width:1024,height:768},deviceScaleFactor:2});
 page.on('pageerror',error=>record.errors.push(String(error)));
 await page.goto('http://127.0.0.1:'+server.address().port);
 Object.assign(record,await page.evaluate(async()=>{
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)return {error:'No WebGPU adapter'};
  const info=adapter.info, device=await adapter.requestDevice();
  const errors=[];device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
  const canvas=document.getElementById('gpu'),ctx=canvas.getContext('webgpu');
  ctx.configure({device,format:navigator.gpu.getPreferredCanvasFormat()});
  const gl=document.getElementById('gl').getContext('webgl2');
  if(!gl)return {error:'No WebGL2 context',adapter:{vendor:info.vendor,fallback:info.isFallbackAdapter}};
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  for(let i=0;i<30;i++){
   const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:ctx.getCurrentTexture().createView(),clearValue:{r:1,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
   pass.end();device.queue.submit([encoder.finish()]);
   gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
   await new Promise(requestAnimationFrame);
  }
  await device.queue.onSubmittedWorkDone();
  const pixels=new Uint8Array(4);gl.readPixels(100,100,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  return {adapter:{vendor:info.vendor,architecture:info.architecture,fallback:info.isFallbackAdapter},glRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,glError:gl.getError(),glPixels:[...pixels],deviceErrors:errors,dpr:devicePixelRatio,visible:document.visibilityState,focused:document.hasFocus()};
 }));
 await page.screenshot({path:out+selected+'.png',timeout:10000});
 const cdp=await browser.newBrowserCDPSession();record.systemInfo=await cdp.send('SystemInfo.getInfo');
}catch(error){record.error=String(error);}
finally{
 if(browser)await browser.close();
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
console.log(JSON.stringify(record));
