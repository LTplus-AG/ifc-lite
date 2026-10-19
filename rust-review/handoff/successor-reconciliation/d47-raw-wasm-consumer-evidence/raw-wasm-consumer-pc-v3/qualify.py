"""Finite raw7c8 official WASM/public consumer arm; no native/Python/perf gates."""
import hashlib,json,os,shutil,subprocess,sys,time,traceback,tomllib,tarfile,selectors
from pathlib import Path
P=Path(__file__).resolve().parent
S=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-native-v1/source')
R=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-wasm-consumer-v1');O=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-wasm-consumer-v3/evidence');TARGET=R/'target';MANIFEST=R/'manifest-target';CH=R/'cargo-home'
STATE=Path('/home/louistrue/build-workers/worker-state');H=Path('/home/louistrue')
HEAD='7c8cebfca7652cd0a8f4dab97cbc7e3b66c913db';TREE='2d50a075e3eb8d460069b6462b647284ee4e216c';BASE='02b8e1981158559fd4ec9b385d2d80729079a633'
CHECK=json.loads((P/'checkpoint.json').read_text());INPUTS={};RESULTS=[]
NODE=H/'.nvm/versions/node/v24.21.0/bin';TC=H/'.rustup/toolchains/nightly-2025-11-15-x86_64-unknown-linux-gnu';BIN=R/'tools'
E=os.environ|{'CARGO_HOME':str(CH),'CARGO_TARGET_DIR':str(TARGET),'CARGO_NET_OFFLINE':'true','CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_BUILD_JOBS':'2','RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2','RUSTUP_HOME':str(H/'.rustup'),'RUSTUP_TOOLCHAIN':'nightly-2025-11-15','RUSTUP_AUTO_INSTALL':'0','BUILD_THREADED':'0','BUILD_WIDE':'0','CI':'true','IFC_STRICT_WASM':'1','IFC_LITE_REQUIRE_FIXTURES':'1','PYTHONDONTWRITEBYTECODE':'1','COREPACK_ENABLE_NETWORK':'0','COREPACK_ENABLE_DOWNLOAD_PROMPT':'0','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD':'1','NODE_OPTIONS':'--max-old-space-size=3072','PATH':str(BIN)+':'+str(H/'.cargo/bin')+':'+str(NODE)+':/usr/local/bin:/usr/bin:/bin'}
for k in ['RUSTFLAGS','RUSTDOCFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_UNSTABLE_BUILD_STD','CARGO_BUILD_TARGET','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','IFC_LITE_REPIN_GOLDEN','DEBUG_GEOMETRY']:E.pop(k,None)
for k,n in {'TMPDIR':'tmp','TMP':'tmp','TEMP':'tmp','XDG_CACHE_HOME':'xdg/cache','XDG_DATA_HOME':'xdg/data','XDG_CONFIG_HOME':'xdg/config','XDG_STATE_HOME':'xdg/state','COREPACK_HOME':'corepack','npm_config_cache':'npm-cache','PNPM_HOME':'pnpm-home','NODE_COMPILE_CACHE':'node-cache','TURBO_CACHE_DIR':'turbo-cache'}.items():E[k]=str(R/n)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,indent=2)+'\n')
def git(*a):return subprocess.check_output(['git','-C',str(S),*a],text=True).strip()
def guard(dts=False):
 assert git('rev-parse','HEAD')==HEAD and git('rev-parse','HEAD^{tree}')==TREE
 status=git('status','--porcelain');assert not status or dts and all(x[3:]=='packages/wasm/pkg/ifc-lite.d.ts' for x in status.splitlines()),status
 for n,v in INPUTS.items():
  if dts and n=='packages/wasm/pkg/ifc-lite.d.ts':continue
  assert sha(S/n)==v,n
 for n,v in CHECK['files'].items():assert sha(S/n)==v['sha256'],n
 du=shutil.disk_usage(R);ino=os.statvfs(R).f_favail;assert du.free>60*1024**3 and ino>100000,(du.free,ino)
 return {'head':HEAD,'tree':TREE,'parent':BASE,'trackedStatus':status,'inputHashes':INPUTS,'payloadFreeBytes':du.free,'payloadFreeInodes':ino,'linuxWorkerStateFreeBytes':shutil.disk_usage(STATE).free}
