"""Exact raw7c8 Python consumer only. Reuses proven own PC wheel recipe."""
import hashlib,json,os,shutil,subprocess,sys,traceback,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
P=Path(__file__).resolve().parent
S=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-native-v1/source');TARGET=S.parent/'target'
ROOT=Path('/mnt/c/Users/louistrue/ifc-private/d47-raw-python-consumer-v1');O=ROOT/'evidence'
STATE=Path('/home/louistrue/build-workers/worker-state')
HEAD='7c8cebfca7652cd0a8f4dab97cbc7e3b66c913db';TREE='2d50a075e3eb8d460069b6462b647284ee4e216c';BASE='02b8e1981158559fd4ec9b385d2d80729079a633'
PYTHON=Path('/home/louistrue/.local/share/uv/python/cpython-3.12.14-linux-x86_64-gnu/bin/python3.12')
MATURIN=Path('/home/louistrue/.cache/uv/archive-v0/nEg85VyatxAAFRki/maturin-1.15.0.data/scripts/maturin')
OLD_SITE=Path('/home/louistrue/build-workers/incoming/d47-canonical-admission-897-v1/cand-venv/lib/python3.12/site-packages')
V=ROOT/'venv';PY=V/'bin/python';RESULTS=[];INPUTS={}
CHECK=json.loads((P/'checkpoint.json').read_text());TESTS=json.loads((P/'test-bytes.json').read_text());CLOSURE=json.loads((P/'authentic-pytest-closure.json').read_text())
ENV=os.environ|{'CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_NET_OFFLINE':'true','CARGO_BUILD_JOBS':'2','RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1','PIP_NO_CACHE_DIR':'1','PIP_NO_INDEX':'1','CI':'true','IFC_LITE_REQUIRE_FIXTURES':'1'}
for key in ['PYTHONPATH','PYTHONHOME','CARGO_UNSTABLE_BUILD_STD','RUSTFLAGS','RUSTDOCFLAGS','CARGO_ENCODED_RUSTFLAGS','IFC_LITE_REPIN_GOLDEN']:ENV.pop(key,None)
ENV|={'VIRTUAL_ENV':str(V),'PYO3_PYTHON':str(PY),'PATH':str(V/'bin')+':'+ENV['PATH']}
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def save(n,v):(O/n).write_text(json.dumps(v,indent=2)+'\n')
def git(*args):return subprocess.check_output(['git','-C',str(S),*args],text=True).strip()
def guard():
 assert git('rev-parse','HEAD')==HEAD and git('rev-parse','HEAD^{tree}')==TREE and not git('status','--porcelain')
 assert git('rev-list','--parents','-n','1',HEAD).split()==[HEAD,BASE]
 for rel,pin in CHECK['files'].items():assert sha(S/rel)==pin['sha256'],rel
 for rel,pin in TESTS.items():assert sha(S/rel)==pin['sha256'],rel
 for rel,pin in INPUTS.items():assert sha(S/rel)==pin,rel
 assert sha(PYTHON)=='f7c6210eb40fadcd3c2889dddd24a15fc2c9f926aec5a03bf9da66e12d581526'
 assert sha(MATURIN)=='7770f6d9cbe0497f69b9b60f001a9a92784767651658e778b9664e6ef9b8a29a'
 d=shutil.disk_usage(ROOT);i=os.statvfs(ROOT).f_favail;assert d.free>60*1024**3 and i>100000,(d.free,i)
 return {'head':HEAD,'tree':TREE,'parent':BASE,'clean':True,'payloadFreeBytes':d.free,'payloadFreeInodes':i,'linuxWorkerStateFreeBytes':shutil.disk_usage(STATE).free,'inputHashes':INPUTS,'testHashes':{x:sha(S/x) for x in git('ls-files','rust/python/tests').splitlines()}}
def phase(name,args,timeout=1800,cwd=None):
 before=guard();print('START',name,flush=True);log=O/(name+'.log')
 with log.open('xb') as f:r=subprocess.run(args,cwd=cwd or S,env=ENV,stdout=f,stderr=subprocess.STDOUT,timeout=timeout)
 row={'name':name,'command':args,'cwd':str(cwd or S),'exitCode':r.returncode,'logSha256':sha(log),'before':before,'after':guard()};RESULTS.append(row);save('results.json',RESULTS);print('END',name,r.returncode,flush=True)
 assert r.returncode==0,(name,r.returncode,str(log))
 return log.read_text(errors='replace')
def fixtures(label):
 guard();pins=json.loads((S/'tests/models/manifest.json').read_text())['files'];assert len(pins)==182;rows=[]
 for pin in pins:
  path=S/'tests/models'/pin['path'];actual={'path':pin['path'],'size':path.stat().st_size,'sha256':sha(path)};assert actual['size']==pin['size'] and actual['sha256']==pin['sha256'],actual;rows.append(actual)
 assert any(p['path']=='issues/844_terrain_and_alignment.ifc' for p in rows)
 save('fixtures-'+label+'.json',rows);guard();return rows
