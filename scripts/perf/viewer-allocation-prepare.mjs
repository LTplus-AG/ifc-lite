/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {SUBJECTS,FIXTURE,requireFixedDispatch} from './viewer-allocation-plan.mjs';
import {fileHash,inventory} from './interleaved-assets.mjs';
import {inputProtocol,INPUT_SUBJECTS,qualifyInputSubjects} from './input-witness-integration.mjs';
const protocol=inputProtocol(process.env.INDEPENDENT_INPUT_DIAGNOSTIC);
const subjects=protocol?INPUT_SUBJECTS:SUBJECTS;
const root=resolve(import.meta.dirname,'../..'),output=join(root,'viewer-allocation-results');
mkdirSync(output,{recursive:true});
const dirs={base:resolve(root,'../allocation-base'),candidate:resolve(root,'../allocation-candidate')};
const git=(dir,...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',timeout:5000}).trim();
const save=(name,data)=>writeFileSync(join(output,name),JSON.stringify(data,null,2));
async function sources(dir) {
  const files=execFileSync('git',['ls-files','-z'],{cwd:dir}).toString().split('\0').filter(Boolean);
  const hashes={};for(const file of files)hashes[file]=await fileHash(join(dir,file));return hashes;
}
const mode=process.argv[2];
if(mode==='validate')requireFixedDispatch(process.env.REQUESTED_BASE_REF,process.env.REQUESTED_CANDIDATE_REF);
if(mode==='validate') save('protocol.json',{subjects,protocol,fixture:FIXTURE,controls:['base','candidate'],retries:0,scope:protocol?'Instrumented allocation and independent CPU/scene appearance correctness only; no timing verdict':'Allocation diagnostic only'});
else if(mode==='fixtures') {
  execFileSync('node',['scripts/fixtures/fetch-fixtures.mjs',FIXTURE.path],{cwd:root,stdio:'inherit'});
  execFileSync('node',['scripts/fixtures/fetch-fixtures.mjs','--check',FIXTURE.path],{cwd:root,stdio:'inherit'});
} else if(mode==='start') {
  const sourceInputs={};
  for(const arm of Object.keys(subjects)) {
    if(git(dirs[arm],'rev-parse','HEAD')!==subjects[arm] || git(dirs[arm],'status','--porcelain','--untracked-files=no'))throw new Error('Frozen subject checkout mismatch');
    for(const path of ['rust-toolchain.toml','.github/actions/setup-wasm-build/action.yml'])
      if(readFileSync(join(dirs[arm],path),'utf8')!==readFileSync(join(root,path),'utf8'))throw new Error('Pinned build toolchain differs');
    sourceInputs[arm]=await sources(dirs[arm]);
  }
  save('build-start.json',{timestampMs:Date.now(),dirs,sourceInputs});
} else if(mode==='freeze') {
  const start=JSON.parse(readFileSync(join(output,'build-start.json'),'utf8')),builds={};
  if(git(root,'status','--porcelain','--untracked-files=no'))throw new Error('Controller source is not committed/clean');
  for(const arm of Object.keys(subjects)) {
    const dir=dirs[arm],wasm=join(dir,'packages/wasm/pkg/ifc-lite_bg.wasm');
    if(git(dir,'rev-parse','HEAD')!==subjects[arm] || git(dir,'status','--porcelain','--untracked-files=no')
      || JSON.stringify(await sources(dir))!==JSON.stringify(start.sourceInputs[arm]) || statSync(wasm).mtimeMs<start.timestampMs)throw new Error('Source changed or WASM predates fresh build');
    const viewer=await inventory(join(dir,'apps/viewer/dist')),wasmSha256=await fileHash(wasm);
    if(!viewer.some(asset=>asset.path.endsWith('.wasm')&&asset.sha256===wasmSha256))throw new Error('Fresh default WASM absent in viewer');
    builds[arm]={dir,revision:subjects[arm],sourceTree:git(dir,'rev-parse','HEAD^{tree}'),sourceInputs:start.sourceInputs[arm],viewer,wasmSha256};
  }
  const manifest=JSON.parse(readFileSync(join(root,'tests/models/manifest.json'),'utf8'));
  const entry=manifest.files.find(file=>file.path===FIXTURE.path),file=join(root,'tests/models',FIXTURE.path);
  if(!entry||entry.size!==FIXTURE.size||entry.sha256!==FIXTURE.sha256||statSync(file).size!==FIXTURE.size||await fileHash(file)!==FIXTURE.sha256)throw new Error('Exact public O-S1 bytes missing');
  const inputProof=protocol?await qualifyInputSubjects(builds):undefined;
  save('provenance.json',{protocol,inputProof,builds,fixture:{...FIXTURE,file,release:manifest.release_tag,baseUrl:manifest.base_url},
    harness:{head:git(root,'rev-parse','HEAD'),sourceTree:git(root,'rev-parse','HEAD^{tree}'),sourceInputs:await sources(root)},
    runtime:{node:process.version,toolVersions:Object.fromEntries([['pnpm',['--version']],['rustc',['--version']],['wasm-pack',['--version']]].map(([tool,args])=>[tool,execFileSync(tool,args,{encoding:'utf8'}).trim()])),nodeExecutableSha256:await fileHash(process.execPath),
      chrome:execFileSync('google-chrome',['--version'],{encoding:'utf8'}).trim(),chromeExecutableSha256:await fileHash('/opt/google/chrome/chrome'),
      cpu:readFileSync('/proc/cpuinfo','utf8'),memory:readFileSync('/proc/meminfo','utf8')},frozenUTC:new Date().toISOString()});
} else throw new Error('Expected validate, fixtures, start or freeze');
