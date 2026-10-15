# Evidence-only controller; NEVER MERGE. Run the authoritative ordinary census.
import sys,os,json,subprocess,hashlib,time,pathlib
source,out=map(pathlib.Path,sys.argv[1:3])
def git(*args):return subprocess.check_output(['git',*args],cwd=source).decode().strip()
assert git('rev-parse','HEAD')==os.environ['SOURCE_SHA']
initial=git('diff','--binary','HEAD');assert not initial
commands=[('assert-runnable',['node','scripts/ci-assert-runnable-cargo-tests.mjs','--package','ifc-lite-geometry','--features','triangulation-alt','--test','triangulation_invariance']),('ordinary-census',['cargo','test','-p','ifc-lite-geometry','--features','triangulation-alt','--test','triangulation_invariance','--','--nocapture'])]
summary={'source':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'controller':os.environ['GITHUB_SHA'],'scope':'Authoritative ordinary triangulation-alt census; unchanged expectations/goldens; no ignored-heavy filter or blessing','commands':[],'fixtureManifestSHA256':hashlib.sha256((source/'tests/models/manifest.json').read_bytes()).hexdigest()}
for name,cmd in commands:
 start=time.time()
 with (out/(name+'.stdout')).open('wb') as stdout,(out/(name+'.stderr')).open('wb') as stderr:result=subprocess.run(cmd,cwd=source,env=os.environ.copy(),stdout=stdout,stderr=stderr)
 record={'name':name,'command':cmd,'exitCode':result.returncode,'seconds':time.time()-start};summary['commands'].append(record);summary['sourceUnchanged']=git('diff','--binary','HEAD')==initial
 (out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(record),flush=True)
 if result.returncode and name=='assert-runnable':break
rows=source/'target/watertightness_census.run.tsv'
if rows.exists():
 data=rows.read_bytes();(out/'watertightness_census.run.tsv').write_bytes(data);summary['rows']={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
(out/'summary.json').write_text(json.dumps(summary,indent=2))
assert summary['sourceUnchanged'],'tracked source mutated'
sys.exit(int(any(x['exitCode'] for x in summary['commands'])))