def phase(name,args,timeout=1800,env=None,dts=False):
 before=guard();print('START',name,flush=True);log=O/(name+'.log');used=0;start=time.monotonic()
 with log.open('xb') as out:
  proc=subprocess.Popen(args,cwd=S,env=E|(env or {}),stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
  sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ)
  try:
   while sel.get_map():
    assert time.monotonic()-start<timeout,('timeout',name)
    for key,_ in sel.select(1):
     b=os.read(key.fd,65536)
     if not b:sel.unregister(key.fileobj);continue
     used+=len(b);out.write(b);out.flush();assert used<=256*1024**2,('phase output cap',name)
   code=proc.wait(timeout=30)
  except BaseException:
   proc.terminate();raise
  finally:sel.close()
 after=guard(dts);row={'name':name,'argv':args,'envOverrides':env or {},'exitCode':code,'before':before,'after':after,'logSha256':sha(log),'logBytes':used};RESULTS.append(row);save('results.json',RESULTS);print('END',name,code,flush=True)
 assert code==0,(name,code,str(log));return log.read_text(errors='replace')
def fixture_guard(label):
 pins=json.loads((S/'tests/models/manifest.json').read_text())['files'];assert len(pins)==182;rows=[]
 for pin in pins:
  f=S/'tests/models'/pin['path'];a={'path':pin['path'],'size':f.stat().st_size,'sha256':sha(f)};assert a['size']==pin['size'] and a['sha256']==pin['sha256'],a;rows.append(a)
 save('fixtures-'+label+'.json',rows);guard();return rows
def copy_tree(src,dst):
 assert src.is_dir() and not dst.exists();files={}
 for f in src.rglob('*'):
  if f.is_file():files[str(f.relative_to(src))]={'sha256':sha(f),'size':f.stat().st_size}
 shutil.copytree(src,dst,symlinks=True)
 for n,pin in files.items():assert sha(dst/n)==pin['sha256'],n
 return {'source':str(src),'destination':str(dst),'files':files}
try:
 assert os.environ.get('IFC_WORKER_ACTIVE_STATE') and os.environ['CARGO_TARGET_DIR']==str(TARGET)
 O.mkdir();INPUTS.update(json.loads((R/'evidence/source-before.json').read_text())['inputHashes'])
 prior=json.loads((STATE/'jobs/d8b7a5b1-940a-480d-8bb8-31fd2c344b3b/receipt.json').read_text());assert prior['state']=='failed' and prior['exitCode']==1 and prior['sourceUnchanged']
 save('source-before.json',guard());before=fixture_guard('before')
 original=json.loads((R/'evidence/official-producer.json').read_text());generated=original['generated'];tools=original['toolInputs']
 for n,pin in generated.items():assert sha(S/n)==pin['sha256'],n
 for n,pin in tools.items():assert sha(pin.get('ownPath',pin.get('path')))==pin['sha256'],n
 save('retained-actual-gates.json',{'originalBuildJob':'8526c777-a74d-4321-a3ac-53c804871a27','secondJob':prior['id'],'secondTerminal':'FAILED1/sourceUnchanged','officialBuild':'PASS original job','committedDts':'PASS original; still matches source pin','rootWasmPackage':'21PASS/0FAIL/0SKIP original, zero cached tasks','rootContract':'212PASS/0FAIL/1 optional historical baseline comparison SKIP in second job','officialManifest':'mesh_output_matches_pinned_manifest_on_wasm32:1PASS/0FAIL/0IGNORE second job','harnessError':'unnamed-member Pset_Anon normative count3 joined-value pin wrongly checked per value','sourceMatchedProducer':original,'noReplayOfPassedGates':True})
 phase('corrected-witness-syntax',['node','--check',str(P/'wasm-public-budget.mjs')])
 witness=phase('public-property-boundary',['node',str(P/'wasm-public-budget.mjs'),str(S)],timeout=1200);rows=[json.loads(l) for l in witness.splitlines() if l.startswith('{')];assert rows[-1]['state']=='PASS' and rows[-1]['budgetCases']==13 and rows[-1]['allSevenClasses'];save('public-witness-result.json',rows[-1])
 for n,pin in generated.items():assert sha(S/n)==pin['sha256'],n
 after=fixture_guard('after');assert before==after;save('source-after.json',guard());save('completion.json',{'head':HEAD,'tree':TREE,'parent':BASE,'fixtures182BeforeAfterEqual':True,'officialBuild':True,'committedDtsEqual':True,'publicWitness':rows[-1],'allGeneratedUnchangedAfterTests':True,'nativePythonGatesRepeated':False,'perfPublication':'UNRUN/no claim','limits':['canonical prepass before first callback','persistent membership memory; not RSS neutral','no full adversarial or current-main final integration claim']});print('D47_RAW_WASM_COMPLETE',HEAD,flush=True)
except BaseException as exc:
 if O.exists():save('failure.json',{'type':type(exc).__name__,'message':str(exc),'traceback':traceback.format_exc(),'completedPhases':len(RESULTS)})
 traceback.print_exc();sys.exit(1)
finally:
 if O.exists():
  try:save('source-final.json',guard(True))
  except BaseException:save('source-final-error.json',{'traceback':traceback.format_exc()})
