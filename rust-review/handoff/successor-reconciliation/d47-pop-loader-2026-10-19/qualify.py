# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Pop loader/import/install ONLY. No IFC data, witness, test, build or timing calls."""
import os,sys,json,hashlib,shutil,subprocess,tarfile,stat,traceback,zipfile,platform
from pathlib import Path
R=Path(__file__).parent;O=R/'evidence';PAY=R/'payload';STATE=Path('/home/louistrue/build-workers/worker-state')
REUSE=json.loads((R/'READONLY_POP_PYTHON_REUSE.json').read_text());RT=Path(REUSE['runtime_root']);PY=Path(REUSE['python_executable']);AUTH=json.loads((R/'authenticated-runtime-manifest.json').read_text());READY=json.loads((R/'READY-ARTIFACTS.json').read_text());RESULTS=[];LIBS={}
HEADS={'base':'02b8e1981158559fd4ec9b385d2d80729079a633','raw':'7c8cebfca7652cd0a8f4dab97cbc7e3b66c913db'}
ENV=os.environ|{'PYTHONDONTWRITEBYTECODE':'1','PYTHONNOUSERSITE':'1','PIP_NO_INDEX':'1','PIP_NO_CACHE_DIR':'1','PIP_DISABLE_PIP_VERSION_CHECK':'1','RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2','PATH':'/usr/bin:/bin'}
for k in ['PYTHONPATH','PYTHONHOME','VIRTUAL_ENV']:ENV.pop(k,None)
for k in ['TMPDIR','TMP','TEMP']:ENV[k]=str(R/'tmp')
for k,n in {'XDG_CACHE_HOME':'cache','XDG_DATA_HOME':'data','XDG_CONFIG_HOME':'config','XDG_STATE_HOME':'state','PIP_CACHE_DIR':'cache/pip','NODE_COMPILE_CACHE':'cache/node'}.items():ENV[k]=str(R/n)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def save(n,d):(O/n).write_text(json.dumps(d,indent=2)+'\n')
def manifest():
 rows={}
 for f in [RT,*sorted(RT.rglob('*'))]:
  st=f.lstat();row={'mode':stat.S_IMODE(st.st_mode),'mtime_ns':st.st_mtime_ns}
  if stat.S_ISLNK(st.st_mode):row|={'kind':'symlink','link':os.readlink(f)}
  elif stat.S_ISDIR(st.st_mode):row|={'kind':'dir'}
  elif stat.S_ISREG(st.st_mode):row|={'kind':'file','bytes':st.st_size,'sha256':sha(f)}
  else:raise AssertionError(('unexpected runtime entry',str(f)))
  rows[str(f.relative_to(RT)) if f!=RT else '.']=row
 return rows
def guard(extracted=True):
 assert sha(PY)==REUSE['executable_sha256']=='f7c6210eb40fadcd3c2889dddd24a15fc2c9f926aec5a03bf9da66e12d581526'
 assert sha(R/'ready-payload.tar.gz')=='0a601699205f10e3676c6ccef587f839692ee347631231f18435dc5d5c3a2b0e'
 if extracted:
  for n,pin in READY['artifacts'].items():assert (PAY/n).stat().st_size==pin['size'] and sha(PAY/n)==pin['sha256'],n
 du=shutil.disk_usage(R);assert du.free>60*1024**3 and os.statvfs(R).f_favail>100000
 return {'payloadPinned':True,'pythonSha256':sha(PY),'payloadFreeBytes':du.free,'payloadFreeInodes':os.statvfs(R).f_favail,'actualHost':platform.node(),'actualMachine':platform.machine(),'actualLibc':platform.libc_ver(),'sourcePair':HEADS,'profilingSource':'retained source-matched v26build; no source compiled here'}
def phase(name,args,timeout=120):
 before=guard();print('START',name,flush=True);log=O/(name+'.log')
 with log.open('xb') as f:q=subprocess.run(args,cwd=R,env=ENV,stdout=f,stderr=subprocess.STDOUT,timeout=timeout)
 row={'name':name,'argv':args,'exitCode':q.returncode,'logSha256':sha(log),'logBytes':log.stat().st_size,'before':before,'after':guard()};RESULTS.append(row);save('results.json',RESULTS);print('END',name,q.returncode,flush=True);assert q.returncode==0,(name,q.returncode,str(log));assert log.stat().st_size<16*1024**2
 return log.read_text()
def loader(name,path):
 text=phase(name,['/usr/bin/ldd',str(path)]);assert 'not found' not in text
 for line in text.splitlines():
  for part in line.split():
   if part.startswith('/') and Path(part).is_file():
    f=Path(part).resolve();LIBS[str(f)]={'sha256':sha(f),'size':f.stat().st_size}
 save('actual-system-libraries.json',LIBS)
 return text
