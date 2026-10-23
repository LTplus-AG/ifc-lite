/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Linux physical-console counterpart of the retained Windows qualification.
// Same CPU and available-memory thresholds; worker benchmark admission owns
// exclusivity. Raw NVIDIA observations remain evidence, never timestamp timing.
const run = (cmd, args) => execFileSync(cmd, args, {encoding:'utf8',timeout:10000}).trim();
export function readPhysicalSession() {
 const fields=Object.fromEntries(run('loginctl',['show-session','3','-p','Active','-p','Remote','-p','Seat','-p','Type','-p','Leader','-p','LockedHint']).split('\n').map(row=>row.split('=')));
 const connectors=readdirSync('/sys/class/drm').filter(name=>existsSync(`/sys/class/drm/${name}/status`)).map(name=>({name,status:readFileSync(`/sys/class/drm/${name}/status`,'utf8').trim()}));
 return {...fields,connectors,currentSession:Number(fields.Leader),display:process.env.DISPLAY,wayland:process.env.WAYLAND_DISPLAY};
}
export function isPhysicalConsole(value) {
 return value.Active==='yes' && value.Remote==='no' && value.LockedHint==='no' && value.Seat==='seat0' && ['wayland','x11'].includes(value.Type) && value.connectors.some(row=>row.status==='connected') && value.display===':1' && value.wayland==='wayland-1';
}
function cpu() {
 return readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);
}
function graphs() {
 const rows=[];
 for(const pid of readdirSync('/proc').filter(name=>/^\d+$/.test(name))) {
  try {
   const args=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
   const exe=args[0].split('/').at(-1);
   if(['bash','sh','python3','ssh','timeout'].includes(exe)) continue;
   const kinds=['turbo run','pnpm build','pnpm test','pnpm typecheck','rustc','cargo test','cargo clippy','wasm-pack','typescript/bin/tsc','tsx --test','perf_probe'].filter(text=>args.join(' ').includes(text));
   if(kinds.length) rows.push({pid:Number(pid),exe,kinds});
  } catch(error) { if(!['ENOENT','ESRCH'].includes(error.code)) throw error; }
 }
 return rows;
}
export async function readHostAdmission() {
 const before=cpu(), first=graphs();await sleep(1000);const after=cpu(),last=graphs();
 const delta=after.map((v,i)=>v-before[i]);
 const total=delta.reduce((a,b)=>a+b,0), busy=100*(total-delta[3]-delta[4])/total;
 const mem=Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo','utf8'))?.[1]);
 const gpu=run('nvidia-smi',['--query-gpu=name,uuid,utilization.gpu,memory.used,temperature.gpu,power.draw','--format=csv,noheader,nounits']);
 const ac=readFileSync('/sys/class/power_supply/AC/online','utf8').trim()==='1';
 return {capturedAt:new Date().toISOString(),policy:{maximumCpuPercent:10,minimumMemoryKiB:41943040},cpuPercent:busy,MemAvailableKiB:mem,graphsBefore:first,graphsAfter:last,gpu,ac,quiet:Number.isFinite(busy)&&busy<=10&&mem>=41943040&&first.length===0&&last.length===0&&ac};
}
export async function launchNativeChrome(chromium) {
 return chromium.launch({headless:false,executablePath:'/home/louistrue/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',args:['--enable-gpu','--enable-webgpu','--enable-unsafe-webgpu','--use-angle=vulkan','--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan','--ignore-gpu-blocklist','--enable-logging=stderr','--ozone-platform=wayland']});
}
