"""Finite raw7c8 official WASM/public consumer arm; no native/Python/perf gates."""
import hashlib,json,os,shutil,subprocess,sys,time,traceback,tomllib,tarfile,selectors
from pathlib import Path
P=Path(__file__).resolve().parent
RAW=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-native-v1/source');S=Path('/mnt/c/Users/louistrue/ifc-private/d47-public02-wasm-baseline-v1/source')
CACHE=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-wasm-consumer-v1');R=S.parent;O=R/'evidence';TARGET=R/'target';CH=CACHE/'cargo-home'
STATE=Path('/home/louistrue/build-workers/worker-state');H=Path('/home/louistrue')
HEAD='02b8e1981158559fd4ec9b385d2d80729079a633';TREE=subprocess.check_output(['git','-C',str(S),'rev-parse','HEAD^{tree}'],text=True).strip();RAWHEAD='7c8cebfca7652cd0a8f4dab97cbc7e3b66c913db'
ORIGINAL=json.loads((CACHE/'evidence/official-producer.json').read_text());RAWINPUTS=ORIGINAL['source']['inputHashes'];INPUTS={};RESULTS=[]
NODE=H/'.nvm/versions/node/v24.21.0/bin';TC=H/'.rustup/toolchains/nightly-2025-11-15-x86_64-unknown-linux-gnu';BIN=CACHE/'tools'
E=os.environ|{'CARGO_HOME':str(CH),'CARGO_TARGET_DIR':str(TARGET),'CARGO_NET_OFFLINE':'true','CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_BUILD_JOBS':'4','RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2','RUSTUP_HOME':str(H/'.rustup'),'RUSTUP_TOOLCHAIN':'nightly-2025-11-15','RUSTUP_AUTO_INSTALL':'0','BUILD_THREADED':'0','BUILD_WIDE':'0','CI':'true','IFC_STRICT_WASM':'1','IFC_LITE_REQUIRE_FIXTURES':'1','PYTHONDONTWRITEBYTECODE':'1','COREPACK_ENABLE_NETWORK':'0','COREPACK_ENABLE_DOWNLOAD_PROMPT':'0','PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD':'1','NODE_OPTIONS':'--max-old-space-size=3072','PATH':str(BIN)+':'+str(H/'.cargo/bin')+':'+str(NODE)+':/usr/local/bin:/usr/bin:/bin'}
for k in ['RUSTFLAGS','RUSTDOCFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_UNSTABLE_BUILD_STD','CARGO_BUILD_TARGET','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','IFC_LITE_REPIN_GOLDEN','DEBUG_GEOMETRY']:E.pop(k,None)
for k,n in {'TMPDIR':'tmp','TMP':'tmp','TEMP':'tmp','XDG_CACHE_HOME':'xdg/cache','XDG_DATA_HOME':'xdg/data','XDG_CONFIG_HOME':'xdg/config','XDG_STATE_HOME':'xdg/state','COREPACK_HOME':'corepack','npm_config_cache':'npm-cache','PNPM_HOME':'pnpm-home','NODE_COMPILE_CACHE':'node-cache','TURBO_CACHE_DIR':'turbo-cache'}.items():E[k]=str((CACHE if k in ['COREPACK_HOME','XDG_CACHE_HOME','PNPM_HOME'] else R)/n)
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
 assert subprocess.check_output(['git','-C',str(RAW),'rev-parse','HEAD'],text=True).strip()==RAWHEAD
 assert not subprocess.check_output(['git','-C',str(RAW),'status','--porcelain'],text=True).strip()
 for n,v in RAWINPUTS.items():assert sha(RAW/n)==v,n
 for n,pin in ORIGINAL['generated'].items():assert sha(RAW/n)==pin['sha256'],n
 for n,v in INPUTS.items():
  if dts and n=='packages/wasm/pkg/ifc-lite.d.ts':continue
  assert sha(S/n)==v,n
 for n,pin in ORIGINAL['toolInputs'].items():assert sha(pin.get('ownPath',pin.get('path')))==pin['sha256'],n
 du=shutil.disk_usage(R);ino=os.statvfs(R).f_favail;assert du.free>60*1024**3 and ino>100000,(du.free,ino)
 return {'head':HEAD,'tree':TREE,'trackedStatus':status,'rawHead':RAWHEAD,'rawGeneratedUnchanged':True,'payloadFreeBytes':du.free,'payloadFreeInodes':ino,'linuxWorkerStateFreeBytes':shutil.disk_usage(STATE).free}
