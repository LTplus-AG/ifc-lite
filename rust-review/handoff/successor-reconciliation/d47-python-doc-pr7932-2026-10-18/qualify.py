import hashlib,json,os,shutil,subprocess,time
from pathlib import Path
ROOT=Path('/mnt/c/Users/louistrue/ifc-private/d47-python-doc-584-v1')
S=ROOT/'source';O=ROOT/'evidence';O.mkdir(exist_ok=False)
HEAD='58460fe102dc70159601602a1a3b043592dee88f';TREE='ac3349f5bba9189d98dfb69fa93c5c6ee5e023a4'
def git(*a):return subprocess.check_output(['git','-C',str(S),*a],text=True).strip()
def check():
 assert git('rev-parse','HEAD')==HEAD and git('rev-parse','HEAD^{tree}')==TREE
 assert not git('status','--porcelain')
 usage=shutil.disk_usage(ROOT);ino=os.statvfs(ROOT).f_favail
 assert usage.free>60*1024**3 and ino>100000,(usage.free,ino)
 return {'head':HEAD,'tree':TREE,'clean':True,'freeBytes':usage.free,'freeInodes':ino,'linuxWorkerVolumeFreeBytes':shutil.disk_usage('/home/louistrue/build-workers/worker-state').free}
def save(n,v):(O/n).write_text(json.dumps(v,indent=2)+'\n')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
before=check();save('source-before.json',before)
env=os.environ|{'CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_NET_OFFLINE':'true','CARGO_BUILD_JOBS':'2','RAYON_NUM_THREADS':'2','RUST_TEST_THREADS':'1','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','MKL_NUM_THREADS':'2'}
assert env['CARGO_TARGET_DIR']==str(ROOT/'target')
save('inputs.json',{'toolchain':(S/'rust-toolchain.toml').read_text(),'config':(S/'.cargo/config.toml').read_text(),'leanFlags':{k:env[k] for k in ['CARGO_INCREMENTAL','CARGO_PROFILE_DEV_DEBUG','CARGO_PROFILE_TEST_DEBUG']},'target':env['CARGO_TARGET_DIR'],'inputHashes':{p:sha(S/p) for p in ['Cargo.lock','Cargo.toml','rust-toolchain.toml','.cargo/config.toml','rust/python/src/entity_data.rs','rust/python/ifclite_geom.pyi']}})
cmd=['cargo','clippy','--workspace','--all-targets','--','-D','warnings']
print('START exact workspace/all-target clippy',flush=True)
start=time.time()
with (O/'exact-clippy.log').open('wb') as out:r=subprocess.run(cmd,cwd=S,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=7200)
after=check();save('source-after.json',after)
save('result.json',{'head':HEAD,'tree':TREE,'command':cmd,'exitCode':r.returncode,'started':start,'finished':time.time(),'logSha256':sha(O/'exact-clippy.log'),'before':before,'after':after,'scope':'exact workspace clippy only; rust/python excluded by workspace; no tests/wheel/runtime repeated'})
print('END exact clippy',r.returncode,flush=True)
raise SystemExit(r.returncode)
