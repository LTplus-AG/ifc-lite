# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import hashlib,json,os,pathlib,subprocess,sys,time
import argparse
p=argparse.ArgumentParser();p.add_argument('--source',type=pathlib.Path,required=True);p.add_argument('--experiment',type=pathlib.Path,required=True);p.add_argument('--expected-commit',required=True);p.add_argument('side',choices=['control','generate','use']);a=p.parse_args()
D=a.experiment.resolve();D.mkdir(exist_ok=True,parents=True);W=a.source.resolve();SIDE=a.side
assert SIDE in ['control','generate','use']
def sha(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
 return h.hexdigest()
def git(*a):return subprocess.check_output(['git',*a],cwd=W,text=True).strip()
assert git('rev-parse','HEAD')==a.expected_commit
assert not git('status','--porcelain')
unexpected={k:v for k,v in os.environ.items() if v and (k.startswith('CARGO_PROFILE_') or k in ['RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS','RUSTUP_TOOLCHAIN','CARGO_BUILD_TARGET','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER'])}; assert not unexpected,unexpected
target=D/('target-'+SIDE);assert not target.exists(); target.mkdir()
flags={'control':'','generate':'-Cprofile-generate='+str(D/'raw')+' -Clink-arg=-Wl,-sectalign,__DATA,__llvm_prf_cnts,0x4000 -Clink-arg=-Wl,-sectalign,__DATA,__llvm_prf_data,0x4000 -Clink-arg=-Wl,-sectalign,__DATA,__llvm_prf_bits,0x4000','use':'-Cprofile-use='+str(D/'merged.profdata')+' -Cllvm-args=-pgo-warn-missing-function'}[SIDE]
if SIDE=='use':assert (D/'merged.profdata').exists()
env=os.environ.copy();env.update(CARGO_TARGET_DIR=str(target),RUSTFLAGS=flags,CARGO_UNSTABLE_BUILD_STD='std,panic_abort')
cmd=['cargo','build','--release','--package','ifc-lite-server','--target','aarch64-apple-darwin']
source={f:sha(W/f) for f in git('ls-files','rust','apps/server','Cargo.toml','Cargo.lock','.cargo/config.toml','rust-toolchain.toml','.github/workflows/server-binaries.yml').splitlines()}
meta={'sourceCommit':git('rev-parse','HEAD'),'sourceTree':git('rev-parse','HEAD^{tree}'),'sourceHashes':source,'command':cmd,'RUSTFLAGS':flags,'CARGO_UNSTABLE_BUILD_STD':'std,panic_abort','features':'default (mimalloc; processing observability)','profile':'release (panic abort)','target':'aarch64-apple-darwin','rustc':subprocess.check_output(['rustc','-Vv'],cwd=W,text=True),'startedUnix':time.time()}
(D/(SIDE+'-attempt.json')).write_text(json.dumps(meta,indent=2))
with (D/(SIDE+'.stdout.log')).open('w') as out,(D/(SIDE+'.stderr.log')).open('w') as err:
 try:r=subprocess.run(cmd,cwd=W,env=env,stdout=out,stderr=err,timeout=1800);meta['exitCode']=r.returncode
 except subprocess.TimeoutExpired:meta['timeout']=True
meta['finishedUnix']=time.time();(D/(SIDE+'-result.json')).write_text(json.dumps(meta,indent=2))
assert meta.get('exitCode')==0
assert all(sha(W/f)==h for f,h in source.items())
binary=target/'aarch64-apple-darwin/release/ifc-lite-server';meta.update(binary=str(binary),binarySha256=sha(binary))
(D/(SIDE+'-provenance.json')).write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps({'binary':str(binary),'sha256':meta['binarySha256'],'seconds':meta['finishedUnix']-meta['startedUnix']}),flush=True)
