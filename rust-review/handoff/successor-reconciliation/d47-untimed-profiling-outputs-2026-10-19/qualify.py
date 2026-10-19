"""Exactly30 fresh-process witness-mode calls; no build, test gate or measured invocation."""
import os,json,hashlib,shutil,subprocess,sys,traceback,selectors,time,tarfile
from pathlib import Path
from validator import validate
P=Path(__file__).parent;R=Path('/mnt/c/Users/louistrue/ifc-private/d47-untimed-witness-v1');A=R.parent/'d47-perf-prerequisites-v2';O=R/'evidence';W=R/'witnesses';STATE=Path('/home/louistrue/build-workers/worker-state')
SOURCES={'base':R.parent/'d47-public02-wasm-baseline-v1/source','raw':R.parent/'d47-raw-native-v1/source'}
HEADS={'base':'02b8e1981158559fd4ec9b385d2d80729079a633','raw':'7c8cebfca7652cd0a8f4dab97cbc7e3b66c913db'}
READY=json.loads((P/'ready-artifacts.json').read_text());CALLS=json.loads((P/'UNTIMED-WITNESS-INVOCATIONS.json').read_text())['calls'];RESULTS=[];COMPARISONS=[]
ENV=os.environ|{'RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PIP_NO_INDEX':'1','PIP_NO_CACHE_DIR':'1','CARGO_NET_OFFLINE':'true','CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0'}
for k in ['PYTHONPATH','PYTHONHOME','RUSTFLAGS','RUSTDOCFLAGS','CARGO_ENCODED_RUSTFLAGS','IFC_LITE_REPIN_GOLDEN']:ENV.pop(k,None)
for k in ['TMPDIR','TMP','TEMP']:ENV[k]=str(R/'tmp')
for k in ['XDG_CACHE_HOME','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','NODE_COMPILE_CACHE']:ENV[k]=str(R/k.lower())
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,indent=2)+'\n')
def git(s,*a):return subprocess.check_output(['git','-C',str(s),*a],text=True).strip()
def guard(full=False):
 for side,s in SOURCES.items():
  assert git(s,'rev-parse','HEAD')==HEADS[side],side
  if full:assert not git(s,'status','--porcelain'),side
 for side in ['base','raw']:
  for f,pin in json.loads((P/f'{side}-artifacts.json').read_text())['artifacts'].items():assert sha(f)==pin['sha256'] and Path(f).stat().st_size==pin['size'],f
 for n,pin in json.loads((P/'input-pins.json').read_text()).items():assert sha(A/'inputs'/n)==pin['sha256'] and (A/'inputs'/n).stat().st_size==pin['size'],n
 assert sha('/home/louistrue/.local/share/uv/python/cpython-3.12.14-linux-x86_64-gnu/bin/python3.12')=='f7c6210eb40fadcd3c2889dddd24a15fc2c9f926aec5a03bf9da66e12d581526'
 assert sha('/home/louistrue/build-workers/incoming/d47-perf-prerequisites-v3/entity_data_probe.py')==READY['artifacts']['entity_data_probe.py']['sha256']
 free=shutil.disk_usage(R).free;assert free>60*1024**3 and os.statvfs(R).f_favail>100000
 return {'sources':{side:{'head':HEADS[side],'tree':git(s,'rev-parse','HEAD^{tree}'),'clean':True if full else 'initial/final full check; head rechecked per call'} for side,s in SOURCES.items()},'payloadFreeBytes':free,'payloadInodes':os.statvfs(R).f_favail,'linuxWorkerStateFreeBytes':shutil.disk_usage(STATE).free,'artifactsInputsPinned':True}