try:
 assert os.environ.get('IFC_WORKER_ACTIVE_STATE');O.mkdir();assert len(AUTH)==5382;before=manifest();save('runtime-full-before.json',before);assert before==AUTH,'runtime differs from authenticated complete manifest';save('pre-extraction.json',guard(False));assert not PAY.exists()
 with tarfile.open(R/'ready-payload.tar.gz') as tar:
  members=tar.getmembers();assert len([m for m in members if m.isfile()])==10
  for m in members:assert not Path(m.name).is_absolute() and '..' not in Path(m.name).parts and (m.isdir() or m.isfile())
  tar.extractall(PAY,filter='data')
 save('payload-before.json',guard());save('host-loader.json',{'host':platform.uname()._asdict(),'libc':platform.libc_ver(),'pythonExecutable':str(PY),'pythonExecutableSha256':sha(PY),'runtimeManifestEntries':len(before),'archiveSha256':sha(R/'ready-payload.tar.gz'),'profile':READY['profile'],'originalToolchain':READY['toolchain'],'readOnlyRuntimeReuse':True,'workerAdministrativeCheckout':'original own525 only; no checkout code used; runtime sources are exact02/raw7c8 proven by v26artifact hashes and wrapper identity'})
 phase('host-libc',['/usr/bin/ldd','--version'])
 phase('python-identity',[str(PY),'-c','import sys,json;print(json.dumps({"executable":sys.executable,"version":sys.version,"base_prefix":sys.base_prefix}));assert sys.version_info[:3]==(3,12,14)'])
 loader('python-loader',PY)
 identities={};loaders={}
 for side in ['base','raw']:
  own=PAY/side;binary=own/'d47-public-probe';lib=own/'libd47_public_probe.so';venv=own/'venv';assert not venv.exists()
  ident=json.loads(phase(side+'-wrapper-identity',[str(binary),'--identity']));assert ident['source']==HEADS[side] and ident['profile']=='profiling';identities[side]=ident
  loader(side+'-wrapper-ldd',binary);loader(side+'-clock-ldd',lib)
  phase(side+'-private-venv',[str(PY),'-m','venv',str(venv)],timeout=300);python=venv/'bin/python';wheel,=own.glob('*.whl')
  with zipfile.ZipFile(wheel) as z:
   native={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.so')};stubs={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.endswith('.pyi')}
  assert len(native)==1 and stubs
  phase(side+'-install-exact-wheel',[str(python),'-m','pip','install','--no-index','--no-deps',str(wheel)],timeout=300)
  code='import sys,json,pathlib,hashlib,ifclite_geom;print(json.dumps({"python":sys.executable,"version":sys.version,"base_prefix":sys.base_prefix,"module":ifclite_geom.__file__,"native":{str(pathlib.Path(m.__file__).resolve()):hashlib.sha256(pathlib.Path(m.__file__).read_bytes()).hexdigest() for n,m in sys.modules.items() if n.startswith("ifclite_geom") and getattr(m,"__file__","").endswith(".so")},"stubs":{str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in pathlib.Path(ifclite_geom.__file__).parent.glob("*.pyi")}}))'
  actual=json.loads(phase(side+'-import-only',[str(python),'-c',code]));assert Path(actual['module']).is_relative_to(venv) and set(actual['native'].values())==set(native.values()) and set(stubs.values()).issubset(set(actual['stubs'].values()));assert Path(actual['base_prefix']).resolve()==RT.resolve()
  so=next(iter(actual['native']));loader(side+'-native-ldd',so)
  code='import ctypes,json,pathlib,hashlib; p=pathlib.Path('+repr(str(lib))+');lib=ctypes.CDLL(str(p));assert hasattr(lib,"d47_clock_now_ns");print(json.dumps({"library":str(p),"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"symbolResolved":True,"clockFunctionCalled":False}))'
  clock=json.loads(phase(side+'-clock-load-only',[str(python),'-c',code]));assert clock['sha256']==READY['artifacts'][side+'/libd47_public_probe.so']['sha256'] and not clock['clockFunctionCalled']
  phase(side+'-freeze',[str(python),'-m','pip','freeze','--all'])
  loaders[side]={'source':HEADS[side],'binary':str(binary),'binarySha256':sha(binary),'clockLibrary':clock,'venv':str(venv),'python':str(python),'wheel':str(wheel),'wheelSha256':sha(wheel),'archiveNative':native,'archiveStubs':stubs,'imported':actual};save(side+'-ready.json',loaders[side])
 for f,pin in LIBS.items():assert sha(f)==pin['sha256'] and Path(f).stat().st_size==pin['size']
 after=manifest();save('runtime-full-after.json',after);assert before==after==AUTH;save('runtime-preservation.json',{'entries':len(after),'wholeOriginalAuthenticatedBeforeAfterEqual':True,'readOnly':True});save('payload-after.json',guard())
 (PAY/'results').mkdir()
 calls=json.loads((R/'FINITE-150-INVOCATIONS.json').read_text());assert len(calls['observations'])==150
 for c in calls['observations']:
  assert c['argv'][0].startswith(str(PAY)) and c['argv'][-1].startswith(str(PAY/'results'));assert Path(c['argv'][0]).exists()
 calls['status']='POP LOADER READY;150calls UNRUN/UNSUBMITTED';calls['loaderEvidence']='evidence/base-ready.json + evidence/raw-ready.json';save('POP-150-INVOCATIONS.json',calls)
 save('completion.json',{'sourcePair':HEADS,'loaderReady':loaders,'wrapperIdentities':identities,'runtime5382Preserved':True,'payloadFixturesExact':True,'dataCalls':0,'witnessCalls':0,'measuredCalls':0,'builds':0,'measurementRequestSubmitted':False,'profileUnchanged':True});print('D47_POP_LOADER_READY',flush=True)
except BaseException:
 if O.exists():save('failure.json',{'traceback':traceback.format_exc(),'completedPhases':len(RESULTS)})
 traceback.print_exc();sys.exit(1)
finally:
 if O.exists():
  try:save('runtime-full-finally.json',manifest());save('payload-finally.json',guard(PAY.exists()))
  except BaseException:save('finally-error.json',{'traceback':traceback.format_exc()})
