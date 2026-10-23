# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from pathlib import Path
import json,os,subprocess,time,hashlib,re
out=Path(__file__).parent
state=Path('/home/louistrue/build-workers/worker-state')
fixture_receipt=json.loads((state/'jobs/79bb1a29-fac6-46bc-975f-f10d399fc90c/receipt.json').read_text())
assert fixture_receipt.get('state')=='completed' and fixture_receipt.get('exitCode')==0, 'Canonical fixture preparation is not successful'
pair=json.loads((out/'source-pair.json').read_text())
jobs=json.loads((out/'preparation-jobs.json').read_text())
receipts=[]
for side in ['candidate','base']:
 job=jobs[side]
 assert isinstance(job,str), f'{side} preparation has not been submitted'
 r=json.loads((state/'jobs'/job/'receipt.json').read_text())
 if r.get('state')!='completed' or r.get('exitCode')!=0 or not r.get('sourceUnchanged'):raise RuntimeError(f'Prerequisite not qualified: {job}: {r.get("state")} sourceUnchanged={r.get("sourceUnchanged")}')
 assert r['sourceAfter']['commit']==pair['candidate' if side=='candidate' else 'control']
 receipts.append(r)
transfers={}
for index,side in enumerate(['candidate','base']):
 transfer=json.loads((out/f'pc-{side}-transfer.json').read_text())
 producer=transfer['receipt']
 assert producer['id']==jobs[f'pc{side.title()}Producer'], 'PC producer differs from the declared preparation'
 assert transfer['host']=='pc-wsl' and producer['state']=='completed' and producer['exitCode']==0
 assert producer['sourceUnchanged'] and producer['sourceBefore']==producer['sourceAfter']
 assert transfer['wasmMtime']>=transfer['latestRustMtime'], 'PC runtime predates its Rust sources'
 assert producer['sourceAfter']['commit']==pair['candidate' if side=='candidate' else 'control']
 assert producer['sourceAfter']['toolchainInputs']==receipts[index]['sourceAfter']['toolchainInputs']
 if side=='base':
  assert receipts[index]['command'][-3:]==[str(out/'stage-pc-build.py'),side,producer['id']], 'Staging job must bind the original PC producer'
 else:
  binding=json.loads((out/'candidate-stage-binding.json').read_text())
  assert receipts[index]['command'][-3:]==[str(out/'stage-candidate-when-ready.py'),jobs['pcCandidateOriginalProducer'],jobs['pcBaseProducer']]
  assert binding['pcProducer']==producer['id'] and binding['childCommand']==['python3',str(out/'stage-pc-build.py'),'candidate',producer['id']]
 assert transfer['sourceCheckout']==receipts[index]['cwd']
 command=' '.join(producer['command'])
 if side=='candidate':
  repack=transfer['sharedRuntimeProof']
  assert producer['command'][1].endswith('/repack-pc-candidate.py')
  assert repack['scriptSHA256']==hashlib.sha256((out/'repack-pc-candidate.py').read_bytes()).hexdigest()
  assert repack['state']=='completed' and repack['rustAndWasmInputsIdentical']
  assert repack['preparations']['candidate']['id']==jobs['pcCandidateOriginalProducer']
  assert repack['canonicalProducer']==jobs['pcBaseProducer']
  assert producer['command'][-2:]==[jobs['pcCandidateOriginalProducer'],jobs['pcBaseProducer']]
  assert [step['command'][1] for step in repack['steps']]==['build','test'] and all(step['exitCode']==0 for step in repack['steps'])
 else:
  assert 'pnpm build --filter=@ifc-lite/viewer --concurrency=2' in command
 transfers[side]=transfer
assert repack['canonicalRuntime']=={row['path'].split('/')[-1]:row['sha256'] for row in transfers['base']['artifacts'] if row['path'].startswith('packages/wasm/pkg/')}
(out/'preparation-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
subprocess.run(['python3',str(out/'freeze-builds.py')],check=True,timeout=600)
for side,transfer in transfers.items():
 manifest=json.loads((out/f'{side}-build-manifest.json').read_text())
 assert manifest['buildRoot']==transfer['stagedRoot']
 assert {r['path']:(r['bytes'],r['sha256']) for r in manifest['artifacts']}=={r['path']:(r['bytes'],r['sha256']) for r in transfer['artifacts']}, 'Served build differs from original PC output'
candidate_manifest=json.loads((out/'candidate-build-manifest.json').read_text())
validated_root=Path(candidate_manifest['checkout']).resolve()
receipt_root=Path(receipts[0]['cwd']).resolve()
if receipt_root != validated_root:
 raise RuntimeError(f'Candidate receipt cwd does not match validated checkout: {receipt_root} != {validated_root}')
root=str(validated_root)
env=os.environ|{'IFC_6709_ROOT':root,'IFC_6709_EVIDENCE':str(out),'IFC_6709_MODEL':fixture_receipt['cwd']+'/tests/models/ara3d/AC20-FZK-Haus.ifc','DISPLAY':':1','WAYLAND_DISPLAY':'wayland-1','XDG_RUNTIME_DIR':'/run/user/1000','DEBUG':'pw:browser'}
(out/'harness-sha256.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.suffix in ['.py','.mts']},indent=2)+'\n')
command=['node','--import',root+'/node_modules/tsx/dist/loader.mjs',str(out/'qualification.mts')]
with (out/'frame-dimensions-controls.json').open('w') as controls:
 subprocess.run(command[:-1]+[str(out/'frame-dimensions-controls.mts')],stdout=controls,check=True,timeout=30)
summary=[]
for mode in ['smoke','interleaved']:
 time.sleep(10)
 env['IFC_6709_DEADLINE']=str(int((time.time()+27*60)*1000))
 before=set(out.glob('cohort-*'))
 with (out/f'{mode}.log').open('w') as log:
  result=subprocess.run(command+(['--smoke'] if mode=='smoke' else []),env=env,stdout=log,stderr=subprocess.STDOUT,timeout=30*60)
 driver_errors=[line for line in (out/f'{mode}.log').read_text().splitlines() if re.search(r'ERROR:gpu/|GL_INVALID_|uninitialized SharedImage|GPU process.*crash',line,re.I)]
 generated=set(out.glob('cohort-*'))-before
 assert len(generated)==1,generated
 directory=generated.pop()
 record=json.loads((directory/'summary.json').read_text()) if (directory/'summary.json').exists() else {'completedSuccessfully':False}
 if driver_errors:record.update(completedSuccessfully=False,allAccepted=False,performanceVerdict="DISQUALIFIED: native GPU driver errors",driverErrors=driver_errors)
 summary.append({'mode':mode,'exitCode':result.returncode,'output':str(directory),'summary':record})
 (out/'cohort-result.json').write_text(json.dumps(summary,indent=2)+'\n')
 print(mode,result.returncode,record,flush=True)
 if result.returncode or not record['completedSuccessfully']:raise RuntimeError(f'{mode} failed; retained, no replacement samples')
# Revalidate every frozen artifact after all native execution.
for name in ['candidate','base']:
 manifest=json.loads((out/f'{name}-build-manifest.json').read_text())
 assert not subprocess.check_output(['git','-C',manifest['checkout'],'status','--porcelain'],text=True,timeout=60)
 for artifact in manifest['artifacts']:
  assert hashlib.sha256((Path(manifest['buildRoot'])/artifact['path']).read_bytes()).hexdigest()==artifact['sha256'],artifact['path']
print('Frozen source and artifacts unchanged after complete cohort',flush=True)

assert hashlib.sha256(Path(env['IFC_6709_MODEL']).read_bytes()).hexdigest()=='d42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5'
