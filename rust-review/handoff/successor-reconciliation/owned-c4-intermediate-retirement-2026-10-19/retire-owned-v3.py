"""One authorized C4 maintenance action; no builds, whole targets, or foreign data."""
from pathlib import Path
import os,sys,json,stat,hashlib,time,contextlib,fcntl,shutil,subprocess,re,traceback
sys.path.insert(0,'/home/louistrue/build-workers/machine-health')
import retention as r
from health import STATE,read_json,write_json
D=Path(__file__).resolve().parent;A=D.parent;W=r.WORKER
P=A/'c4-4b-recovery/integration-c24-fresh/native-workspace-prefixes-v6'
OWN={'49926200a29e09a7679b':('r4','12157693a84d9495fafd14a0ade6a5939bf3e0b8'),'899d43786f3f1d14e1ff':('r3','c7cf41e902c20a99a828e952151e981f3cc2d048'),'3a9c872d829495e0751f':('r2','d3e281e1a234f8bca23cd59fb8ddf85926264a2f')}
R={'startedAt':time.time(),'scope':'Only3 owned terminal C4 debug incremental caches and unpinned nonexecutable single-link compiler deps; all other files preserved','removed':[],'errors':[],'complete':False}
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def snap(p):
 s=p.lstat();return {'dev':s.st_dev,'ino':s.st_ino,'bytes':s.st_size,'blocks':s.st_blocks,'mode':s.st_mode,'uid':s.st_uid,'gid':s.st_gid,'nlink':s.st_nlink,'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns}
def save():write_json(D/'receipt-v3.json',R)
def overlaps(a,b):return r.inside(a,b) or r.inside(b,a)
def source(root):
 def g(*a):return subprocess.check_output(['git',*a],cwd=root,text=True).strip()
 return {'head':g('rev-parse','HEAD'),'tree':g('rev-parse','HEAD^{tree}'),'status':g('status','--porcelain')}
def fixtures(root):
 m=root/'tests/models/manifest.json';rows=json.loads(m.read_text())['files'];assert len(rows)==182
 for row in rows:
  p=root/'tests/models'/row['path'];s=p.lstat();assert stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_size==row['size'] and sha(p)==row['sha256'],str(p)
 return {'count':182,'manifestSha256':sha(m),'allSizeShaMatch':True}
def files(root):
 for directory,dirs,names in os.walk(root,followlinks=False):
  for name in sorted(dirs+names):
   p=Path(directory)/name
   if p.is_symlink() or not p.is_dir():yield p
  assert not any((Path(directory)/n).is_mount() for n in dirs),'nested mount'
def allocated(root):
 seen=set();total=0
 for directory,dirs,names in os.walk(root,followlinks=False):
  for p in [Path(directory),*[Path(directory)/n for n in names]]:
   s=p.lstat();key=(s.st_dev,s.st_ino)
   if key not in seen:seen.add(key);total+=s.st_blocks*512
 return total
def check_owners(root,records,pins):
 assert root.parent==r.TARGETS and root.resolve()==root and not root.is_symlink();assert (root/'CACHEDIR.TAG').read_text().startswith(r.SIGNATURE)
 linked=r.owners(root,records);label,commit=OWN[root.name];assert linked
 for x in linked:assert x.get('kind')=='ordinary' and x.get('state') in ['completed','failed'] and Path(x['cwd'])==P/('source-'+label) and time.time()-x.get('finishedAt',time.time())>21600
 active=r.active_jobs();assert not any(x['kind']=='benchmark' for x in active),'benchmark active/queued'
 for x in active:
  paths=json.loads(x['resources']) if isinstance(x['resources'],str) else x['resources'];assert not any(overlaps(Path(p),root) for p in paths),'active target owner'
 assert not r.live_processes_using(root),'live target user'
 return linked
refs=json.loads((D/'evidence-referenced-preserve-paths.json').read_text());explicit=read_json(STATE/'retention-pins.json',{'paths':[]})['paths'];pins=[Path(p) for p in [*refs['preservePaths'],*explicit]]
records=r.receipts()
for rec in records:
 for p in rec.get('artifacts',{}):pins.append((Path(rec['cwd'])/p).resolve())
try:
 with contextlib.ExitStack() as stack:
  # Existing maintenance locks and exact worker target locks; no EX host reservation.
  for name in ['retention.lock','build-cleanup.lock']:
   f=stack.enter_context((STATE/name).open('a'));fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  roots=[r.TARGETS/k for k in OWN]
  for root in roots:stack.enter_context(r.exclusion(root))
  R['freeBefore']=shutil.disk_usage(r.TARGETS).free;R['requiredResumeBytes']=316*2**30;R['activeJobsBefore']=r.active_jobs();R['sourcesBefore']={};R['fixturesBefore']={};R['owners']={};R['targetAllocatedBefore']={};R['maintenanceToolsBefore']=json.loads((D/'maintenance-tools.json').read_text())
  for p,pin in R['maintenanceToolsBefore'].items():assert sha(Path(p))==pin['sha256']
  preserve_evidence={};incremental={};deletes={};metadata={};kept={};hashcache={}
  for root in roots:
   linked=check_owners(root,records,pins);R['owners'][root.name]=[{'id':x['id'],'kind':x['kind'],'state':x['state'],'cwd':x['cwd'],'finishedAt':x['finishedAt']} for x in linked]
   label,commit=OWN[root.name];src=P/('source-'+label);v=source(src);assert v['head']==commit and not v['status'];R['sourcesBefore'][str(src)]=v;R['fixturesBefore'][str(src)]=fixtures(src)
   R['targetAllocatedBefore'][str(root)]=allocated(root)
   for x in linked:
    jp=W/'jobs'/x['id']
    for p in [*(p for p in jp.iterdir() if p.is_file()),*[Path(p) if Path(p).is_absolute() else Path(x['cwd'])/p for p in x.get('artifacts',{})]]:
     assert p.is_file();preserve_evidence[str(p)]={'bytes':p.stat().st_size,'sha256':sha(p)}
   inc=root/'debug/incremental';r.checked_cache(inc);data=r.metadata(inc);assert time.time()-data['latestMtime']>21600
   allowed={'.o','.bc','.rmeta','.lock'}
   assert not any(overlaps(inc,p) for p in pins),'pinned incremental evidence'
   for p in files(inc):
    s=p.lstat();assert stat.S_ISREG(s.st_mode) and not s.st_mode&0o111,'unexpected executable/link in incremental'
    assert p.suffix in allowed or p.name in {'query-cache.bin','dep-graph.bin','work-products.bin','thin-lto-past-keys.bin'},'noncompiler cache member '+str(p)
    if s.st_nlink==1:deletes[str(p)]=snap(p)
   incremental[str(inc)]=data
   for p in (root/'debug/deps').iterdir():
    s=p.lstat()
    if stat.S_ISREG(s.st_mode) and not s.st_mode&0o111 and s.st_nlink==1 and re.fullmatch(r'(?:lib)?[A-Za-z0-9_]+-[a-f0-9]{16}\.(?:rlib|rmeta|d|o|bc)',p.name) and time.time()-s.st_mtime>21600 and not any(overlaps(p,pin) for pin in pins):deletes[str(p)]=snap(p)
   # All retained files, including every executable/library/runtime/profiling file,
   # get content identities; shared hardlink bytes are hashed once.
   kept[str(root)]={}
   for p in files(root):
    if str(p) in deletes:continue
    v=snap(p)
    if p.is_symlink():v['link']=os.readlink(p)
    else:
     assert stat.S_ISREG(v['mode']),'unsupported preserved file type';key=(v['dev'],v['ino'],v['mtimeNs'],v['bytes'])
     if key not in hashcache:hashcache[key]=sha(p)
     v['sha256']=hashcache[key]
    kept[str(root)][str(p.relative_to(root))]=v
   print('PREPARED',root.name,'preserved',len(kept[str(root)]),'incrementalBytes',data['allocatedBytes'],flush=True)
  R['evidenceBefore']=preserve_evidence;R['incrementalCandidates']=incremental;R['compilerFileCandidatesCount']=len(deletes);R['compilerFileAllocatedBytes']=sum(v['blocks']*512 for v in deletes.values());save()
  write_json(D/'preserved-artifact-identities-before.json',kept);write_json(D/'deps-candidate-metadata.json',deletes)
  # Immediate exact metadata, process, pin and ownership recheck before mutations.
  assert json.loads((D/'maintenance-tools.json').read_text())==R['maintenanceToolsBefore']
  assert read_json(STATE/'retention-pins.json',{'paths':[]})['paths']==explicit
  for root in roots:
   check_owners(root,r.receipts(),pins)
   assert r.metadata(root/'debug/incremental')==incremental[str(root/'debug/incremental')]
  for p,v in deletes.items():assert snap(Path(p))==v
  R['intent']='retire only reviewed regenerable intermediates';save()
  assert shutil.rmtree.avoids_symlink_attacks
  for name,v in deletes.items():
   p=Path(name);assert snap(p)==v;p.unlink()
  R['removed'].append({'kind':'only individual single-link debug/incremental and debug/deps compiler intermediates; all linked files retained','files':len(deletes),'allocatedBytes':R['compilerFileAllocatedBytes']});save()
  R['targetAllocatedAfter']={str(root):allocated(root) for root in roots};R['freeAfter']=shutil.disk_usage(r.TARGETS).free
  # Full content verification of every preserved artifact, not executable deletion.
  hashcache={}
  for root in roots:
   for rel,v in kept[str(root)].items():
    p=root/rel;assert all(snap(p)[k]==value for k,value in v.items() if k not in ['sha256','link']),str(p)
    if 'link' in v:assert p.is_symlink() and os.readlink(p)==v['link']
    else:
     key=(v['dev'],v['ino'],v['mtimeNs'],v['bytes'])
     if key not in hashcache:hashcache[key]=sha(p)
     assert hashcache[key]==v['sha256'],str(p)
   expected=set(kept[str(root)]);assert {str(p.relative_to(root)) for p in files(root)}==expected
   print('PRESERVED_SHA_PASS',root.name,len(expected),flush=True)
  for p,v in preserve_evidence.items():assert Path(p).stat().st_size==v['bytes'] and sha(Path(p))==v['sha256']
  R['sourcesAfter']={p:source(Path(p)) for p in R['sourcesBefore']};R['fixturesAfter']={p:fixtures(Path(p)) for p in R['fixturesBefore']};assert R['sourcesAfter']==R['sourcesBefore'] and R['fixturesAfter']==R['fixturesBefore']
  for p,pin in R['maintenanceToolsBefore'].items():assert sha(Path(p))==pin['sha256']
  R['activeJobsAfter']=r.active_jobs();R['liveTargetUsersAfter']={str(root):r.live_processes_using(root) for root in roots};assert not any(R['liveTargetUsersAfter'].values())
  R['preservedFileCount']=sum(len(x) for x in kept.values());R['preservedUniqueContentBytes']=sum(k[3] for k in hashcache);R['preservedContentHashesBeforeAfterMatch']=True;R['evidenceHashesBeforeAfterMatch']=len(preserve_evidence);R['allocatedBytesRemoved']=sum(R['targetAllocatedBefore'].values())-sum(R['targetAllocatedAfter'].values());R['freeSpaceDeltaBytes']=R['freeAfter']-R['freeBefore'];R['remainingResumeDeficitBytes']=max(0,R['requiredResumeBytes']-R['freeAfter']);R['complete']=True
except BaseException as e:
 R['errors'].append({'error':repr(e),'traceback':traceback.format_exc()});raise
finally:
 R['finishedAt']=time.time();R['maintenanceOwnershipReleased']=True;save();print(json.dumps({k:R.get(k) for k in ['complete','allocatedBytesRemoved','freeBefore','freeAfter','remainingResumeDeficitBytes','preservedFileCount','errors','maintenanceOwnershipReleased']}),flush=True)
