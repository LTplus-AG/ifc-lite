import json,subprocess,shutil,os,tempfile,sqlite3,hashlib
from pathlib import Path
state=Path('/home/louistrue/build-workers/worker-state');root=Path('/mnt/c/Users/louistrue/ifc-private/d47-public02-wasm-baseline-v1');s=root/'source';cache=root.parent/'d47-raw-wasm-consumer-v1'
g=subprocess.run(['/home/louistrue/build-workers/worker-python','/home/louistrue/build-workers/setup/capacity-guard.py'],capture_output=True,text=True);assert g.returncode==0,(g.stdout,g.stderr)
f,p=tempfile.mkstemp(prefix='d47-base-preflight-',dir=state);os.write(f,b'd47');os.fsync(f);os.close(f);os.unlink(p)
c=sqlite3.connect('file:'+str(state/'queue.sqlite')+'?mode=ro',uri=True);jobs=c.execute('SELECT * FROM jobs').fetchall();c.close()
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();producer=json.loads((cache/'evidence/official-producer.json').read_text())
for pin in producer['toolInputs'].values():assert sha(pin.get('ownPath',pin.get('path')))==pin['sha256']
assert subprocess.check_output(['git','-C',str(s),'rev-parse','HEAD'],text=True).strip()=='02b8e1981158559fd4ec9b385d2d80729079a633'
assert not subprocess.check_output(['git','-C',str(s),'status','--porcelain'],text=True).strip()
assert shutil.disk_usage(root).free>60*1024**3 and os.statvfs(root).f_favail>100000
assert not (root/'target').exists()
print(json.dumps({'guardExit':g.returncode,'guardStdout':g.stdout,'guardStderr':g.stderr,'stateWritable':True,'stateFreeBytes':shutil.disk_usage(state).free,'payloadFreeBytes':shutil.disk_usage(root).free,'payloadInodes':os.statvfs(root).f_favail,'jobs':jobs,'sourceHead':'02b8e1981158559fd4ec9b385d2d80729079a633','sourceTree':subprocess.check_output(['git','-C',str(s),'rev-parse','HEAD^{tree}'],text=True).strip(),'sourceClean':True,'toolsVerified':producer['toolInputs'],'driverSha256':sha('/home/louistrue/build-workers/incoming/d47-public02-wasm-baseline-v1/qualify.py')}))
