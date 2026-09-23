# SPDX-License-Identifier: MPL-2.0
# As-run driver; adjust local paths to the two rebuilt binaries and fixture checkout.
import json, subprocess, pathlib, statistics, hashlib, time, platform, os
root=pathlib.Path('/home/louistrue/.t3/worktrees/ifc-lite/t3code-41de0393')
out=pathlib.Path('/tmp/ifc-cold-41de/decode-native')
out.mkdir(exist_ok=False)
fixtures=['issues/472_2222.ifc','ara3d/AC20-FZK-Haus.ifc','ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc','ara3d/schependomlaan.ifc','ara3d/ISSUE_053_20181220Holter_Tower_10.ifc','various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc','ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc']
bins={'base':pathlib.Path('/tmp/ifc-cold-41de/decode-probe-base'),'candidate':pathlib.Path('/tmp/ifc-cold-41de/decode-probe-candidate-compact')}
meta={'candidate':'dafe2d7e36e0be259df0c74ac9fff238b8ec6861','base':'52d30de0ae3fc8ef6322191bd1831483b93d485f','platform':platform.platform(),'cpu_count':os.cpu_count(),'os_file_cache':'uncontrolled','measurement':'fresh process, --cold --iters 1, fullLoadWallMs; RSS includes fingerprint and teardown','binaries':{s:hashlib.sha256(p.read_bytes()).hexdigest() for s,p in bins.items()},'fixtures':{f:hashlib.sha256((root/'tests/models'/f).read_bytes()).hexdigest() for f in fixtures}}
(out/'provenance.json').write_text(json.dumps(meta,indent=2)+'\n')
rows=[]
for r in range(5):
 for n,f in enumerate(fixtures):
  for side in (['base','candidate'] if (r+n)%2==0 else ['candidate','base']):
   tag=f'{n}-{r}-{side}'
   rss=out/(tag+'.time')
   start=time.time()
   p=subprocess.run(['/usr/bin/time','-f','%M','-o',str(rss),str(bins[side]),str(root/'tests/models'/f),'--cold','--iters','1','--json','--fingerprint'],capture_output=True,text=True)
   (out/(tag+'.stderr')).write_text(p.stderr)
   (out/(tag+'.stdout')).write_text(p.stdout)
   row={'fixture':f,'round':r+1,'side':side,'exit':p.returncode,'started_unix':start,'load_average':os.getloadavg()}
   if p.returncode==0:
    row.update(json.loads(p.stdout)[0]); row['path']='tests/models/'+f
    row['maxRssKiB']=int(rss.read_text().strip())
   rows.append(row)
   with (out/'runs.jsonl').open('a') as fp: fp.write(json.dumps(row)+'\n')
   print(f'{tag}: exit={p.returncode} wall={row.get("fullLoadWallMs")}',flush=True)
   if p.returncode: raise SystemExit('failed sample retained')
summary=[]
for f in fixtures:
 byside={s:[r for r in rows if r['fixture']==f and r['side']==s] for s in bins}
 for field in ['meshes','vertices','triangles','csgFailures','degenerateDropped','meshFingerprintsFnv1a64']:
  values={json.dumps(r[field]) for rs in byside.values() for r in rs}
  if len(values)!=1: raise SystemExit(f'OUTPUT CHANGED: {f} {field} {values}')
 item={'fixture':f,'identity':'ordered mesh FNV, counts and diagnostics identical','metrics':{}}
 for field in ['parseMs','geometryMs','totalMs','fullLoadWallMs','maxRssKiB']:
  a=[r[field] for r in byside['base']]; b=[r[field] for r in byside['candidate']]
  am=statistics.median(a); bm=statistics.median(b)
  item['metrics'][field]={'base':a,'candidate':b,'medianBase':am,'medianCandidate':bm,'deltaPercent':100*(bm/am-1) if am else None,'medianPairedRatio':statistics.median([y/x for x,y in zip(a,b) if x]) if any(a) else None}
 summary.append(item)
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
