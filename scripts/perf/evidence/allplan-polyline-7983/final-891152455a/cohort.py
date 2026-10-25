# SPDX-License-Identifier: MPL-2.0
import os,sys,json,time,subprocess,hashlib,resource
from pathlib import Path
root=Path.cwd(); out=Path('/home/louistrue/build-workers/pr8052-final-public'); target=Path(os.environ['CARGO_TARGET_DIR'])
base='a4fc04cf1f1a04ed1ad3cff89b3d32d9c97f8751'; branch='891152455ab75c73341c878c0c55ccde9feece92'
fixture=Path('/home/louistrue/build-workers/ifc-lite/tests/models/ara3d/AC20-FZK-Haus.ifc')
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def put(name,v): (out/name).write_text(json.dumps(v,indent=2)+'\n')
def snap():
 cpu=list(map(int,Path('/proc/stat').read_text().splitlines()[0].split()[1:])); mem={s.split(':')[0]:int(s.split()[1]) for s in Path('/proc/meminfo').read_text().splitlines() if ':' in s}
 cg=Path('/sys/fs/cgroup')/next(s.split(':',2)[2].strip().lstrip('/') for s in Path('/proc/self/cgroup').read_text().splitlines() if s.startswith('0:'))
 return {'time':time.time(),'cpuTicks':cpu,'memAvailableKiB':mem['MemAvailable'],'load':os.getloadavg(),'cgroup':str(cg),'cpuMax':(cg/'cpu.max').read_text() if (cg/'cpu.max').exists() else None,'cpuStat':(cg/'cpu.stat').read_text() if (cg/'cpu.stat').exists() else None,'top':subprocess.check_output(['ps','-eo','pid,ppid,pcpu,pmem,comm','--sort=-pcpu'],text=True).splitlines()[:20]}
for n in ['report.json','idle.json','identity.json','metadata.json','telemetry.json']: put(n,{'state':'not reached'})
(out/'runs.jsonl').write_text(''); (out/'order.txt').write_text('')
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==branch
assert subprocess.check_output(['git','rev-parse','HEAD^2'],text=True).strip()==base
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
meta={'base':base,'branch':branch,'fixture':str(fixture),'fixtureSha256':sha(fixture),'harnessSha256':sha(__file__),'reporterSha256':sha(root/'scripts/perf/ab-report.mjs'),'threading':'unchanged default; no RAYON_NUM_THREADS or affinity override','rounds':5,'policy':'unchanged reporter; 10s whole-host CPU <5%, available memory >=8GiB','environment':{k:os.environ.get(k) for k in ['RAYON_NUM_THREADS','CARGO_BUILD_JOBS','CARGO_TARGET_DIR']},'initialHost':snap()};put('metadata.json',meta)
bins={}
for side,ref in [('branch',branch),('base',base)]:
 dest=target/(side+'-probe'); bins[side]=dest
 subprocess.run(['bash',str(root/'scripts/perf/build-at-ref.sh'),'--ref',ref,'--out',str(dest),'--target-dir',str(target/side),'--worktree-root',str(target/'worktrees')],check=True)
meta['binarySha256']={s:sha(p) for s,p in bins.items()}; assert len(set(meta['binarySha256'].values()))==2
put('metadata.json',meta)
a=snap();time.sleep(10);b=snap(); x=a['cpuTicks']; y=b['cpuTicks']; busy=100*(1-((y[3]+y[4])-(x[3]+x[4]))/(sum(y)-sum(x)))
put('idle.json',{'before':a,'after':b,'cpuBusyPercent':busy,'passed':busy<5 and b['memAvailableKiB']>=8*1024*1024})
assert busy<5 and b['memAvailableKiB']>=8*1024*1024,'Unchanged idle guard refused'
order=subprocess.check_output(['node',str(root/'scripts/perf/ab-order.mjs'),'5'],text=True); (out/'order.txt').write_text(order); assert len(order.splitlines())==5
tele=[]
try:
 for i,line in enumerate(order.splitlines(),1):
  for side in line.split():
   a=snap(); usage=resource.getrusage(resource.RUSAGE_CHILDREN); start=time.monotonic()
   p=subprocess.run([str(bins[side]),str(fixture),'--iters','1','--fingerprint','--json'],capture_output=True,text=True)
   elapsed=time.monotonic()-start; u=resource.getrusage(resource.RUSAGE_CHILDREN); b=snap()
   (out/f'{i}-{side}-stderr.txt').write_text(p.stderr)
   tele.append({'round':i,'side':side,'before':a,'after':b,'processWallSeconds':elapsed,'childUserSeconds':u.ru_utime-usage.ru_utime,'childSystemSeconds':u.ru_stime-usage.ru_stime,'exitCode':p.returncode});put('telemetry.json',tele)
   p.check_returncode(); rows=json.loads(p.stdout); assert len(rows)==1
   with (out/'runs.jsonl').open('a') as f:
    for row in rows: f.write(json.dumps({'side':side,**row})+'\n')
   print('completed',i,side,flush=True)
finally: put('telemetry.json',tele)
subprocess.run(['node',str(root/'scripts/perf/ab-report.mjs'),str(out/'runs.jsonl'),'--base',base,'--branch',branch,'--json',str(out/'report.json')],check=True)
rows=[json.loads(s) for s in (out/'runs.jsonl').read_text().splitlines()]; put('identity.json',{'rows':rows})
meta['finalHost']=snap();put('metadata.json',meta)