def phase(name,args,timeout=1800,env=None,dts=False,cwd=None):
 before=guard();print('START',name,flush=True);log=O/(name+'.log');used=0;start=time.monotonic()
 with log.open('xb') as out:
  proc=subprocess.Popen(args,cwd=cwd or S,env=E|(env or {}),stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
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
 pins=json.loads((RAW/'tests/models/manifest.json').read_text())['files'];assert len(pins)==182;rows=[]
 for pin in pins:
  f=RAW/'tests/models'/pin['path'];a={'path':pin['path'],'size':f.stat().st_size,'sha256':sha(f)};assert a['size']==pin['size'] and a['sha256']==pin['sha256'],a;rows.append(a)
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
 O.mkdir();assert not TARGET.exists();assert not (S/'packages/wasm/pkg/ifc-lite.js').exists()
 for k in ['TMPDIR','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','npm_config_cache','NODE_COMPILE_CACHE','TURBO_CACHE_DIR']:Path(E[k]).mkdir(parents=True,exist_ok=True)
 for n in RAWINPUTS:
  if (S/n).is_file():INPUTS[n]=sha(S/n)
 save('source-inputs.json',INPUTS);save('source-before.json',guard());before=fixture_guard('before')
 save('producer-inputs.json',{'baseHead':HEAD,'baseTree':TREE,'rawHead':RAWHEAD,'toolInputs':ORIGINAL['toolInputs'],'environment':E,'compilerJobs':4,'rawCompilerJobs':2,'comparison':'size/contract only; no timings','sourceBuildScriptEqual':sha(S/'scripts/build-wasm.sh')==ORIGINAL['officialScriptSha256']})
 phase('base-official-build',['bash','scripts/build-wasm.sh'],timeout=10800,dts=True)
 phase('base-committed-dts',['git','diff','--exit-code','HEAD','--','packages/wasm/pkg/ifc-lite.d.ts'])
 generated={str(f.relative_to(S)):{'sha256':sha(f),'size':f.stat().st_size} for f in (S/'packages/wasm/pkg').iterdir() if f.is_file()}
 save('base-generated.json',generated)
 pin=generated['packages/wasm/pkg/ifc-lite_bg.wasm'];raw=ORIGINAL['generated']['packages/wasm/pkg/ifc-lite_bg.wasm']
 save('size-comparison.json',{'base':pin,'raw':raw,'deltaBytes':raw['size']-pin['size'],'deltaPercent':100*(raw['size']-pin['size'])/pin['size'],'warningThresholdKiB':1100,'warningRetained':True,'notLatencyOrMemoryVerdict':True})
 log=phase('raw-root-contract-new-base',['pnpm','test:wasm-contract'],timeout=3600,cwd=RAW,env={'IFC_WASM_BASE_JS':str(S/'packages/wasm/pkg/ifc-lite.js'),'IFC_WASM_BASE_BINARY':str(S/'packages/wasm/pkg/ifc-lite_bg.wasm')})
 assert 'SKIP' not in log and '✖' not in log, 'inspect skips/failures'
 for n,pin in generated.items():assert sha(S/n)==pin['sha256'],n
 assert fixture_guard('after')==before
 save('source-after.json',guard());save('completion.json',{'head':HEAD,'tree':TREE,'rawHead':RAWHEAD,'baseOfficialBuild':True,'committedDtsEqual':True,'rawRootContractWithNewBaseline':True,'rawGeneratedUnchanged':True,'all182Equal':True,'exportBudgetComparison':False,'performanceVerdict':'UNRUN'})
 print('D47_PUBLIC02_BASELINE_COMPLETE',HEAD,flush=True)
except BaseException:
 if O.exists():save('failure.json',{'traceback':traceback.format_exc(),'completedPhases':len(RESULTS)})
 traceback.print_exc();sys.exit(1)
finally:
 if O.exists():
  try:save('source-final.json',guard(True))
  except BaseException:save('source-final-error.json',{'traceback':traceback.format_exc()})
