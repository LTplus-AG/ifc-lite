"""Finite raw7c8 official WASM/public consumer arm; no native/Python/perf gates."""
import hashlib,json,os,shutil,subprocess,sys,time,traceback,tomllib,tarfile,selectors
from pathlib import Path
P=Path(__file__).resolve().parent
S=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-native-v1/source')
R=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-wasm-consumer-v1');O=R/'evidence';TARGET=R/'target';MANIFEST=R/'manifest-target';CH=R/'cargo-home'
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
 O.mkdir();assert not TARGET.exists() and not MANIFEST.exists()
 for n in ['cargo-home','tools','tmp','xdg/cache','xdg/data','xdg/config','xdg/state','corepack','npm-cache','pnpm-home','node-cache','turbo-cache']: (R/n).mkdir(parents=True,exist_ok=True)
 for n in git('ls-files').splitlines():
  if n.startswith(('rust/','packages/wasm/','scripts/')) or n in ['Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.cargo/config.toml','tests/models/manifest.json','turbo.json','packages/parser/test/fixtures/complex-property-budget-7675.json']:INPUTS[n]=sha(S/n)
 assert INPUTS['packages/parser/test/fixtures/complex-property-budget-7675.json']=='e1c313ac797ab05a7ea7c237d932d648d37872304987f4ea598363e3334dc988'
 assert not (S/'packages/wasm/pkg/ifc-lite.js').exists() and not (S/'packages/wasm/pkg/ifc-lite_bg.wasm').exists()
 save('source-before.json',guard());before=fixture_guard('before');shutil.copyfile(S/'packages/wasm/pkg/ifc-lite.d.ts',O/'committed-ifc-lite.d.ts')
 # Native executable bytes from authentic installed tools, never the npm downloader shim.
 toolpaths={'wasm-pack':(NODE.parent/'lib/node_modules/wasm-pack/binary/wasm-pack','c6c3d54702f4bae4a1d51e37e19c2c61b130865dc3fabc745eebe8194b87b253'),'wasm-bindgen':(H/'.cache/.wasm-pack/wasm-bindgen-8b0e612a116397d6/wasm-bindgen','d8d94635b40d1d8a93562fc7ced6093488252600dba39ce1dbab410b89157d8b'),'wasm-bindgen-test-runner':(H/'.cache/.wasm-pack/wasm-bindgen-8b0e612a116397d6/wasm-bindgen-test-runner','a34c86212510b24a67315528df5109587001f51175904871be21ceb30eaa01b3')}
 tools={}
 for n,(src,pin) in toolpaths.items():assert sha(src)==pin;shutil.copy2(src,BIN/n);assert sha(BIN/n)==pin;tools[n]={'source':str(src),'ownPath':str(BIN/n),'sha256':pin}
 for n,pin in [('rustc','56ae45b0d36c8cf3c5c5f1a7a602f5fde12782e9d4b48a78e60bda3a3b11048c'),('cargo','094ca6ad7b2f42fe32f08f93d89b27f075d675102e2eeb6e235fee7c318acfae')]:assert sha(TC/'bin'/n)==pin;tools[n]={'path':str(TC/'bin'/n),'sha256':pin}
 assert sha(NODE/'node')=='7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c';tools['node']={'path':str(NODE/'node'),'sha256':sha(NODE/'node')}
 save('tool-producer-inputs.json',{'tools':tools,'environment':E,'cargoEnv':{'path':str(H/'.cargo/env'),'sha256':sha(H/'.cargo/env')},'mount':subprocess.check_output(['findmnt','-T',str(R),'-n','-o','TARGET,FSTYPE,OPTIONS'],text=True),'hostLoader':{str(x):sha(x) for x in [Path('/usr/lib/x86_64-linux-gnu/libc.so.6'),Path('/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2')]},'noPerfProducerEquivalenceClaim':True})
 print('START seed-owned-offline-caches',flush=True)
 key='index.crates.io-1949cf8c6b5b557f';archives={};missing=[]
 for lock in [S/'Cargo.lock',TC/'lib/rustlib/src/rust/library/Cargo.lock']:
  for pin in tomllib.loads(lock.read_text())['package']:
   if not pin.get('source','').startswith('registry+'):continue
   n=pin['name']+'-'+pin['version']+'.crate';src=H/'.cargo/registry/cache'/key/n
   if not src.is_file():missing.append({'archive':n,'lock':str(lock),'checksum':pin['checksum']});continue
   assert sha(src)==pin['checksum'],n;dest=CH/'registry/cache'/key/n;dest.parent.mkdir(parents=True,exist_ok=True)
   if not dest.exists():shutil.copyfile(src,dest)
   assert sha(dest)==pin['checksum'];archives[n]={'sha256':pin['checksum'],'size':src.stat().st_size}
 index=copy_tree(H/'.cargo/registry/index'/key,CH/'registry/index'/key)
 bindgen=copy_tree(H/'.cache/.wasm-pack/wasm-bindgen-8b0e612a116397d6',R/'xdg/cache/.wasm-pack/wasm-bindgen-8b0e612a116397d6')
 corepack=copy_tree(H/'.cache/node/corepack/v1/pnpm/10.8.1',R/'corepack/v1/pnpm/10.8.1')
 store={}
 for n in ['files','index']:store[n]=copy_tree(H/'.local/share/pnpm/store/v10'/n,R/'pnpm-store/v10'/n)
 save('owned-cache-seeds.json',{'archives':archives,'absentRustSrcAllPlatformArchives':missing,'index':index,'bindgen':bindgen,'corepack':corepack,'pnpmStore':store,'sourceExtraction':'NO vendor/src copy; Cargo verifies archived lock checksums and extracts into own CARGO_HOME','noDownload':True});guard();print('END seed-owned-offline-caches 0',flush=True)
 for n,args in [('node',['node','--version']),('rustc',['rustc','--version','--verbose']),('cargo',['cargo','--version']),('wasm-pack',['wasm-pack','--version']),('bindgen',['wasm-bindgen','--version']),('pnpm',['pnpm','--version'])]:phase('tool-'+n,args)
 phase('public-witness-syntax',['node','--check',str(P/'wasm-public-budget.mjs')])
 phase('root-offline-install',['pnpm','install','--offline','--frozen-lockfile','--ignore-scripts','--store-dir',str(R/'pnpm-store')],timeout=1800)
 phase('strict-official-wasm',['bash','scripts/build-wasm.sh'],timeout=7200,dts=True)
 for n in ['ifc-lite.js','ifc-lite_bg.wasm','ifc-lite.d.ts']:assert (S/'packages/wasm/pkg'/n).stat().st_size>0
 shutil.copyfile(S/'packages/wasm/pkg/ifc-lite.d.ts',O/'generated-ifc-lite.d.ts')
 # Run this exact check before the next strict source guard if generation changed types.
 with (O/'committed-dts.log').open('xb') as f:d=subprocess.run(['git','-C',str(S),'diff','--exit-code','HEAD','--','packages/wasm/pkg/ifc-lite.d.ts'],stdout=f,stderr=subprocess.STDOUT)
 assert d.returncode==0,('committed dts mismatch',d.returncode)
 guard();generated={str(f.relative_to(S)): {'sha256':sha(f),'size':f.stat().st_size} for f in (S/'packages/wasm/pkg').rglob('*') if f.is_file()}
 save('official-producer.json',{'head':HEAD,'tree':TREE,'source':guard(),'generated':generated,'toolInputs':tools,'officialScriptSha256':INPUTS['scripts/build-wasm.sh'],'producer':'PC Linux/WSL, Node24.21.0, nightly2025-11-15, wasm-pack0.15/bindgen0.2.126','notPopOrPerformanceComparable':True})
 pkg=phase('root-wasm-package',['pnpm','test','--filter=@ifc-lite/wasm','--only','--concurrency=1','--env-mode=loose','--cache-dir='+str(R/'turbo-cache')]);save('package-result-lines.json',[l for l in pkg.splitlines() if any(x in l for x in ['# tests','# pass','# fail','# skipped','SKIP','skip'])])
 contract=phase('root-actual-contract',['pnpm','test:wasm-contract'],timeout=1800);skips=[l for l in contract.splitlines() if 'skip' in l.lower()];save('contract-result-lines.json',{'skips':skips,'summary':[l for l in contract.splitlines() if any(x in l.lower() for x in ['passed','failed','skipped','missing'])]});assert not any('missing' in l.lower() and ('fixture' in l.lower() or 'runtime' in l.lower()) for l in contract.splitlines()),'missing input contract skip'
 manifest=phase('official-wasm-manifest',['wasm-pack','test','--node','--mode','no-install','rust/wasm-bindings','--test','mesh_determinism'],timeout=3600,env={'CARGO_TARGET_DIR':str(MANIFEST),'CARGO_UNSTABLE_BUILD_STD':'std,panic_abort'});assert 'mesh_output_matches_pinned_manifest_on_wasm32' in manifest and '1 passed; 0 failed; 0 ignored' in manifest
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