def run(call):
 side=call['side'];api=call['api'];name=call['input'];output=W/(name+'.'+api+'.'+side+'.json');assert not output.exists()
 args=[str(A/side/'target/profiling/d47-public-probe'),'witness',api,str(A/'inputs'/name),str(output)]
 if api=='entity_data':args=[str(A/side/'venv/bin/python'),'/home/louistrue/build-workers/incoming/d47-perf-prerequisites-v3/entity_data_probe.py','witness',str(A/side/'target/profiling/libd47_public_probe.so'),str(A/'inputs'/name),str(output)]
 before=guard();label=name+'.'+api+'.'+side;print('START',label,flush=True);log=O/(label+'.log');used=0;began=time.monotonic()
 with log.open('xb') as out:
  q=subprocess.Popen(args,cwd=R,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);sel=selectors.DefaultSelector();sel.register(q.stdout,selectors.EVENT_READ)
  try:
   while sel.get_map():
    assert time.monotonic()-began<600,('command timeout',label)
    for key,_ in sel.select(1):
     b=os.read(key.fd,65536)
     if not b:sel.unregister(key.fileobj);continue
     used+=len(b);out.write(b);out.flush();assert used<=64*1024**2,('log limit',label)
   code=q.wait(timeout=30)
  except BaseException:q.terminate();raise
  finally:sel.close()
  row={'ordinal':len(RESULTS)+1,'input':name,'api':api,'side':side,'mode':'witness','argv':args,'exitCode':code,'logSha256':sha(log),'before':before,'after':guard()}
  if output.exists():row['output']={'path':str(output),'size':output.stat().st_size,'sha256':sha(output)}
  RESULTS.append(row);save('calls.json',RESULTS);print('END',label,code,flush=True);assert code==0,(label,code,str(log));assert output.exists() and output.stat().st_size<3*1024**3
 return output
try:
 assert os.environ.get('IFC_WORKER_ACTIVE_STATE');O.mkdir();W.mkdir();save('source-before.json',guard(True));save('call-environment.json',ENV)
 prior=json.loads((STATE/'jobs/d873c278-a9a4-42a8-8a16-7497aa765494/receipt.json').read_text());assert prior['state']=='completed' and prior['exitCode']==0 and prior['sourceUnchanged']
 assert len(CALLS)==30 and all('witness' in c['argv'] for c in CALLS)
 for name in ['shared-set.ifc','02-opposed-products.ifc','AC20-FZK-Haus.ifc']:
  paths={}
  for call in [c for c in CALLS if c['input']==name]:paths[call['api'],call['side']]=run(call)
  docs={k:json.loads(f.read_text()) for k,f in paths.items()}
  comparison=validate(name,docs);COMPARISONS.append(comparison);save(name+'.comparison.json',comparison);save('comparisons.json',COMPARISONS);print('SEMANTICS_PASS',name,flush=True);del docs
 save('source-after.json',guard(True));save('completion.json',{'callCount':len(RESULTS),'exit0':sum(r['exitCode']==0 for r in RESULTS),'semanticInputsPassed':len(COMPARISONS),'mode':'witness-only','measuredInvocations':0,'builds':0,'PopExecution':False,'performanceVerdict':None,'streamWitness':'collects rows; not measure-mode drop-each-row memory/time scope','canonicalComparisonScope':'see comparison summaries; no alternate IFC parser or budget math'})
 print('D47_UNTIMED_WITNESSES_COMPLETE',flush=True)
except BaseException:
 if O.exists():save('failure.json',{'traceback':traceback.format_exc(),'completedCalls':len(RESULTS),'completedInputComparisons':len(COMPARISONS),'semanticFailureStopsFurtherCalls':True})
 traceback.print_exc();sys.exit(1)
finally:
 if O.exists():
  try:save('source-finally.json',guard(True))
  except BaseException:save('source-finally-error.json',{'traceback':traceback.format_exc()})

  try:
   archive=R/'witnesses.tar.gz'
   with tarfile.open(archive,'w:gz',compresslevel=1) as tar:
    for f in sorted(W.glob('*.json')):tar.add(f,arcname=f.name)
   save('witness-archive.json',{'path':str(archive),'sha256':sha(archive),'size':archive.stat().st_size,'members':{f.name:{'sha256':sha(f),'size':f.stat().st_size} for f in sorted(W.glob('*.json'))},'originalPrivateOutputsRetained':True})
  except BaseException:save('archive-error.json',{'traceback':traceback.format_exc()})
