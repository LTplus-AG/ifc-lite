# SPDX-License-Identifier: MPL-2.0
import pathlib,subprocess,json,hashlib,platform,time,os,statistics
root=pathlib.Path('/home/louistrue/.t3/worktrees/ifc-lite/t3code-41de0393/tests/models')
out=pathlib.Path('/tmp/ifc-cold-41de/multipart-native');out.mkdir(exist_ok=False)
fixtures=['issues/472_2222.ifc','ara3d/AC20-FZK-Haus.ifc','ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc','ara3d/schependomlaan.ifc','ara3d/ISSUE_053_20181220Holter_Tower_10.ifc','various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc','ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc']
bins={s:pathlib.Path('/tmp/ifc-cold-41de/multipart-probe-'+s) for s in ['base','candidate']}
provenance={'base':'52d30de0ae3fc8ef6322191bd1831483b93d485f','candidate':'52da9ec0e','consumer':'export_usd default options, file read through complete returned USDA; fingerprint after timer; RSS includes untimed fingerprint and teardown','platform':platform.platform(),'os_file_cache':'uncontrolled','binaries':{s:hashlib.sha256(p.read_bytes()).hexdigest() for s,p in bins.items()},'fixtures':{f:hashlib.sha256((root/f).read_bytes()).hexdigest() for f in fixtures}}
(out/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n');rows=[]
for round in range(5):
 for n,f in enumerate(fixtures):
  for side in (['base','candidate'] if (round+n)%2==0 else ['candidate','base']):
   tag=f'{n}-{round}-{side}';rss=out/(tag+'.time');started=time.time()
   p=subprocess.run(['/usr/bin/time','-f','%M','-o',str(rss),str(bins[side]),str(root/f)],capture_output=True,text=True)
   (out/(tag+'.stdout')).write_text(p.stdout);(out/(tag+'.stderr')).write_text(p.stderr)
   row={'fixture':f,'round':round+1,'side':side,'exit':p.returncode,'started_unix':started,'load_average':os.getloadavg()}
   if p.returncode==0:row.update(json.loads(p.stdout));row['maxRssKiB']=int(rss.read_text().strip())
   rows.append(row)
   with (out/'runs.jsonl').open('a') as o:o.write(json.dumps(row)+'\n')
   print(tag,row,flush=True)
   if p.returncode:raise SystemExit('failed sample retained')
summary=[]
for f in fixtures:
 byside={s:[r for r in rows if r['fixture']==f and r['side']==s] for s in bins}
 for side,rs in byside.items():
  assert len({r['outputFnv'] for r in rs})==1,(f,side,'nondeterministic output')
 item={'fixture':f,'output':{s:{k:rs[0][k] for k in ['outputBytes','outputFnv']} for s,rs in byside.items()},'metrics':{}}
 for field in ['fullLoadMs','maxRssKiB']:
  a=[r[field] for r in byside['base']];b=[r[field] for r in byside['candidate']];am=statistics.median(a);bm=statistics.median(b)
  item['metrics'][field]={'base':a,'candidate':b,'medianBase':am,'medianCandidate':bm,'deltaPercent':100*(bm/am-1),'medianPairedRatio':statistics.median([y/x for x,y in zip(a,b)])}
 summary.append(item)
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
