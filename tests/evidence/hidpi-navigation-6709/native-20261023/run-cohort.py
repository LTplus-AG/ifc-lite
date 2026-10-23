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
 r=json.loads((state/'jobs'/job/'receipt.json').read_text())
 if r.get('state')!='completed' or r.get('exitCode')!=0 or not r.get('sourceUnchanged'):raise RuntimeError(f'Prerequisite not qualified: {job}: {r.get("state")} sourceUnchanged={r.get("sourceUnchanged")}')
 assert r['sourceAfter']['commit']==pair['candidate' if side=='candidate' else 'control']
 if side=='candidate':
  command=' '.join(r['command'])
  assert 'pnpm test --filter=@ifc-lite/viewer' in command and 'TEST_PATTERN=' in command
 receipts.append(r)
(out/'preparation-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
subprocess.run(['python3',str(out/'freeze-builds.py')],check=True)
root=receipts[0]['cwd']
env=os.environ|{'IFC_6709_ROOT':root,'IFC_6709_EVIDENCE':str(out),'IFC_6709_MODEL':fixture_receipt['cwd']+'/tests/models/ara3d/AC20-FZK-Haus.ifc','DISPLAY':':1','WAYLAND_DISPLAY':'wayland-1','XDG_RUNTIME_DIR':'/run/user/1000','DEBUG':'pw:browser'}
(out/'harness-sha256.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in out.iterdir() if p.suffix in ['.py','.mts']},indent=2)+'\n')
command=['node','--import',root+'/node_modules/tsx/dist/loader.mjs',str(out/'qualification.mts')]
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
 assert not subprocess.check_output(['git','-C',manifest['checkout'],'status','--porcelain'],text=True)
 for artifact in manifest['artifacts']:
  assert hashlib.sha256((Path(manifest['checkout'])/artifact['path']).read_bytes()).hexdigest()==artifact['sha256'],artifact['path']
print('Frozen source and artifacts unchanged after complete cohort',flush=True)

assert hashlib.sha256(Path(env['IFC_6709_MODEL']).read_bytes()).hexdigest()=='d42ab0dee01173106c16cd823b4614efe188fa15dd65195d95b9879bec59acc5'
