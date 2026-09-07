# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Frozen actual-server 27-model screen; operator grants exclusive CPU window.
One alternating-order fresh-process pair per SHA-unique fixture. Both captures
finish before any offline witness/retention. No pooled pilots or auto-expansion.
"""
import argparse,json,os,subprocess,sys,time
from pathlib import Path
from screen_compare_v2 import sha,summary
from retention.capacity_guard import check
from retention.clone_duplicates import plan as retention_plan,apply as retention_apply

ROOT=Path(__file__).resolve().parent
SOURCES=['run.py','cache_phase.py','wire.py','wire_arrow_v2.py','screen_http_v2.py','screen_compare_v2.py','screen_offline_pair.py','retention/capacity_guard.py','retention/clone_duplicates.py']

def write(path,value):
 with path.open('x') as f:json.dump(value,f,indent=2);f.write('\n')

def main():
 p=argparse.ArgumentParser()
 for key in ('manifest','training-plan','base-provenance','candidate-provenance','projection','out'):p.add_argument('--'+key,required=True,type=Path)
 p.add_argument('--timeout',type=int,default=600)
 p.add_argument('--cpu-window-confirmed',action='store_true',required=True)
 a=p.parse_args();a.out.mkdir(exist_ok=False)
 fixtures=json.loads(a.manifest.read_text())['expanded_corpus']
 training=json.loads(a.training_plan.read_text())['training']
 training_hashes={f['publicSha256'] for f in training}
 hashes=[f['fixture_identity']['sha256'] for f in fixtures]
 assert len(fixtures)==27 and len(set(hashes))==27 and len(training_hashes)==5 and training_hashes<=set(hashes)
 assert len({f['label'] for f in fixtures})==27
 frozen={name:sha(ROOT/name) for name in SOURCES}
 input_hashes={str(path):sha(path) for path in (a.manifest,a.training_plan,a.base_provenance,a.candidate_provenance,a.projection)}
 artifacts={side:json.loads(path.read_text()) for side,path in [('base',a.base_provenance),('candidate',a.candidate_provenance)]}
 for side,artifact in artifacts.items():assert sha(artifact['binary'])==artifact['binarySha256'],side
 assert artifacts['base']['binarySha256']!=artifacts['candidate']['binarySha256']
 snapshot=a.out/'driver';snapshot.mkdir()
 for name in SOURCES:
  dest=snapshot/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((ROOT/name).read_bytes())
 write(a.out/'protocol.json',{'protocol':'actual-http-pgo-screen-v2','createdUnix':time.time(),'harnessSha256':frozen,
   'artifacts':artifacts,'manifestSha256':sha(a.manifest),'projectionSha256':sha(a.projection),
   'trainingPlanSha256':sha(a.training_plan),'primary':'22 held-out models','secondary':'all27 and fixed training5',
   'pairsPerModel':1,'order':'manifest order; base/candidate even, candidate/base odd',
   'offline':'Only after both timed arms and server cleanup; retention afterward before next pair',
   'expansion':'Five-pair cohort only if heldout22 equal-weight geometric-mean HTTP reduction >=5%, all functional/cache/count/cleanup gates pass, and no clear capacity regression; otherwise report to root. Single-pair timing regressions remain for repeated qualification.',
   'memory':'50ms sampled server RSS through cold readiness and entire cache/cleanup protocol; not physical footprint',
   'failures':'Retain failed arms and exact failed channels. No tolerance, normalization waiver, retries or pilot pooling.'})
 rows=[]
 for index,fixture in enumerate(fixtures):
  label=fixture['label'];pair=a.out/label;pair.mkdir()
  row={'label':label,'fixtureSha256':hashes[index],'training':hashes[index] in training_hashes,'order':['base','candidate'] if index%2==0 else ['candidate','base']}
  print('PAIR',index+1,label,flush=True)
  try:
   permit=check(a.projection,label,a.out,pair/'capacity.json')
   assert permit['fixtureSha256']==hashes[index],'Capacity projection fixture mismatch'
  except Exception as error:
   row['capacityRefusal']=repr(error);rows.append(row);write(pair/'qualification.json',row);break
  assert all(sha(ROOT/name)==digest for name,digest in frozen.items()),'Harness drift'
  assert all(sha(path)==digest for path,digest in input_hashes.items()),'Protocol/provenance drift'
  # Capture an auditable process list outside timing; exclusive host ownership
  # remains an operator prerequisite, not an unreliable process-name heuristic.
  (pair/'pre-pair-processes.txt').write_text(subprocess.check_output(['ps','-axo','pid,ppid,%cpu,comm'],text=True))
  for side in row['order']:
   artifact=artifacts[side]
   assert sha(artifact['binary'])==artifact['binarySha256'],'Artifact drift'
   provenance=a.base_provenance if side=='base' else a.candidate_provenance
   command=[sys.executable,str(ROOT/'run.py'),'--binary',artifact['binary'],'--provenance',str(provenance),'--fixture',fixture['path'],'--out',str(pair/side),'--timeout',str(a.timeout),'--defer-offline']
   env=os.environ.copy();env.pop('LLVM_PROFILE_FILE',None)
   with (pair/(side+'-driver.log')).open('x') as log:
    row[side+'ExitCode']=subprocess.run(command,env=env,stdout=log,stderr=subprocess.STDOUT).returncode
  # Both subprocesses reap their owned server before returning. No decode or
  # retention process exists during either timed arm.
  offline_start=time.time()
  with (pair/'offline.log').open('x') as log:
   offline=subprocess.run([sys.executable,str(ROOT/'screen_offline_pair.py'),str(pair),hashes[index]],stdout=log,stderr=subprocess.STDOUT)
  row['offlineExitCode']=offline.returncode
  if (pair/'offline-qualification.json').exists():row['qualification']=json.loads((pair/'offline-qualification.json').read_text())
  else:row['offlineError']='See retained offline.log'
  row['offlineSeconds']=time.time()-offline_start
  rows.append(row);write(pair/'qualification.json',row)
  # Reclaim duplicate extents only; every path/inode and unique byte survives.
  released=[str((pair/side).relative_to(a.out)) for side in ('base','candidate') if (pair/side).exists()]
  try:
   retention_plan(a.out.absolute(),released,pair/'retention-plan.json')
   retention_apply(pair/'retention-plan.json',pair/'retention.jsonl')
  except Exception as error:
   row['retentionError']=repr(error);write(pair/'retention-failure.json',{'error':repr(error)});break
  write(a.out/('progress-%02d.json'%(index+1)),{'rows':rows,'summary':summary(rows)})
 write(a.out/'final.json',{'rows':rows,'summary':summary(rows),'complete':len(rows)==27 and not any('capacityRefusal' in r or 'retentionError' in r for r in rows)})

if __name__=='__main__':main()
