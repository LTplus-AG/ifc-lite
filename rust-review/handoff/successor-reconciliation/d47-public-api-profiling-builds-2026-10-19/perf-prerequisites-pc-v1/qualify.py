"""Ordinary BUILD-ONLY D47 public02/raw profiling prerequisites. No public API measurements."""
import os,json,hashlib,shutil,subprocess,sys,time,traceback,selectors,tomllib,zipfile,re
from pathlib import Path
P=Path(__file__).parent;R=Path('/mnt/c/Users/louistrue/ifc-private/d47-perf-prerequisites-v1');O=R/'evidence'
CACHE=R.parent/'d47-raw-wasm-consumer-v1';CH=CACHE/'cargo-home';STATE=Path('/home/louistrue/build-workers/worker-state')
SOURCES={'base':R.parent/'d47-public02-wasm-baseline-v1/source','raw':R.parent/'d47-raw-native-v1/source'}
PINS={'base':'02b8e1981158559fd4ec9b385d2d80729079a633','raw':'7c8cebfca7652cd0a8f4dab97cbc7e3b66c913db'}
PY=Path('/home/louistrue/.local/share/uv/python/cpython-3.12.14-linux-x86_64-gnu/bin/python3.12');MAT=Path('/home/louistrue/.cache/uv/archive-v0/nEg85VyatxAAFRki/maturin-1.15.0.data/scripts/maturin')
EXPECTED_TOOLS=json.loads((CACHE/'evidence/official-producer.json').read_text())['toolInputs'];RESULTS=[];SNAP={}
E=os.environ|{'CARGO_HOME':str(CH),'CARGO_NET_OFFLINE':'true','CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_BUILD_JOBS':'2','RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2','RUSTUP_TOOLCHAIN':'nightly-2025-11-15','RUSTUP_HOME':'/home/louistrue/.rustup','RUSTUP_AUTO_INSTALL':'0','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PIP_NO_INDEX':'1','PIP_NO_CACHE_DIR':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1','PATH':'/home/louistrue/.cargo/bin:/home/louistrue/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin'}
for k in ['PYTHONPATH','PYTHONHOME','RUSTFLAGS','RUSTDOCFLAGS','CARGO_ENCODED_RUSTFLAGS','CARGO_UNSTABLE_BUILD_STD','CARGO_BUILD_TARGET','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','IFC_LITE_REPIN_GOLDEN']:E.pop(k,None)
for k in ['TMPDIR','TMP','TEMP']:E[k]=str(R/'tmp')
for k,n in {'XDG_CACHE_HOME':'xdg/cache','XDG_DATA_HOME':'xdg/data','XDG_CONFIG_HOME':'xdg/config','XDG_STATE_HOME':'xdg/state','npm_config_cache':'npm-cache','COREPACK_HOME':'corepack','NODE_COMPILE_CACHE':'node-cache'}.items():E[k]=str(R/n)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,indent=2)+'\n')
def git(s,*args):return subprocess.check_output(['git','-C',str(s),*args],text=True).strip()
def guard():
 for side,s in SOURCES.items():assert git(s,'rev-parse','HEAD')==PINS[side] and not git(s,'status','--porcelain'),side
 for pin in EXPECTED_TOOLS.values():assert sha(pin.get('ownPath',pin.get('path')))==pin['sha256']
 assert sha(PY)=='f7c6210eb40fadcd3c2889dddd24a15fc2c9f926aec5a03bf9da66e12d581526'
 assert sha(MAT)=='7770f6d9cbe0497f69b9b60f001a9a92784767651658e778b9664e6ef9b8a29a'
 for n,pin in json.loads((P/'input-pins.json').read_text()).items():
  f=R/'inputs'/n;assert f.stat().st_size==pin['size'] and sha(f)==pin['sha256'],n
 d=shutil.disk_usage(R);assert d.free>60*1024**3 and os.statvfs(R).f_favail>100000
 return {'sources':{side:{'head':git(s,'rev-parse','HEAD'),'tree':git(s,'rev-parse','HEAD^{tree}'),'clean':True} for side,s in SOURCES.items()},'payloadFreeBytes':d.free,'payloadInodes':os.statvfs(R).f_favail,'linuxStateFreeBytes':shutil.disk_usage(STATE).free}
