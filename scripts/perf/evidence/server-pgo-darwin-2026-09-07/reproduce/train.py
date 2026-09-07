# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Declared five actual-HTTP training fixtures; no performance claim."""
import hashlib,json,os,shutil,subprocess,sys,time
from pathlib import Path
from wire_arrow_v2 import decode_run
root=Path(__file__).resolve().parent
import argparse
p=argparse.ArgumentParser();p.add_argument('--experiment',type=Path,required=True);a=p.parse_args()
out=a.experiment.resolve()
plan=json.loads((out/'plan.json').read_text())
raw=out/'raw';raw.mkdir(exist_ok=False)
training=out/'training';training.mkdir(exist_ok=False)
provenance=out/'generate-provenance.json'
binary=out/'target-generate/aarch64-apple-darwin/release/ifc-lite-server'
rows=[]
for fixture in plan['training']:
 label=fixture['label'];dest=training/label
 assert shutil.disk_usage(out).free>40*1024**3,'Reserve gate: <40GiB free'
 env=os.environ.copy();env['LLVM_PROFILE_FILE']=str(raw/(label+'-%p-%c.profraw'))
 command=[sys.executable,str(root/'run.py'),'--binary',str(binary),'--provenance',str(provenance),'--fixture',fixture['path'],'--out',str(dest),'--timeout','600','--defer-offline']
 print('START',label,flush=True)
 completed=subprocess.run(command,env=env)
 result=json.loads((dest/'result.json').read_text())
 assert completed.returncode==0 and result['transportSuccess'],result
 assert result['fixtureSha256']==fixture['publicSha256']
 logs='\n'.join(p.read_text(errors='replace') for p in dest.glob('*.log'))
 assert 'LLVM Profile Error' not in logs and 'LLVM Profile Warning' not in logs
 decode_run(dest,False);decode_run(dest/'cache-replay',None)
 cold=json.loads((dest/'semantic-v2.json').read_text());cached=json.loads((dest/'cache-replay/semantic-v2.json').read_text())
 assert cold==cached,'Exact cache semantic gate failed: '+label
 profiles=[{'file':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in raw.glob(label+'-*.profraw')]
 assert profiles and all(p['bytes']>0 for p in profiles)
 rows.append({'label':label,'transportSuccess':True,'exactCacheSemanticMatch':True,'profiles':profiles,'instrumentationEnvironment':result['instrumentationEnvironment']})
 (training/'qualification.json').write_text(json.dumps({'sourceCommit':plan['sourceCommit'],'profileKind':plan['profileKind'],'rows':rows,'complete':len(rows)==5},indent=2)+'\n')
 print('DONE',label,flush=True)
