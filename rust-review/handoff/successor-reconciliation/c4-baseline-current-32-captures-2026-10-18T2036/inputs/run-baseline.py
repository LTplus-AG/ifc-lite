"""Missing baseline61 ordinary counterparts only; retained V5/V18 adapters."""
from pathlib import Path
import os,json,hashlib,subprocess,shutil,time,traceback,resource,signal,stat
S=Path.cwd();T=Path(os.environ['CARGO_TARGET_DIR']);I=Path('/home/louistrue/build-workers/worker-state/c4-0-baseline61-counterparts-inputs-v2');O=T/'results';B=Path('/home/louistrue/build-workers/worker-state/checkouts/c4-0-baseline61-native-capture-v2');H=Path('/home/louistrue/build-workers/worker-state/c4-5-native-combined-inputs-v1/helpers');PKG=S/'packages/wasm/pkg'
PRODUCER=Path('/home/louistrue/build-workers/worker-state/checkouts/fc3635ae78665e95ea72328b88fc7b28ead148d2');Q=Path('/home/louistrue/build-workers/worker-state/c4-0-baseline61-regular-fixtures-v2');fixture_owner=None
BASE='61f9cb64803b37270fcc0603d97f5f47808212bf';TREE='6c3b87a4fe38cbf7170deca3d39ca3885b630e7c'
R={'scope':'32 missing baseline61 ordinary native/serial/columns/once captures; compare only same-route existing fc captures; no observed/performance/acceptance','commands':[],'cells':[],'comparisons':[],'primaryError':None,'finallyErrors':[],'collectionComplete':False,'startedAt':time.time(),'outputLimits':{'perFileBytes':512*2**20,'aggregateBytes':8*2**30}}
F=json.loads((I/'sealed-fixture-manifest.json').read_text())['fixtures'];heads=json.loads((I/'head-ordinary.json').read_text());tools=[];immutable=[];native_source=None;active_cell=None
assert os.environ.get('IFC_WORKER_ACTIVE_STATE');O.mkdir(parents=True,exist_ok=False);(O/'cases').mkdir();(O/'comparisons').mkdir()
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def save():(O/'report.json').write_text(json.dumps(R,indent=2)+'\n')
def git(root,*args):return subprocess.check_output(['git',*args],cwd=root,text=True).strip()
def identity(root):return {'head':git(root,'rev-parse','HEAD'),'tree':git(root,'rev-parse','HEAD^{tree}'),'status':git(root,'status','--porcelain')}
def patched_identity(root):return {'head':git(root,'rev-parse','HEAD'),'indexTree':git(root,'write-tree'),'diffSha256':hashlib.sha256(subprocess.check_output(['git','diff','--cached','--binary'],cwd=root)).hexdigest(),'unstaged':git(root,'diff','--name-only'),'untracked':git(root,'ls-files','--others','--exclude-standard')}
def pins(paths):return {str(p):{'sha256':sha(p),'bytes':p.stat().st_size,'realpath':str(p.resolve())} for p in paths}
def inputs():
 m=json.loads((I/'INPUTS.json').read_text())
 for n,r in m.items():
  p=I/n;assert not p.is_symlink() and p.stat().st_size==r['bytes'] and sha(p)==r['sha256'],str(p)
 return {'files':len(m),'manifestSha256':sha(I/'INPUTS.json')}
def baseline_fixture_links():
 return {r['path']:{'link':os.readlink(S/'tests/models'/r['path']),'inode':(S/'tests/models'/r['path']).lstat().st_ino,'uid':(S/'tests/models'/r['path']).lstat().st_uid} for r in json.loads((S/'tests/models/manifest.json').read_text())['files']}