def phase(name,args,cwd,env=None,timeout=7200):
 before=guard();print('START',name,flush=True);log=O/(name+'.log');start=time.monotonic();used=0
 with log.open('xb') as out:
  q=subprocess.Popen(args,cwd=cwd,env=E|(env or {}),stdout=subprocess.PIPE,stderr=subprocess.STDOUT);sel=selectors.DefaultSelector();sel.register(q.stdout,selectors.EVENT_READ)
  try:
   while sel.get_map():
    assert time.monotonic()-start<timeout,('command timeout',name)
    for key,_ in sel.select(1):
     b=os.read(key.fd,65536)
     if not b:sel.unregister(key.fileobj);continue
     used+=len(b);out.write(b);out.flush();assert used<=256*1024**2,('output cap',name)
   code=q.wait(timeout=30)
  except BaseException:q.terminate();raise
  finally:sel.close()
 RESULTS.append({'name':name,'argv':args,'cwd':str(cwd),'envOverrides':env or {},'exitCode':code,'logSha256':sha(log),'logBytes':used,'before':before,'after':guard()});save('results.json',RESULTS);print('END',name,code,flush=True);assert code==0,(name,code,str(log));return log.read_text(errors='replace')
def snapshot():
 return {side:{n:sha(s/n) for n in git(s,'ls-files','rust','scripts/perf/probe.sh','Cargo.toml','Cargo.lock','.cargo','rust-toolchain.toml','tests/models/manifest.json').splitlines() if (s/n).is_file()} for side,s in SOURCES.items()}
def fixtures(label):
 rows=[]
 for pin in json.loads((SOURCES['raw']/'tests/models/manifest.json').read_text())['files']:
  f=SOURCES['raw']/'tests/models'/pin['path'];assert f.stat().st_size==pin['size'] and sha(f)==pin['sha256'];rows.append(pin)
 assert len(rows)==182;save('fixtures-'+label+'.json',rows);return rows
def profile_args(profile):
 args=[]
 for name in ['release','profiling']:
  for k,v in profile[name].items():
   if k=='package':
    for pkg,vals in v.items():
     for a,b in vals.items():args+=['--config',f'profile.{name}.package."{pkg}".{a}='+json.dumps(b)]
   else:args+=['--config',f'profile.{name}.{k}='+json.dumps(v)]
 return args
def seed_python_archives():
 copied=[]
 for s in SOURCES.values():
  for pin in tomllib.loads((s/'rust/python/Cargo.lock').read_text())['package']:
   if 'checksum' not in pin:continue
   name=pin['name'];filename=name+'-'+pin['version']+'.crate';dest=next((CH/'registry/cache').glob('*'))/filename
   if not dest.exists():
    src=next(Path('/home/louistrue/.cargo/registry/cache').glob('*/'+filename));assert sha(src)==pin['checksum'];shutil.copyfile(src,dest);copied.append({'archive':filename,'sha256':sha(dest),'source':str(src)})
   assert sha(dest)==pin['checksum']
   rel=(('1/'+name) if len(name)==1 else ('2/'+name) if len(name)==2 else ('3/'+name[0]+'/'+name) if len(name)==3 else name[:2]+'/'+name[2:4]+'/'+name)
   destindex=next((CH/'registry/index').glob('*'))/'.cache'/rel
   if not destindex.exists():
    src=next(Path('/home/louistrue/.cargo/registry/index').glob('*/.cache/'+rel));destindex.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,destindex);copied.append({'index':rel,'sha256':sha(destindex),'source':str(src)})
 save('missing-python-archive-reuse.json',copied)
