/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { copiedWallAttachments } from './copy-rebinding.mjs';
import { createHash } from 'node:crypto';
import { compareFzk } from './fzk-oracle.mjs';
import { boundedNode } from './process.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { meshes, wallHit } from './glb.mjs';
const dir=fileURLToPath(new URL('.',import.meta.url)), root=resolve(dir,'../../..');
const cli=resolve(root,'packages/cli/dist/index.js');
export async function run(id,args=process.argv.slice(2)) {
  const option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
  const floors=Number(option('--floors',id==='F5'?40:id==='F4'?6:id==='F2'?2:1));
  const budget=Number(option('--budget-s',900));
  if(!Number.isInteger(floors)||floors<1||!Number.isFinite(budget)||budget<=0) throw new Error('Positive integer floors and positive finite budget required');
  const out=resolve(process.env.PARITY_OUT||resolve(root,'tests/modelling-parity/.out/L2'),`${id}${id==='F5'?`-${floors}`:''}`);
  mkdirSync(out,{recursive:true});
  writeFileSync(resolve(out,'.gitignore'),'*\n');
  const reuse=args.includes('--reuse');
  const prior=reuse&&existsSync(resolve(out,'results.json'))?JSON.parse(readFileSync(resolve(out,'results.json'),'utf8')):[];
  for(const f of reuse?['results.jsonl']:['author.jsonl','results.jsonl']) writeFileSync(resolve(out,f),'');
  if(!reuse) for(const f of ['expected.state','progress.state']) { const p=resolve(out,f); if(existsSync(p)) writeFileSync(p,'null'); }
  const start=performance.now(), deadline=start+budget*1000, results=[];
  const source={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()};
  const runner=`node ${relative(root,process.argv[1])} ${process.argv.slice(2).map(s=>/\s/.test(s)?JSON.stringify(s):s).join(' ')}`.trim();
  const emit=(name,capability,status,reason,metrics={},evidence=[])=>{
    const r={schema:'ifclite-parity-result/1',capability,probe:'exercise',id:`${id}${id==='F5'?`-${floors}`:''}.${name}`,status,...(reason?{reason}:{}),metrics:{ms:0,...metrics},evidence,source,runner};
    results.push(r); appendFileSync(resolve(out,'results.jsonl'),JSON.stringify(r)+'\n');
  };
  const command=(argv,env={})=>boundedNode(argv,{cwd:root,env:{...process.env,...env},deadline,budget,start});
  let meta={elements:0,peakHeap:0,ms:0};
  try {
    if(id==='F3') { emit('reference','psets-classification-valid-ifc4','skip','deferred to R1'); return results; }
    let input=option('--fixture',null);
    if(id==='F6'&&!input) {
      input=resolve(root,'tests/models/ara3d/AC20-FZK-Haus.ifc');
      if(!existsSync(input)) throw new Error('Missing tests/models/ara3d/AC20-FZK-Haus.ifc; run pnpm fixtures');
    }
    if(!input) {
      input=resolve(out,'blank.ifc');
      await command(['--input-type=module','-e',`import {IfcCreator} from './packages/create/dist/index.js'; import {writeFileSync} from 'node:fs'; const c=new IfcCreator({Name:'Parity'});c.addIfcBuildingStorey({Name:'Level 1',Elevation:0});writeFileSync(${JSON.stringify(input)},c.toIfc().content);`]);
    }
    if(id==='F6') emit('fixture','psets-classification-valid-ifc4','pass',null,{sha256:createHash('sha256').update(readFileSync(input)).digest('hex')},[relative(root,input)]);
    const priorTimeout=prior.find(r=>r.id.endsWith('.execution')&&/budget/i.test(r.reason||''));
    if(reuse&&priorTimeout&&(!existsSync(resolve(out,'expected.state'))||readFileSync(resolve(out,'expected.state'),'utf8')==='null')) {
      for(const line of readFileSync(resolve(out,'author.jsonl'),'utf8').trim().split('\n').filter(Boolean)) { const r=JSON.parse(line);emit(r.name,r.capability,r.status,r.reason,r.metrics); }
      meta={ms:priorTimeout.metrics.ms,elements:null,peakHeap:null};
      throw new Error(`${priorTimeout.reason}; original authoring checkpoint absent, element count and heap unavailable`);
    }
    const authorStart=performance.now();
    try { if(!reuse) await command([cli,'run',resolve(dir,'cli.js'),input],{EXERCISE:id,FLOORS:String(floors),EXERCISE_OUT:out,EXERCISE_AUTHOR:pathToFileURL(resolve(dir,'author.mjs')).href}); }
    finally {
      for(const line of readFileSync(resolve(out,'author.jsonl'),'utf8').trim().split('\n').filter(Boolean)) {
        const r=JSON.parse(line);emit(r.name,r.capability,r.status,r.reason,r.metrics);
      }
      if(!reuse) emit('authoring-time','large-tall-model-performance',existsSync(resolve(out,'expected.state'))&&readFileSync(resolve(out,'expected.state'),'utf8')!=='null'?'pass':'fail',existsSync(resolve(out,'expected.state'))&&readFileSync(resolve(out,'expected.state'),'utf8')!=='null'?null:'Authoring did not finish',{ms:performance.now()-authorStart});
    }
    meta=JSON.parse(readFileSync(resolve(out,'expected.state'),'utf8'));
    for(const schema of ['IFC4','IFC2X3']) {
      const t=performance.now(), file=resolve(out,`${schema}.ifc`), evidence=[relative(root,file)];
      try {
        const validation=JSON.parse(await command([cli,'validate',file,'--json']));
        writeFileSync(resolve(out,`${schema}.validation.report`),JSON.stringify(validation));
        if(validation.errors!==0||validation.entityCount<=0) throw new Error(`${validation.errors} validation errors`);
        emit(`validate-${schema}`,'psets-classification-valid-ifc4','pass',null,{ms:performance.now()-t,entities:validation.entityCount},evidence);
      } catch(e) {emit(`validate-${schema}`,'psets-classification-valid-ifc4','fail',e.message,{ms:performance.now()-t},evidence);}
      const reopened=resolve(out,`${schema}.levels.state`);
      await command([cli,'run',resolve(dir,'reopen.js'),file],{REOPEN_OUT:reopened});
      const levels=JSON.parse(readFileSync(reopened,'utf8'));
      const same=meta.levels.every(e=>levels.some(s=>s.Name===e.Name&&Math.abs(s.elevation-e.elevation)<1e-6));
      emit(`reopen-${schema}`,'storeys',same?'pass':'fail',same?null:'Exported storey elevations differ from edited SDK model',{ms:performance.now()-t,storeys:levels.length});
      const text=readFileSync(file,'utf8');
      if(schema==='IFC4') {
        const contained=new Set();
        for(const rel of text.matchAll(/IFCRELCONTAINEDINSPATIALSTRUCTURE\([^;]*?\(([^()]*)\),#\d+\);/g)) for(const m of rel[1].matchAll(/#(\d+)/g)) contained.add(Number(m[1]));
        meta.elements=contained.size; meta.elementCountMeaning='products contained in exported storeys';
      }
      const qty=(text.match(/IFCELEMENTQUANTITY\(/g)||[]).length;
      const qtIds=new Set([...text.matchAll(/#(\d+)\s*=\s*IFCELEMENTQUANTITY\([^;]*BaseQuantities[^;]*;/g)].map(m=>m[1]));
      const covered=new Set();
      for(const m of text.matchAll(/IFCRELDEFINESBYPROPERTIES\([^;]*?\(([^()]*)\),#(\d+)\);/g)) if(qtIds.has(m[2])) for(const n of m[1].matchAll(/#(\d+)/g)) covered.add(Number(n[1]));
      const needed=meta.quantityIds?.length?meta.quantityIds.map(expressId=>({expressId})):meta.expected.filter(e=>e.kind!=='copied');
      const missing=needed.filter(e=>!covered.has(e.expressId));
      emit(`quantities-${schema}`,'schedules-quantities',needed.length&&!missing.length?'pass':needed.length>missing.length?'partial':'fail',missing.length?`Missing base quantities on ${missing.length}/${needed.length} checked elements`:!needed.length?'No checked geometry elements with base quantities':null,{quantities:qty,covered:needed.length-missing.length,missing:missing.length,totalQuantityOwners:covered.size});
      if(id==='F1') {
        const area=20;
        const areas=[...text.matchAll(/IFCQUANTITYAREA\('NetFloorArea',\$,\$,([-+.0-9eE]+)[,)]/g)].map(m=>Number(m[1]));
        const ok=areas.length>=floors&&areas.every(v=>Math.abs(v-area)<1e-6);
        emit(`space-area-${schema}`,'rooms-with-area',ok?'pass':'fail',ok?null:`Expected ${floors} space areas of ${area}m²; got ${areas.join(',')}`,{area,spaces:areas.length});
      }
    }
    if(id==='F6') await command([resolve(dir,'export-glb.mjs'),input,resolve(out,'before.glb')]);
    const t=performance.now(), glb=resolve(out,'model.glb');
    await command([resolve(dir,'export-glb.mjs'),resolve(out,'IFC4.ifc'),glb]);
    const rows=meshes(glb); writeFileSync(resolve(out,'bounds.evidence'),JSON.stringify(rows.map(({triangles,...r})=>r)));
    const text=readFileSync(resolve(out,'IFC4.ifc'),'utf8');
    const guids=Object.fromEntries([...text.matchAll(/#(\d+)\s*=\s*IFC[A-Z0-9]+\('([^']+)'/g)].map(m=>[m[1],m[2]]));
    const aggregates=new Map([...text.matchAll(/IFCRELAGGREGATES\([^;]*?,#(\d+),\(([^()]*)\)\);/g)].map(m=>[Number(m[1]),[...m[2].matchAll(/#(\d+)/g)].map(n=>Number(n[1]))]));
    const find=e=>{
      const pending=[e], seen=new Set(), found=[];
      while(pending.length) { const n=pending.pop(); if(seen.has(n)) continue; seen.add(n);
        found.push(...rows.filter(r=>r.expressId===n||r.name===guids[n])); pending.push(...(aggregates.get(n)||[])); }
      if(!found.length) return null;
      return {min:[0,1,2].map(k=>Math.min(...found.map(r=>r.min[k]))),max:[0,1,2].map(k=>Math.max(...found.map(r=>r.max[k]))),triangles:found.flatMap(r=>r.triangles)};
    };
    if(id==='F6') {
      const original=meshes(resolve(out,'before.glb'));
      const before=original.find(r=>r.expressId===meta.movedWall), after=find(meta.movedWall);
      // GLB recentres the scene. Remove the common shift using unchanged products.
      const shifts=original.filter(r=>r.expressId!==meta.movedWall).map(r=>{const a=rows.find(n=>n.expressId===r.expressId);return a?a.min.map((v,k)=>v-r.min[k]):null;}).filter(Boolean);
      const common=[0,1,2].map(k=>shifts.map(v=>v[k]).sort((a,b)=>a-b)[Math.floor(shifts.length/2)]||0);
      const delta=before&&after?after.min.map((v,i)=>v-before.min[i]-common[i]):null;
      const ok=delta&&Math.abs(Math.hypot(delta[0],delta[2])-1)<0.06&&Math.abs(delta[1])<0.06;
      const doorId=meta.quantityIds?.find(n=>new RegExp(`#${n}\\s*=\\s*IFCDOOR\\(`).test(text));
      const door=doorId&&find(doorId), dx=after&&after.max[0]-after.min[0], dz=after&&after.max[2]-after.min[2];
      if(!door||!after||Math.min(dx,dz)/Math.max(dx,dz)>0.1) {
        emit('fixture-door-cut','hosted-doors-windows-from-types','partial','Door or axis-aligned host mesh unavailable for independent cut rays');
      } else {
        const axis=dx>dz?0:2, center=(door.min[axis]+door.max[axis])/2, height=(door.min[1]+door.max[1])/2;
        const projected=axis===0?after:{triangles:after.triangles.map(t=>t.map(p=>[p[2],p[1],p[0]]))};
        const width=door.max[axis]-door.min[axis];
        const adjacent=[center-width*1.5,center+width*1.5].some(x=>x>after.min[axis]&&x<after.max[axis]&&wallHit(projected,x,height));
        const cut=!wallHit(projected,center,height)&&adjacent;
        emit('fixture-door-cut','hosted-doors-windows-from-types',cut?'pass':'fail',cut?null:'GLB ray at actual door centre must miss host, with solid wall beside it',{center,height});
      }
      emit('moved-wall-oracle','transforms-move-copy-rotate-mirror-array',ok?'pass':'fail',ok?null:`Expected 1m horizontal move; got ${JSON.stringify(delta)}`,{...(delta?{delta}:{})});
    }
    // Copy returns refs in its own order. Derive copied geometry types and levels
    // from exported containment, never by zipping return values with source ids.
    if(id==='F2') compareFzk({text,find,levels:meta.levels,emit});
    const originalExpected=meta.expected.filter(e=>e.kind!=='copied'&&!e.copied);
    const kindFor={IFCWALL:'wall',IFCCOLUMN:'column',IFCCURTAINWALL:'curtain',IFCSTAIR:'stair'};
    for(const rel of text.matchAll(/IFCRELCONTAINEDINSPATIALSTRUCTURE\([^;]*?\(([^()]*)\),#(\d+)\);/g)) {
      const level=meta.levels.findIndex(s=>s.expressId===Number(rel[2]));
      if(id==='F2'||level<=0||level>=meta.levels.length-1) continue;
      for(const m of rel[1].matchAll(/#(\d+)/g)) {
        const expressId=Number(m[1]), type=text.match(new RegExp(`#${expressId}\\s*=\\s*([A-Z0-9]+)`))?.[1], kind=kindFor[type];
        if(type==='IFCSLAB'&&meta.shafts?.length) meta.shafts.push({...meta.shafts[0],expressId});
        if(kind) originalExpected.push({expressId,kind,copied:true,level,min:meta.levels[level].elevation,max:meta.levels[level+1].elevation});
      }
    }
    meta.expected=originalExpected;
    for(const e of meta.expected) {
      if(e.kind==='copied') continue;
      const mesh=find(e.expressId), axis=1;
      const ok=mesh&&(e.kind==='stair'?mesh.min[axis]>=e.min-0.06&&mesh.min[axis]<e.min+0.5:Math.abs(mesh.min[axis]-e.min)<0.06)&&Math.abs(mesh.max[axis]-e.max)<0.06;
      emit(`bounds-${e.expressId}`,e.kind==='column'?'columns-beams-on-grid-follow-levels':e.kind==='curtain'?'curtain-walls':e.kind==='stair'?'stairs-railings':'wall-top-base-constraints',ok?'pass':'fail',ok?null:`${e.kind} expected height ${e.min}..${e.max}; got ${mesh?`${mesh.min[axis]}..${mesh.max[axis]}`:'no mesh'}`,{ms:performance.now()-t,...(mesh?{min:mesh.min,max:mesh.max}:{} )},[relative(root,resolve(out,'bounds.evidence'))]);
    }
    for(const e of meta.shafts||[]) {
      const mesh=find(e.expressId);
      const vertical=mesh&&{triangles:mesh.triangles.map(tri=>tri.map(p=>[p[0],p[2],p[1]]))};
      const ok=vertical&&!wallHit(vertical,e.x,-e.y)&&wallHit(vertical,e.x+3,-e.y);
      emit(`shaft-${e.expressId}`,'slab-with-openings',ok?'pass':'fail',ok?null:'Vertical GLB ray at shaft centre must miss floor and adjacent ray must hit');
    }
    for(const e of meta.openings) {
      const mesh=find(e.expressId), ok=mesh&&!wallHit(mesh,e.x,e.z)&&wallHit(mesh,e.x+(e.adjacentOffset||1),e.z);
      emit(`opening-${e.expressId}`,'hosted-doors-windows-from-types',ok?'pass':'fail',ok?null:'GLB ray at hosted opening centre must miss host and adjacent ray must hit');
    }
    const records=new Map([...text.matchAll(/#(\d+)\s*=\s*([^;]+);/g)].map(m=>[Number(m[1]),m[2]]));
    const {checked,wrong,missing,copiedWalls,copiedCount}=copiedWallAttachments(meta,records);
    if(copiedCount) emit('copy-rebinding','copy-to-levels',copiedWalls&&!wrong&&!missing?'pass':wrong||missing?'fail':'partial',wrong||missing?`${wrong}/${checked} copied wall constraints target a different storey; ${missing}/${copiedWalls} walls lack an attachment`:copiedWalls?null:'No copied walls to check',{checked,wrong,missing,copiedWalls:copiedWalls});
  } catch(e) {if(existsSync(resolve(out,'progress.state'))) meta=JSON.parse(readFileSync(resolve(out,'progress.state'),'utf8'))||meta; emit('execution','large-tall-model-performance','fail',e.message,{ms:performance.now()-start,completedSteps:results.length});}
  finally {
    const failed=results.filter(r=>['fail','error','partial'].includes(r.status)).length;
    emit('summary','large-tall-model-performance',results.some(r=>r.id.endsWith('.execution'))?'fail':failed?'partial':id==='F3'?'skip':'pass',failed?`${failed} failed or partial steps; see individual results`:id==='F3'?'deferred to R1':null,{ms:(reuse?meta.ms+performance.now()-start:performance.now()-start),completedSteps:results.filter(r=>r.status==='pass').length,totalSteps:results.length,elements:meta.elements,peakHeap:meta.peakHeap,elementCountMeaning:meta.elementCountMeaning||'completed SDK mutation counter; lower bound when interrupted'});
    writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2)+'\n');
    console.log(`${id} (${floors} floors): ${results.filter(r=>r.status==='pass').length} pass, ${failed} fail/partial, ${((performance.now()-start)/1000).toFixed(1)}s`);
  }
  return results;
}