def fixture_census(root):
 assert root.is_dir() and not root.is_symlink() and root.resolve()==root and root.stat().st_uid==os.getuid(),'owned regular fixture root required'
 m=json.loads((S/'tests/models/manifest.json').read_text())['files'];assert len(m)==182
 rows={}
 for r in m:
  relative=Path(r['path']);assert not relative.is_absolute() and '..' not in relative.parts and str(relative) not in rows
  p=root
  for index,part in enumerate(relative.parts):
   p=p/part;st=p.lstat();assert st.st_uid==os.getuid() and not stat.S_ISLNK(st.st_mode),str(p)
   assert stat.S_ISREG(st.st_mode) if index==len(relative.parts)-1 else stat.S_ISDIR(st.st_mode),str(p)
  assert st.st_size==r['size'] and sha(p)==r['sha256'],str(p)
  rows[str(relative)]={'bytes':st.st_size,'sha256':r['sha256']}
 return {'count':182,'manifestSha256':sha(S/'tests/models/manifest.json'),'files':rows,'allSizeShaMatch':True}
def fixtures():
 assert fixture_owner is not None and (Q.stat().st_dev,Q.stat().st_ino,Q.stat().st_uid)==fixture_owner,'private fixture ownership changed'
 return {'root':str(Q),'ownership':list(fixture_owner),**fixture_census(Q)}
def seed_fixtures():
 global fixture_owner
 assert not Q.exists() and not Q.is_symlink(),'fresh fixture root required'
 assert sha(PRODUCER/'tests/models/manifest.json')==sha(S/'tests/models/manifest.json'),'producer182 must match baseline manifest'
 R['producerFixturesBefore']=fixture_census(PRODUCER/'tests/models');R['fixtureSeedStorageBefore']=storage();save()
 Q.mkdir(mode=0o700);st=Q.stat();fixture_owner=(st.st_dev,st.st_ino,st.st_uid)
 for name,row in R['producerFixturesBefore']['files'].items():
  src=PRODUCER/'tests/models'/name;dest=Q/name;dest.parent.mkdir(parents=True,exist_ok=True)
  with src.open('rb') as source,dest.open('xb') as output:
   assert stat.S_ISREG(os.fstat(source.fileno()).st_mode) and os.fstat(source.fileno()).st_uid==os.getuid()
   shutil.copyfileobj(source,output)
  assert not dest.is_symlink() and dest.stat().st_uid==os.getuid() and dest.stat().st_size==row['bytes'] and sha(dest)==row['sha256']
 R['copiedFixtures']=fixtures();R['producerFixturesAfterCopy']=fixture_census(PRODUCER/'tests/models')
 assert R['producerFixturesBefore']==R['producerFixturesAfterCopy'];assert R['copiedFixtures']['files']==R['producerFixturesBefore']['files'];R['fixtureSeedStorageAfter']=storage();save()
def storage():
 rows=[]
 for p in [S,PRODUCER,Q,T,O,I,B,T/'native-plain',Path(os.environ.get('CARGO_HOME',str(Path.home()/'.cargo'))),Path(os.environ['TMPDIR'])]:
  while not p.exists():p=p.parent
  st=os.statvfs(p);v={'path':str(p),'freeBytes':st.f_bavail*st.f_frsize,'freeInodes':st.f_favail};rows.append(v);assert v['freeBytes']>60*2**30 and v['freeInodes']>1000000,v
 total=sum(p.stat().st_size for p in O.rglob('*') if p.is_file());assert total<=R['outputLimits']['aggregateBytes'];return {'volumes':rows,'outputBytes':total}
def guard(name):
 assert identity(S)==R['sourceBefore'];assert baseline_fixture_links()==R['baselineFixtureLinksBefore'];assert identity(PRODUCER)==R['producerSourceBefore'];assert fixture_census(PRODUCER/'tests/models')==R['producerFixturesBefore'];assert pins(tools)==R['toolsBefore'];assert pins(immutable)==R['immutableBefore'];assert inputs()==R['inputsBefore']
 if native_source is not None:assert patched_identity(B)==native_source,'capture helper source changed'
 R.setdefault('guards',[]).append({'name':name,'storage':storage(),'fixtures':fixtures()});save()