try:
 assert os.environ.get('IFC_WORKER_ACTIVE_STATE');O.mkdir();save('source-before.json',guard());SNAP=snapshot();save('source-file-hashes-before.json',SNAP);before=fixtures('before')
 generated=json.loads((CACHE/'evidence/official-producer.json').read_text())['generated']
 for n,pin in generated.items():assert sha(SOURCES['raw']/n)==pin['sha256']
 seed_python_archives();profiles={side:tomllib.loads((s/'Cargo.toml').read_text())['profile'] for side,s in SOURCES.items()};assert profiles['base']==profiles['raw'];save('selected-profile.json',{'profiles':profiles['base'],'nativeClockSource':'std::time::Instant (perf_probe/measurement.rs)','rssSource':'proc_kib from analytic_export/walk_bench_tests.rs; VmRSS/VmHWM','pythonClock':'same std::time::Instant via external C ABI bridge; origin initialized before public call','environment':E,'toolInputs':EXPECTED_TOOLS,'pythonSha256':sha(PY),'maturinSha256':sha(MAT),'meshControl':'OMITTED: process_geometry does not execute changed rows','noTimedCohort':True})
 for side,s in SOURCES.items():
  own=R/side;own.mkdir();crate=own/'wrapper';crate.mkdir();(crate/'src').mkdir();shutil.copyfile(P/'main.rs',crate/'src/main.rs');shutil.copyfile(P/'lib.rs',crate/'src/lib.rs')
  manifest='[package]\nname="d47-public-probe"\nversion="0.1.0"\nedition="2021"\n[workspace]\n[lib]\ncrate-type=["cdylib"]\n[dependencies]\nifc-lite-export={path='+json.dumps(str(s/'rust/export'))+',default-features=false}\nifc-lite-processing={path='+json.dumps(str(s/'rust/processing'))+'}\nserde_json="1"\n'
  text=(s/'Cargo.toml').read_text();manifest+=text[text.index('[profile.release]'):text.index('[profile.dev.package.')];(crate/'Cargo.toml').write_text(manifest);shutil.copyfile(s/'Cargo.lock',crate/'Cargo.lock')
  target=own/'target';venv=own/'venv';env={'CARGO_TARGET_DIR':str(target),'D47_SOURCE_HEAD':PINS[side]}
  phase(side+'-external-lock',['cargo','generate-lockfile','--offline','--manifest-path',str(crate/'Cargo.toml')],crate,env,600)
  locked=tomllib.loads((crate/'Cargo.lock').read_text());original={(x['name'],x['version']):x.get('checksum') for x in tomllib.loads((s/'Cargo.lock').read_text())['package']}
  for x in locked['package']:
   if 'checksum' in x:assert original.get((x['name'],x['version']))==x['checksum'],x
  phase(side+'-native-wrapper',['cargo','build','--locked','--offline','--profile','profiling','--manifest-path',str(crate/'Cargo.toml')],crate,env)
  phase(side+'-wrapper-identity',[str(target/'profiling/d47-public-probe'),'--identity'],own,env,60)
  phase(side+'-private-venv',[str(PY),'-m','venv',str(venv)],own,env,300)
  python=venv/'bin/python';env|={'VIRTUAL_ENV':str(venv),'PYO3_PYTHON':str(python)};wheels=own/'wheels';wheels.mkdir()
  phase(side+'-profiling-wheel',[str(MAT),'build','--locked','--offline','--profile','profiling',*profile_args(profiles[side]),'--manifest-path',str(s/'rust/python/Cargo.toml'),'--interpreter',str(python),'--out',str(wheels)],s,env)
  wheel,=wheels.glob('*.whl')
  with zipfile.ZipFile(wheel) as z:
   native={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.so')};stubs={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.pyi')}
  assert len(native)==1 and sha(s/'rust/python/ifclite_geom.pyi') in stubs.values()
  phase(side+'-install-profiling-wheel',[str(python),'-m','pip','install','--no-index','--no-deps',str(wheel)],own,env,300)
  code='import ifclite_geom,sys,pathlib,hashlib,json;print(json.dumps({"python":sys.executable,"version":sys.version,"native":{str(pathlib.Path(m.__file__).resolve()):hashlib.sha256(pathlib.Path(m.__file__).read_bytes()).hexdigest() for n,m in sys.modules.items() if n.startswith("ifclite_geom") and getattr(m,"__file__","").endswith(".so")}}))'
  loaded=json.loads(phase(side+'-loaded-native',[str(python),'-c',code],own,env,60));assert set(loaded['native'].values())==set(native.values()) and all(Path(n).is_relative_to(venv) for n in loaded['native'])
  phase(side+'-freeze',[str(python),'-m','pip','freeze','--all'],own,env,60)
  artifacts=[target/'profiling/d47-public-probe',target/'profiling/libd47_public_probe.so',wheel,*map(Path,loaded['native'])]
  for i,f in enumerate(artifacts):
   if f.suffix!='.whl':phase(side+'-elf-'+str(i),['readelf','-l','-d','--version-info',str(f)],own,env,60)
  save(side+'-artifacts.json',{'sourceHead':PINS[side],'profile':'profiling','artifacts':{str(f):{'sha256':sha(f),'size':f.stat().st_size} for f in artifacts},'wheelNative':native,'wheelStubs':stubs,'loaded':loaded,'stubSourceSha256':sha(s/'rust/python/ifclite_geom.pyi'),'wrapperLockSha256':sha(crate/'Cargo.lock'),'noPublicDataCallExecuted':True})
 assert snapshot()==SNAP;save('source-file-hashes-after.json',SNAP);assert fixtures('after')==before
 for n,pin in generated.items():assert sha(SOURCES['raw']/n)==pin['sha256']
 save('source-final.json',guard());save('completion.json',{'buildOnly':True,'base':PINS['base'],'raw':PINS['raw'],'all182Equal':True,'sourceExactBeforeAfter':True,'rawGeneratedUnchanged':True,'noPerformanceMeasurement':True,'popLoaderExecution':'UNRUN; review actual readelf requirements before transfer/cohort'})
 print('D47_PROFILING_PREREQUISITES_COMPLETE',flush=True)
except BaseException:
 if O.exists():save('failure.json',{'traceback':traceback.format_exc(),'completedPhases':len(RESULTS)})
 traceback.print_exc();sys.exit(1)
finally:
 if O.exists():
  try:save('source-finally.json',guard())
  except BaseException:save('source-finally-error.json',{'traceback':traceback.format_exc()})
