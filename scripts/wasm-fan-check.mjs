// Decisive test: run the EXACT viewer path (buildPrePassOnce + processGeometryBatch)
// against the BUILT wasm and count visible fan/sliver triangles. If >0, the built
// wasm's geometry is NOT clean (despite source having clean_degenerate).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const wasmJs = join(root, 'packages/wasm/pkg/ifc-lite.js');
const wasmBin = join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm');
const model = process.argv[2];
if (!model) { console.error('usage: node wasm-fan-check.mjs <model.ifc>'); process.exit(2); }

const { initSync, IfcAPI } = await import(pathToFileURL(wasmJs).href);
const { parseMeshesViaPrePass } = await import(pathToFileURL(join(root, 'scripts/lib/mesh-via-prepass.mjs')).href);
initSync(readFileSync(wasmBin));

const content = readFileSync(model); // Uint8Array; helper handles bytes/string
const api = new IfcAPI();
const meshes = parseMeshesViaPrePass(api, content);

const ulp32 = (v) => { const a = Math.max(Math.fround(Math.abs(v)), 1.2e-38); const b = new Float32Array([a]); const u = new Uint32Array(b.buffer); u[0] += 1; return new Float32Array(u.buffer)[0] - a; };
const d = (p, i, j) => Math.hypot(p[i*3]-p[j*3], p[i*3+1]-p[j*3+1], p[i*3+2]-p[j*3+2]);

const n = meshes.length ?? meshes.size ?? 0;
const get = (k) => (meshes.get ? meshes.get(k) : meshes[k]);
// GLOBAL bbox center over ALL meshes — simulates a PERFECT single global RTC.
let gmin=[Infinity,Infinity,Infinity], gmax=[-Infinity,-Infinity,-Infinity];
for (let k=0;k<n;k++){ const m=get(k); if(!m||!m.positions) continue; const p=m.positions;
  for(let i=0;i<p.length;i+=3){ for(let q=0;q<3;q++){ const v=p[i+q]; if(v<gmin[q])gmin[q]=v; if(v>gmax[q])gmax[q]=v; } } }
const gctr=[(gmin[0]+gmax[0])/2,(gmin[1]+gmax[1])/2,(gmin[2]+gmax[2])/2];
const gspan=[gmax[0]-gmin[0],gmax[1]-gmin[1],gmax[2]-gmin[2]];

let tris = 0, zeroArea = 0, visibleFan = 0, subGrid = 0, visibleFanLocal = 0, visibleFanGlobal = 0, maxWorld = 0;
const GRID = 1/65536;
for (let k = 0; k < n; k++) {
  const m = get(k);
  if (!m || !m.positions || !m.indices) continue;
  const p = m.positions, idx = m.indices;
  // per-mesh centroid for the local-frame control
  let cx0=0, cy0=0, cz0=0; const nv = p.length/3;
  for (let i=0;i<p.length;i+=3){ cx0+=p[i]; cy0+=p[i+1]; cz0+=p[i+2]; }
  cx0/=nv||1; cy0/=nv||1; cz0/=nv||1;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t+1], c = idx[t+2];
    tris++;
    const ab = d(p,a,b), bc = d(p,b,c), ca = d(p,c,a);
    const longest = Math.max(ab, bc, ca);
    if (longest <= 0) { zeroArea++; continue; }
    const ux=p[b*3]-p[a*3], uy=p[b*3+1]-p[a*3+1], uz=p[b*3+2]-p[a*3+2];
    const vx=p[c*3]-p[a*3], vy=p[c*3+1]-p[a*3+1], vz=p[c*3+2]-p[a*3+2];
    const cxp=uy*vz-uz*vy, cyp=uz*vx-ux*vz, czp=ux*vy-uy*vx;
    const area = 0.5*Math.hypot(cxp,cyp,czp);
    const h = 2*area/longest;
    if (area === 0) zeroArea++;
    if (h < GRID) subGrid++;
    let maxc = 0, maxcl = 0;
    for (const vi of [a,b,c]) {
      maxc = Math.max(maxc, Math.abs(p[vi*3]), Math.abs(p[vi*3+1]), Math.abs(p[vi*3+2]));
      maxcl = Math.max(maxcl, Math.abs(p[vi*3]-cx0), Math.abs(p[vi*3+1]-cy0), Math.abs(p[vi*3+2]-cz0));
    }
    // global-recenter: max coord after subtracting the global bbox center
    let maxcg = 0;
    for (const vi of [a,b,c]) for (let q=0;q<3;q++) maxcg = Math.max(maxcg, Math.abs(p[vi*3+q]-gctr[q]));
    maxWorld = Math.max(maxWorld, maxc);
    if (longest > 0.1 && h < ulp32(maxc)) visibleFan++;
    if (longest > 0.1 && h < ulp32(maxcl)) visibleFanLocal++;
    if (longest > 0.1 && h < ulp32(maxcg)) visibleFanGlobal++;
  }
}
console.log(JSON.stringify({ meshes: n, triangles: tris, zeroArea, subGrid_h_lt_15us: subGrid,
  visibleFan_world: visibleFan,
  visibleFan_GLOBALrecenter: visibleFanGlobal,
  visibleFan_LOCALframe: visibleFanLocal,
  maxWorldCoord_m: Math.round(maxWorld),
  globalSpan_m: gspan.map(v=>Math.round(v)),
  globalCenter_m: gctr.map(v=>Math.round(v)) }, null, 2));
api.free?.();
