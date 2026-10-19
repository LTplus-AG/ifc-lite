# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

from pathlib import Path
import subprocess,json,hashlib,statistics,platform
root=Path('/home/louistrue/.t3/worktrees/ifc-lite/t3-f778e361');base=Path('/tmp/ifclite-smlib-base-8acd0715a')
fixtures=['ara3d/AC20-FZK-Haus.ifc','ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc','ara3d/ISSUE_053_20181220Holter_Tower_10.ifc']
runs=[]
binaries={side:str(where/'target/profiling/examples/perf_probe') for side,where in [('base',base),('branch',root)]}
for fixture in fixtures:
 for order,side in enumerate(['base','branch','branch','base']):
  mem=Path(f'/tmp/ifclite-work-rss-{len(runs)}.txt')
  cmd=['/usr/bin/time','-f','%M','-o',str(mem),binaries[side],str(root/'tests/models'/fixture),'--iters','5','--fingerprint','--json']
  r=subprocess.run(cmd,capture_output=True,text=True,check=True)
  probe=json.loads(r.stdout)
  if isinstance(probe,list):probe=probe[0]
  runs.append({'fixture':fixture,'side':side,'order':order,'command':cmd,'maximum_resident_set_kib':int(mem.read_text()),'probe':probe})
 print('Memory ABBA5 complete: '+fixture,flush=True)
summaries=[]
for fixture in fixtures:
 items=[r for r in runs if r['fixture']==fixture]
 assert len({(r['probe']['meshes'],r['probe']['vertices'],r['probe']['triangles']) for r in items})==1
 assert len({h for r in items for h in r['probe']['meshFingerprintsFnv1a64']})==1
 rss={s:statistics.median(r['maximum_resident_set_kib'] for r in items if r['side']==s) for s in ['base','branch']}
 summaries.append({'fixture':fixture,'median_maximum_resident_set_kib':rss,'branch_minus_base_kib':rss['branch']-rss['base'],'geometry_fingerprints_identical':True})
out={'source_manifest':'source-manifest.json','base_commit':'8acd0715a5ad266cd57808b9889f6549fbf93631','platform':platform.platform(),'method':'GNU time process maximum resident set; native whole-worker-pool binary, ABBA, five loads per process; build excluded','binary_sha256':{s:hashlib.sha256(Path(p).read_bytes()).hexdigest() for s,p in binaries.items()},'scope_note':'Observed native process high-water marks on three fixtures only; not heap attribution, browser memory, process limits, retained-plan memory, all-corpus coverage or complete cutover qualification. Shared-host timing is unqualified. Geometry fingerprints omit presentation/occurrence metadata.','summaries':summaries,'runs':runs}
(root/'docs/architecture/evidence/geometry-platform-work/default-path-memory.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(summaries,indent=2))