def pytest(label,args,expected):
 xml=O/(label+'.xml');phase(label,[str(PY),'-m','pytest',*args,'-v','-ra','--capture=sys','--junitxml='+str(xml),'-o','cache_dir='+str(O/'pytest-cache')],timeout=1800,cwd=O)
 root=ET.parse(xml);cases=list(root.iter('testcase'));fail=list(root.iter('failure'));err=list(root.iter('error'));skip=list(root.iter('skipped'))
 proof={'count':len(cases),'failures':len(fail),'errors':len(err),'skips':len(skip),'testIds':[x.attrib for x in cases],'skipDetails':[x.attrib|{'text':x.text} for x in skip]};save(label+'-inventory.json',proof)
 assert len(cases)==expected and not fail and not err and not skip,proof
 return proof
try:
 assert os.environ.get('IFC_WORKER_ACTIVE_STATE') and os.environ['CARGO_TARGET_DIR']==str(TARGET)
 O.mkdir(exist_ok=False);assert not V.exists()
 for rel in ['Cargo.toml','Cargo.lock','rust/python/Cargo.toml','rust/python/Cargo.lock','rust/python/ifclite_geom.pyi','rust/python/src/entity_data.rs','rust-toolchain.toml','tests/models/manifest.json','packages/parser/test/fixtures/complex-property-budget-7675.json','rust/export/tests/fixtures/shared_set_order_7895.json']:
  INPUTS[rel]=sha(S/rel)
 for rel in ['.cargo/config','.cargo/config.toml']:
  if (S/rel).is_file():INPUTS[rel]=sha(S/rel)
 assert INPUTS['packages/parser/test/fixtures/complex-property-budget-7675.json']=='e1c313ac797ab05a7ea7c237d932d648d37872304987f4ea598363e3334dc988'
 assert not (S/'rust/python/tests/test_entity_data_help.py').exists(),'unrelated doc-head test must not appear'
 prior=json.loads((STATE/'jobs/918bab6a-820b-4eff-ad4a-5e2bb3c5c2de/receipt.json').read_text());assert prior['state']=='completed' and prior['exitCode']==0 and prior['sourceUnchanged'] and prior['sourceBefore']['commit']==HEAD
 save('source-before.json',guard());before=fixtures('before')
 save('tool-inputs.json',{'python':str(PYTHON),'pythonSha256':sha(PYTHON),'maturin':str(MATURIN),'maturinSha256':sha(MATURIN),'target':str(TARGET),'targetProvenance':'OWN inactive raw7c8 native job918; no other target copied','profile':'release','environment':{k:ENV[k] for k in ['CARGO_TARGET_DIR','CARGO_INCREMENTAL','CARGO_PROFILE_DEV_DEBUG','CARGO_PROFILE_TEST_DEBUG','CARGO_BUILD_JOBS','RAYON_NUM_THREADS','RUST_TEST_THREADS','TMPDIR','TMP','TEMP','CI']},'toolchain':(S/'rust-toolchain.toml').read_text(),'cargoConfig':{str(f):f.read_text() for f in [S/'.cargo/config.toml',Path.home()/'.cargo/config.toml',Path.home()/'.cargo/config'] if f.is_file()},'mounts':subprocess.check_output(['findmnt','-T',str(ROOT),'-n','-o','TARGET,FSTYPE,OPTIONS'],text=True),'coreFilemode':git('config','--get','core.filemode'),'driverSha256':sha(__file__)})
 rust=phase('rust-version',['rustc','--version','--verbose']);assert rust.startswith('rustc 1.93.0-nightly (b6d7ff3aa 2025-11-14)')
 cargo=phase('cargo-version',['cargo','--version']);assert cargo.strip()=='cargo 1.93.0-nightly (2d4fa1395 2025-11-12)'
 phase('maturin-version',[str(MATURIN),'--version'])
 phase('private-venv',[str(PYTHON),'-m','venv',str(V)])
 site=Path(subprocess.check_output([str(PY),'-c','import sysconfig;print(sysconfig.get_paths()["purelib"])'],env=ENV,text=True).strip());copied={}
 for child in OLD_SITE.iterdir():
  if child.name!='py.py' and not any(child.name==n or child.name.startswith(n+'-') for n in ['pytest','_pytest','iniconfig','packaging','pluggy','pygments']):continue
  if child.name=='py.py':
   assert child.is_file() and sha(child)==CLOSURE['py']['sha256'];shutil.copyfile(child,site/child.name);assert sha(site/child.name)==sha(child);copied[child.name]={'regularFileSha256':sha(child)};continue
  assert child.is_dir();files={str(f.relative_to(child)):sha(f) for f in child.rglob('*') if f.is_file() and '__pycache__' not in f.parts and f.suffix!='.pyc'}
  if child.name in CLOSURE['metadata']:assert sha(child/'METADATA')==CLOSURE['metadata'][child.name]['metadataSha256']
  shutil.copytree(child,site/child.name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'));assert all(sha(site/child.name/rel)==pin for rel,pin in files.items());copied[child.name]=files
 assert 'py.py' in copied;save('readonly-pytest-copy.json',{'source':str(OLD_SITE),'files':copied,'closure':CLOSURE,'noOldExtensionCopied':True})
 phase('no-old-extension',[str(PY),'-c','import importlib.util,sys,pytest,json;assert importlib.util.find_spec("ifclite_geom") is None;print(json.dumps({"python":sys.executable,"version":sys.version,"pytest":pytest.__version__,"sysPath":sys.path}))'],cwd=O)
 dest=ROOT/'wheels';dest.mkdir();phase('raw-source-wheel',[str(MATURIN),'build','--release','--locked','--offline','--manifest-path','rust/python/Cargo.toml','--interpreter',str(PY),'--out',str(dest)],timeout=5400)
 wheels=list(dest.glob('*.whl'));assert len(wheels)==1;wheel=wheels[0]
 with zipfile.ZipFile(wheel) as z:
  native={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.so')};stubs={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.pyi')};members=z.namelist()
 assert len(native)==1 and sha(S/'rust/python/ifclite_geom.pyi') in stubs.values();save('wheel.json',{'source':guard(),'path':str(wheel),'size':wheel.stat().st_size,'sha256':sha(wheel),'profile':'release','native':native,'stubs':stubs,'members':members})
 phase('install-own-wheel',[str(PY),'-m','pip','install','--no-index','--no-deps',str(wheel)])
 code='''import sys,json,pathlib,hashlib,ifclite_geom,pytest
p=pathlib.Path(ifclite_geom.__file__).resolve()
native={n:{"path":str(pathlib.Path(m.__file__).resolve()),"sha256":hashlib.sha256(pathlib.Path(m.__file__).read_bytes()).hexdigest()} for n,m in sys.modules.items() if n.startswith("ifclite_geom") and getattr(m,"__file__","").endswith(".so")}
stubs={str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in [*p.parent.glob("*.pyi"),*p.parent.parent.glob("ifclite_geom*.pyi")]}
print(json.dumps({"python":sys.executable,"version":sys.version,"module":str(p),"native":native,"stubs":stubs,"pytest":pytest.__version__,"sysPath":sys.path}))'''
 runtime=json.loads(phase('loaded-module',[str(PY),'-c',code],cwd=O));assert Path(runtime['module']).is_relative_to(V) and {x['sha256'] for x in runtime['native'].values()}==set(native.values()) and set(stubs.values()).issubset(set(runtime['stubs'].values()));save('runtime.json',runtime)
 target=[str(S/'rust/python/tests/test_shared_set_budget.py')];old=[str(S/'rust/python/tests'),'--ignore='+str(S/'rust/python/tests/test_shared_set_budget.py')]
 for label,args in [('collect-target19',target),('collect-existing49',old)]:phase(label,[str(PY),'-m','pytest',*args,'--collect-only','-q','--capture=sys','-o','cache_dir='+str(O/'pytest-cache')],cwd=O)
 a=pytest('raw-target19',target,19);b=pytest('raw-existing49',old,49)
 assert any('test_6600_real_infrastructure_multiple_axes' in t['name'] for t in b['testIds'])
 phase('pip-freeze',[str(PY),'-m','pip','freeze','--all'])
 after=fixtures('after');assert after==before;save('source-after.json',guard());save('completion.json',{'head':HEAD,'tree':TREE,'parent':BASE,'target':a,'existing':b,'all182BeforeAfterIdentical':True,'catalog844Executed':True,'wheelSha256':sha(wheel),'nativeArchiveEqualsLoaded':True,'priorPrivateBaseRED':'historical unchanged scope; not repeated','noNativeGatesRepeated':True,'wasm':'UNRUN','performance':'UNRUN; no RSS/firstcallback neutrality claim','publication':'not authorized in this arm'})
 print('D47_RAW_PYTHON_COMPLETE',HEAD,flush=True)
except BaseException as exc:
 if O.exists():save('failure.json',{'type':type(exc).__name__,'message':str(exc),'traceback':traceback.format_exc(),'completedPhases':len(RESULTS)})
 traceback.print_exc();sys.exit(1)
finally:
 if O.exists():save('source-final.json',guard())
