import doctest, hashlib, json, os, shutil, subprocess, sys, traceback, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
P=Path(__file__).resolve().parent
C=json.loads((P/'checkpoint.json').read_text())
S=Path('/mnt/c/Users/louistrue/ifc-private/d47-python-doc-584-v1/source')
TARGET=S.parent/'target'
ROOT=Path('/mnt/c/Users/louistrue/ifc-private/d47-python-doc-runtime-7932-v5')
O=ROOT/'evidence';O.mkdir(exist_ok=False)
PYTHON=Path('/home/louistrue/.local/share/uv/python/cpython-3.12.14-linux-x86_64-gnu/bin/python3.12')
MATURIN=Path('/home/louistrue/.cache/uv/archive-v0/nEg85VyatxAAFRki/maturin-1.15.0.data/scripts/maturin')
OLD_SITE=Path('/home/louistrue/build-workers/incoming/d47-canonical-admission-897-v1/cand-venv/lib/python3.12/site-packages')
V=ROOT/'venv';PY=V/'bin/python'
RESULTS=[]
ENV=os.environ|{'CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_NET_OFFLINE':'true','CARGO_BUILD_JOBS':'2','RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2','PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1','PIP_NO_CACHE_DIR':'1'}
for key in ['PYTHONPATH','PYTHONHOME','CARGO_UNSTABLE_BUILD_STD','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS']:ENV.pop(key,None)
ENV|={'VIRTUAL_ENV':str(V),'PYO3_PYTHON':str(PY),'PATH':str(V/'bin')+':'+ENV['PATH']}
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(n,v):(O/n).write_text(json.dumps(v,indent=2)+'\n')
def git(*args):return subprocess.check_output(['git','-C',str(S),*args],text=True).strip()
def guard(head):
 assert git('rev-parse','HEAD')==head and not git('status','--porcelain')
 expected=C['tree'] if head==C['head'] else C['inverseTree']
 assert git('rev-parse','HEAD^{tree}')==expected
 assert sha(S/'rust/python/tests/test_entity_data_help.py')==C['testSha256']
 assert sha(S/'rust/export/tests/fixtures/c6_data_model_synthetic.ifc')==C['fixtureSha256']
 assert sha(PYTHON)=='f7c6210eb40fadcd3c2889dddd24a15fc2c9f926aec5a03bf9da66e12d581526'
 assert sha(MATURIN)=='7770f6d9cbe0497f69b9b60f001a9a92784767651658e778b9664e6ef9b8a29a'
 du=shutil.disk_usage(ROOT);ino=os.statvfs(ROOT).f_favail
 assert du.free>60*1024**3 and ino>100000,(du.free,ino)
 return {'head':head,'tree':expected,'clean':True,'freeBytes':du.free,'freeInodes':ino,'sourceHashes':{x:sha(S/x) for x in ['rust/python/src/entity_data.rs','rust/python/ifclite_geom.pyi','rust/python/tests/test_entity_data_help.py','Cargo.lock','rust/python/Cargo.lock','rust-toolchain.toml']},'linuxInfrastructureFreeBytes':shutil.disk_usage('/home/louistrue/build-workers/worker-state').free}
def phase(name,args,head=None,expected=0,cwd=None):
 head=head or C['head'];before=guard(head);print('START',name,flush=True)
 log=O/(name+'.log')
 with log.open('wb') as f:r=subprocess.run(args,cwd=cwd or S,env=ENV,stdout=f,stderr=subprocess.STDOUT,timeout=7200)
 after=guard(head);row={'name':name,'command':args,'cwd':str(cwd or S),'exitCode':r.returncode,'expected':expected,'logSha256':sha(log),'before':before,'after':after}
 RESULTS.append(row);save('results.json',RESULTS);print('END',name,r.returncode,flush=True)
 assert r.returncode==expected,(name,r.returncode,'expected',expected,str(log))
 return log.read_text(errors='replace')