def limits():resource.setrlimit(resource.RLIMIT_FSIZE,(512*2**20,512*2**20))
def run(name,argv,cwd=S,extra=None,allow_difference=False,timeout=180):
 guard(name);row={'name':name,'argv':argv,'cwd':str(cwd),'startedAt':time.time()};R['commands'].append(row);save();print('START',name,flush=True)
 log=O/(name+'.log')
 with log.open('xb') as f:p=subprocess.run(argv,cwd=cwd,env=os.environ|{'CARGO_NET_OFFLINE':'true','PYTHONDONTWRITEBYTECODE':'1','NODE_OPTIONS':'--max-old-space-size=6144'}|(extra or {}),stdout=f,stderr=subprocess.STDOUT,timeout=timeout,preexec_fn=limits)
 row.update(exitCode=p.returncode,logSha256=sha(log),finishedAt=time.time());save();print('END',name,p.returncode,flush=True)
 assert p.returncode==0 or allow_difference,name+' failed';return row

def interrupted(sig,frame):raise KeyboardInterrupt('signal '+str(sig))
for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,interrupted)
for f in F:
 for route in ['serial','columns','once','native']:R['cells'].append({'fixture':f['id'],'route':route,'variant':'plain','key':f['id']+'--'+route+'--plain','state':'UNRUN'})
