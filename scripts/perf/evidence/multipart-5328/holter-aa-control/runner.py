# SPDX-License-Identifier: MPL-2.0
import pathlib,subprocess,json,time,os,hashlib
out=pathlib.Path('/tmp/ifc-cold-41de/holter-control');out.mkdir(exist_ok=False)
base='/tmp/ifc-cold-41de/decode-probe-base';candidate='/tmp/ifc-cold-41de/multipart-flat-probe-candidate'
fixture='/home/louistrue/.t3/worktrees/ifc-lite/t3code-41de0393/tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc'
(out/'protocol.json').write_text(json.dumps({'purpose':'Investigate Holter time/RSS variability; unchanged binary A/A control alongside multipart flat candidate, not a retry replacing prior cohort','rounds':10,'order':'rotate A,B,C each round','A':base,'B':base,'C':candidate,'hashes':{p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in [base,candidate]}},indent=2)+'\n')
for i in range(10):
 order=['A','B','C'];order=order[i%3:]+order[:i%3]
 for side in order:
  tag=f'{i}-{side}';rss=out/(tag+'.rss');t=time.time()
  p=subprocess.run(['/usr/bin/time','-f','%M','-o',str(rss),base if side in ['A','B'] else candidate,fixture,'--cold','--iters','1','--json','--fingerprint'],capture_output=True,text=True)
  (out/(tag+'.stderr')).write_text(p.stderr);(out/(tag+'.stdout')).write_text(p.stdout)
  row={'round':i,'side':side,'started_unix':t,'exit':p.returncode,'load_average':os.getloadavg()}
  if not p.returncode:row.update(json.loads(p.stdout)[0]);row['maxRssKiB']=int(rss.read_text())
  with (out/'runs.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
  print(tag,row.get('fullLoadWallMs'),row.get('maxRssKiB'),flush=True)
  if p.returncode:raise SystemExit('failed sample retained')