def build(label,head):
 dest=ROOT/(label+'-wheels');dest.mkdir()
 phase(label+'-source-wheel',[str(MATURIN),'build','--release','--locked','--offline','--manifest-path','rust/python/Cargo.toml','--interpreter',str(PY),'--out',str(dest)],head)
 wheels=list(dest.glob('*.whl'));assert len(wheels)==1;wheel=wheels[0]
 with zipfile.ZipFile(wheel) as z:
  native={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.so')}
  stubs={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.pyi')}
 assert len(native)==1 and sha(S/'rust/python/ifclite_geom.pyi') in stubs.values()
 proof={'source':guard(head),'wheel':str(wheel),'wheelSha256':sha(wheel),'native':native,'stubs':stubs,'profile':'release'};save(label+'-wheel.json',proof)
 return wheel,proof
def install(label,wheel,head):phase(label+'-install',[str(PY),'-m','pip','install','--no-index','--no-deps','--force-reinstall',str(wheel)],head)
def runtime(label,head,proof,examples):
 code='''import sys,json,pathlib,hashlib,doctest,ifclite_geom,pytest
p=pathlib.Path(ifclite_geom.__file__).resolve();doc=ifclite_geom.entity_data.__doc__
native={name:{"path":str(pathlib.Path(m.__file__).resolve()),"sha256":hashlib.sha256(pathlib.Path(m.__file__).read_bytes()).hexdigest()} for name,m in sys.modules.items() if name.startswith("ifclite_geom") and getattr(m,"__file__","").endswith(".so")}
stubs={str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in [*p.parent.glob("*.pyi"),*p.parent.parent.glob("ifclite_geom*.pyi")]}
print(json.dumps({"python":sys.executable,"pythonVersion":sys.version,"module":str(p),"native":native,"stubs":stubs,"pytest":pytest.__version__,"publicHelp":doc,"exampleCount":len(doctest.DocTestParser().get_examples(doc))}))'''
 data=json.loads(phase(label+'-runtime',[str(PY),'-c',code],head,cwd=O))
 assert Path(data['module']).is_relative_to(V)
 assert {x['sha256'] for x in data['native'].values()}==set(proof['native'].values())
 assert set(proof['stubs'].values()).issubset(set(data['stubs'].values()))
 assert (data['exampleCount']>0) if examples else data['exampleCount']==0
 save(label+'-runtime.json',data)
def test(label,head,expected):
 xml=O/(label+'.xml')
 log=phase(label,[str(PY),'-m','pytest',str(S/'rust/python/tests/test_entity_data_help.py'),'-q','-rs','--junitxml='+str(xml),'-o','cache_dir='+str(O/'pytest-cache')],head,expected,cwd=O)
 root=ET.parse(xml);cases=list(root.iter('testcase'));fails=list(root.iter('failure'));errors=list(root.iter('error'));skips=list(root.iter('skipped'))
 assert len(cases)==1 and not errors and not skips
 if expected:
  assert len(fails)==1 and '#7932: public entity_data help needs executable examples' in (fails[0].text or '') and 'AssertionError' in (fails[0].text or '')
 else:assert not fails
 save(label+'-assertions.json',{'tests':len(cases),'failures':len(fails),'errors':len(errors),'skips':len(skips),'failureText':[x.text for x in fails],'logSha256':hashlib.sha256(log.encode()).hexdigest()})
def transition(label,head):
 before=git('rev-parse','HEAD')
 subprocess.run(['git','-C',str(S),'checkout','--detach',head],check=True,capture_output=True)
 save(label+'.json',{'from':before,'to':head,'after':guard(head)})
assert ENV['CARGO_TARGET_DIR']==str(TARGET)
save('source-before.json',guard(C['head']))
save('tool-inputs.json',{'pythonPath':str(PYTHON),'pythonSha256':sha(PYTHON),'maturinPath':str(MATURIN),'maturinSha256':sha(MATURIN),'target':str(TARGET),'targetReuse':'OWN inactive584 exact-clippy target; serialized release wheels and final-head clippy','leanFlags':{k:ENV[k] for k in ['CARGO_INCREMENTAL','CARGO_PROFILE_DEV_DEBUG','CARGO_PROFILE_TEST_DEBUG']},'toolchain':(S/'rust-toolchain.toml').read_text(),'cargoConfig':(S/'.cargo/config.toml').read_text()})
try:
 phase('private-venv',[str(PYTHON),'-m','venv',str(V)])
 site=Path(subprocess.check_output([str(PY),'-c','import sysconfig;print(sysconfig.get_paths()["purelib"])'],env=ENV,text=True).strip());copied={}
 for child in OLD_SITE.iterdir():
  if child.name!='py.py' and not any(child.name==n or child.name.startswith(n+'-') for n in ['pytest','_pytest','iniconfig','packaging','pluggy','pygments']):continue
  if child.name=='py.py':
   assert child.is_file() and sha(child)=='b71675b5d9845ba0814e9e88767f88dac3b3cc0d3128da028bd45edbb523e871'
   shutil.copyfile(child,site/child.name);assert sha(site/child.name)==sha(child)
   copied[child.name]={'regularFileSha256':sha(child)};continue
  assert child.is_dir();files={str(f.relative_to(child)):sha(f) for f in child.rglob('*') if f.is_file() and '__pycache__' not in f.parts and f.suffix!='.pyc'}
  shutil.copytree(child,site/child.name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'));copied[child.name]=files
 assert copied;save('readonly-pytest-copy.json',{'source':str(OLD_SITE),'files':copied,'noOldExtensionCopied':True})
 phase('tool-versions',[str(MATURIN),'--version'])
 phase('no-old-extension',[str(PY),'-c','import importlib.util,sys,pytest;assert importlib.util.find_spec("ifclite_geom") is None;print(sys.executable,sys.version,pytest.__version__)'],cwd=O)
 wheel,proof=build('candidate',C['head']);install('candidate',wheel,C['head']);runtime('candidate',C['head'],proof,True)
 test('candidate-public-help',C['head'],0)
 phase('final-head-exact-clippy',['cargo','clippy','--workspace','--all-targets','--','-D','warnings'])
 transition('inverse-transition',C['inverse'])
 inverse,ip=build('inverse',C['inverse']);install('inverse',inverse,C['inverse']);runtime('inverse',C['inverse'],ip,False)
 test('inverse-public-help',C['inverse'],1)
 transition('restore-candidate',C['head'])
 install('restored-candidate',wheel,C['head']);runtime('restored-candidate',C['head'],proof,True)
 test('restored-candidate-public-help',C['head'],0)
 phase('pip-freeze',[str(PY),'-m','pip','freeze','--all'])
 save('complete.json',{'candidate':C['head'],'inverse':C['inverse'],'positive':'1PASS','negative':'1 assertionFAIL: compiled oldhelp has no executable examples','clippy':0,'candidateRestored':True,'sourceAfter':guard(C['head'])})
 print('D47_PUBLIC_HELP_COMPLETE',C['head'],flush=True)
finally:
 if git('rev-parse','HEAD')!=C['head']:transition('failure-restore-candidate',C['head'])
 save('source-final.json',guard(C['head']))