lookup={r['key']:r for r in R['cells']}
try:
 R['sourceBefore']=identity(S);assert R['sourceBefore']=={'head':BASE,'tree':TREE,'status':''}
 R['producerSourceBefore']=identity(PRODUCER);assert R['producerSourceBefore']=={'head':'fc3635ae78665e95ea72328b88fc7b28ead148d2','tree':'4b3c4fd5a98faec9f74c70a2b2d9e2f4d03f0fe5','status':''}
 R['baselineFixtureLinksBefore']=baseline_fixture_links();R['inputsBefore']=inputs();R['storageBefore']=storage();seed_fixtures();R['fixturesBefore']=fixtures();tools=[Path(shutil.which(n)) for n in ['cargo','rustc','node','git','python3']];R['toolsBefore']=pins(tools)
 for n in ['cargo','rustc']:tools.append(Path(subprocess.check_output(['rustup','which',n],cwd=S,text=True).strip()))
 R['toolsBefore']=pins(tools)
 immutable=[*[PKG/n for n in ['ifc-lite.js','ifc-lite_bg.wasm','ifc-lite.d.ts']],S/'packages/wasm/package.json',S/'package.json',S/'Cargo.lock',S/'rust-toolchain.toml',*[H/n for n in ['prepass-routing.js','shard-style-merge.js','style-finishes.js','package.json']],*[Path(r['receipt']) for r in heads.values()]]
 R['immutableBefore']=pins(immutable)
 for name,expected in {'ifc-lite_bg.wasm':'cb15170c3177f6016df72572653d096a8def0100f08d71407760358992ec2ffa','ifc-lite.js':'04c85b1449d8fee992f25f0685170ff03fb4360726fa4e4d2a2d180314c169c0','ifc-lite.d.ts':'e2bf5dee93a6277acee5a814f0bab346ec3c270cbc01bc8a1d0ca75d1c2b65cb'}.items():assert sha(PKG/name)==expected
 assert json.loads((S/'packages/wasm/package.json').read_text())['type']=='module'
 for r in heads.values():assert sha(Path(r['receipt']))==r['sha256']
 for row in json.loads((I/'helper-reuse.json').read_text()):assert sha(S/row['sourcePath'])==row['sha256'] and sha(H/Path(row['producerJavaScript']).name)==row['javaScriptSha256']
 R['fixtureContext']={'root':str(Q),'baselineManifest':str(S/'tests/models/manifest.json'),'producer':str(PRODUCER/'tests/models'),'captureFixtures':'separate sealed8 fixtures, unchanged from V21/V20; private182 census contextual guard only'}
 R['contextLimits']='Baseline WASM equals retained actual source-build61 producer; three helper TS sources match61/121/fc. Current PC capture compiler/tool bytes pinned; historic native full-byte compiler/linker closure UNKNOWN. No performance/ABI/acceptance claim.'
 base_inputs=[*tools,*immutable,*[p for p in I.rglob('*') if p.is_file()]]
 for fixture in F:
  for route in ['serial','columns','once']:
   cell=lookup[fixture['id']+'--'+route+'--plain'];active_cell=cell
   plan={'schema':'c4-0-case-v1','state':'BOUND_REVIEWED','revision':'baseline61','route':route,'source':{'commit':BASE,'tree':TREE},'disabledSite':False,'wasmPath':str(PKG/'ifc-lite_bg.wasm'),'wasmSha256':sha(PKG/'ifc-lite_bg.wasm'),'gluePath':str(PKG/'ifc-lite.js'),'glueSha256':sha(PKG/'ifc-lite.js'),'fixturePath':str(I/'fixtures'/(fixture['id']+'.ifc')),'fixtureSha256':fixture['sha256'],'fixtureBytes':fixture['bytes'],'contract':fixture.get('contractByConsumer',{}).get('publicWasm',fixture['contract']),'helpersRoot':str(H),'helperHashes':{n:sha(H/n) for n in ['prepass-routing.js','shard-style-merge.js','style-finishes.js']},'observation':{'enabled':False,'token':'BASE61_MATRIX_'+cell['key']}}
   plan['inputs']=[{'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p)} for p in dict.fromkeys(base_inputs)]
   path=O/'cases'/(cell['key']+'.json');pp=O/'cases'/(cell['key']+'.plan.json');pp.write_text(json.dumps(plan,indent=2)+'\n');cell.update(state='STARTED',plan=str(pp),planSha256=sha(pp),receipt=str(path));save()
   run(cell['key'],['node',str(I/'adapter/capture-wasm.mjs'),str(pp),str(path)])
   payload=json.loads(path.read_text());assert payload['status']=='ok';cell.update(state='CAPTURED',sha256=sha(path),jobs=len(payload['raw']['jobs']),meshes=len(payload['raw']['meshes']),triangles=sum(b['collection']['getters']['totalTriangles'] for b in payload['raw']['batches']),callbackEvents=len(payload['raw']['events']));save();active_cell=None
 # Only missing baseline native serializer/test support; no production instrumentation.
 assert not B.exists(),'new detached native support context required'
 run('native-source',['git','worktree','add','--detach',str(B),BASE])
 run('native-capture-helper',['git','apply','--index',str(I/'baseline61-native-capture-only.patch')],cwd=B)
 native_source=patched_identity(B);R['nativeSourceProvenance']=native_source;save()
 run('native-support-build',['cargo','test','-p','ifc-lite-processing','--lib','--profile','server-release','--no-run','--message-format=json'],cwd=B,extra={'CARGO_TARGET_DIR':str(T/'native-plain')},timeout=1800)
 found=[]
 for line in (O/'native-support-build.log').read_text().splitlines():
  try:obj=json.loads(line)
  except json.JSONDecodeError:continue
  if obj.get('reason')=='compiler-artifact' and obj.get('target',{}).get('name')=='ifc_lite_processing' and obj.get('profile',{}).get('test') and obj.get('executable'):found.append(obj['executable'])
 assert len(set(found))==1,'exact native support executable required';binary=Path(found[0]);R['nativeBinary']=pins([binary]);immutable.append(binary);R['immutableBefore']=pins(immutable);save()
 for fixture in F:
  cell=lookup[fixture['id']+'--native--plain'];active_cell=cell
  plan={'schema':'c4-0-native-case-v1','state':'BOUND_REVIEWED','source':{'commit':BASE,'tree':TREE},'testBinary':str(binary),'fixturePath':str(I/'fixtures'/(fixture['id']+'.ifc')),'fixtureSha256':fixture['sha256'],'contract':fixture.get('contractByConsumer',{}).get('native',fixture['contract']),'observationEnabled':False,'token':'BASE61_MATRIX_'+cell['key'],'timeoutSeconds':90}
  plan['inputs']=[{'path':str(p),'bytes':p.stat().st_size,'sha256':sha(p)} for p in dict.fromkeys([Path(os.path.realpath(shutil.which('python3'))),*base_inputs,binary])]
  path=O/'cases'/(cell['key']+'.json');pp=O/'cases'/(cell['key']+'.plan.json');pp.write_text(json.dumps(plan,indent=2)+'\n');cell.update(state='STARTED',plan=str(pp),planSha256=sha(pp),receipt=str(path));save()
  run(cell['key'],['python3',str(I/'adapter/native-adapter.py'),str(pp),str(path)])
  run(cell['key']+'-validate',['node',str(I/'compare-saved.mjs'),'validate-native',str(path)])
  payload=json.loads(path.read_text());stdout=Path(str(path)+'.stdout').read_text();assert '1 passed; 0 failed; 0 ignored;' in stdout,'actual single capture test must pass';cell.update(state='CAPTURED',sha256=sha(path),meshes=len(payload['raw']['meshes']),triangles=sum(m['indices']['length']//3 for m in payload['raw']['meshes']),observationEvents=len(payload['observations']));save();active_cell=None
 R['collectionComplete']=True;save()
 for cell in R['cells']:
  head=heads[cell['key']];name='compare-'+cell['key'];row=run(name,['node',str(I/'adapter/compare.mjs'),cell['receipt'],head['receipt'],str(I/'EXPECTED_DIFF.json'),'cross-revision'],allow_difference=True,timeout=120)
  result=json.loads((O/(name+'.log')).read_text());R['comparisons'].append({'key':cell['key'],'fixture':cell['fixture'],'route':cell['route'],'baseReceipt':cell['receipt'],'headReceipt':head['receipt'],'baseSha256':cell['sha256'],'headSha256':head['sha256'],'exitCode':row['exitCode'],'result':result.get('result'),'unknownCount':len(result.get('unknown',[])),'expectedCount':len(result.get('expected',[])),'stale':result.get('stale',[]),'error':result.get('error'),'rawReport':str(O/(name+'.log'))});save()
except BaseException as error:
 R['primaryError']=repr(error);R['traceback']=traceback.format_exc()
 if active_cell is not None:active_cell.update(state='FAILED',error=repr(error));R['failedCell']=active_cell['key']
finally:
 for name,action in [('sourceAfter',lambda:identity(S)),('baselineFixtureLinksAfter',baseline_fixture_links),('producerSourceAfter',lambda:identity(PRODUCER)),('producerFixturesAfter',lambda:fixture_census(PRODUCER/'tests/models')),('fixturesAfter',fixtures),('toolsAfter',lambda:pins(tools)),('immutableAfter',lambda:pins(immutable)),('inputsAfter',inputs),('storageAfter',storage),('nativeSourceAfter',lambda:patched_identity(B) if native_source else None)]:
  try:R[name]=action()
  except BaseException as error:R['finallyErrors'].append({'check':name,'error':repr(error)})
 for a,b in [('sourceBefore','sourceAfter'),('baselineFixtureLinksBefore','baselineFixtureLinksAfter'),('producerSourceBefore','producerSourceAfter'),('producerFixturesBefore','producerFixturesAfter'),('fixturesBefore','fixturesAfter'),('toolsBefore','toolsAfter'),('immutableBefore','immutableAfter'),('inputsBefore','inputsAfter'),('nativeSourceProvenance','nativeSourceAfter')]:
  if a in R and R.get(a)!=R.get(b):R['finallyErrors'].append({'check':a+'=='+b,'error':'changed or missing'})
 R['complete']=R['collectionComplete'] and not R['primaryError'] and not R['finallyErrors'] and not any(x['exitCode'] for x in R['comparisons']);R['finishedAt']=time.time();save();print(json.dumps({'report':str(O/'report.json'),'collectionComplete':R['collectionComplete'],'complete':R['complete'],'failedCell':R.get('failedCell'),'primaryError':R['primaryError'],'finallyErrors':R['finallyErrors']}),flush=True)
raise SystemExit(0 if R['complete'] else 1)
