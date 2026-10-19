"""Explicit one-off reversible relocation of terminal owned C4 test executables."""
from pathlib import Path
import os,sys,json,stat,hashlib,time,contextlib,fcntl,shutil,subprocess,re,traceback,tarfile,decimal,signal
sys.path.insert(0,'/home/louistrue/build-workers/machine-health')
import retention as retention
from health import STATE,read_json,write_json
D=Path(__file__).resolve().parent;A=D.parent;OLD=A/'c4-owned-intermediate-retirement-pop-v1';W=retention.WORKER
V=json.loads((OLD/'receipt-v3.json').read_text());BASE=json.loads((OLD/'preserved-artifact-identities-before.json').read_text());ROOTS=[Path(x) for x in V['targetAllocatedAfter']]
R={'startedAt':time.time(),'scope':'Only positive Cargo test lib/bin/integration-test fingerprints under3 owned terminal debug/deps; exact bytes relocated into verified standard tar.zst archives','batches':[],'commands':[],'errors':[],'complete':False,'cpuAffinity':sorted(os.sched_getaffinity(0))[:2],'stopFreeBytes':330*2**30,'batchSourceLimitBytes':8*2**30,'originalShaAuthority':str(OLD/'preserved-artifact-identities-before.json'),'originalShaAuthorityVerifiedBy':str(OLD/'receipt-v3.json'),'noBuildTestBenchmarkJob':True}
os.sched_setaffinity(0,R['cpuAffinity']);sourceRoots=[Path(p) for p in V['sourcesAfter']]
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def save():write_json(D/'receipt.json',R)
def snapshot(p):
 s=p.lstat();return {'dev':s.st_dev,'ino':s.st_ino,'bytes':s.st_size,'blocks':s.st_blocks,'mode':s.st_mode,'uid':s.st_uid,'gid':s.st_gid,'nlink':s.st_nlink,'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns}
def metadata_matches(p,v):return snapshot(p)=={k:x for k,x in v.items() if k not in ['sha256','link']}
def overlap(a,b):return retention.inside(a,b) or retention.inside(b,a)
def syncdir(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)
def source(p):
 def git(*a):return subprocess.check_output(['git',*a],cwd=p,text=True).strip()
 return {'head':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'status':git('status','--porcelain')}
def fixtures(p):
 m=p/'tests/models/manifest.json';rows=json.loads(m.read_text())['files'];assert len(rows)==182
 for row in rows:
  f=p/'tests/models'/row['path'];s=f.lstat();assert stat.S_ISREG(s.st_mode) and s.st_size==row['size'] and sha(f)==row['sha256'],str(f)
 return {'count':182,'manifestSha256':sha(m),'allSizeShaMatch':True}
def live_refs():
 import sqlite3
 db=sqlite3.connect(Path('/home/louistrue/.t3/userdata/statev2.sqlite').as_uri()+'?mode=ro',uri=True);found=set()
 try:
  runs=list(db.execute("SELECT run_id FROM orchestration_v2_projection_runs WHERE status IN ('running','preparing','queued','starting','waiting')"))
  for (run,) in runs:
   for table in ['orchestration_v2_projection_messages','orchestration_v2_projection_turn_items']:
    for (payload,) in db.execute(f'SELECT payload_json FROM {table} WHERE run_id=?',(run,)):
     for root in ROOTS:
      prefix=str(root)+'/debug/deps/'
      if prefix in payload:
       found.update(m.group() for m in re.finditer(re.escape(prefix)+r'[A-Za-z0-9_]+-[a-f0-9]{16}(?![A-Za-z0-9_.-])',payload))
 finally:db.close()
 return found

def pinned_paths():
 pins=[Path(p) for p in read_json(STATE/'retention-pins.json',{'paths':[]})['paths']]
 for rec in retention.receipts():
  for p in rec.get('artifacts',{}):pins.append((Path(rec['cwd'])/p).resolve())
 return pins

def guard():
 active=retention.active_jobs();assert not any(x['kind']=='benchmark' for x in active),'benchmark active/queued'
 for root in ROOTS:
  assert not retention.live_processes_using(root),'live target use'
  for x in active:
   paths=json.loads(x['resources']) if isinstance(x['resources'],str) else x['resources'];assert not any(overlap(Path(p),root) for p in paths),'active/queued target use'
 for p,expected in V['sourcesAfter'].items():assert source(Path(p))==expected,'source changed'
 assert shutil.disk_usage(D).free>60*2**30,'archive storage floor'
 for p,v in R['toolsBefore'].items():assert sha(Path(p))==v['sha256'],'maintenance tool changed'
 return {'at':time.time(),'freeBytes':shutil.disk_usage(D).free,'activeJobs':active}

def command(name,argv,stdout=None,stdin=None):
 row={'name':name,'argv':argv,'startedAt':time.time()};R['commands'].append(row);save()
 with (D/'batches'/(name+'.stderr')).open('xb') as err:
  p=subprocess.Popen(argv,stdin=stdin,stdout=stdout if stdout is not None else subprocess.DEVNULL,stderr=err,start_new_session=True)
  row['pid']=p.pid;row['startToken']=Path('/proc',str(p.pid),'stat').read_text().split(') ',1)[1].split()[19]
  try:code=p.wait(timeout=1800)
  except BaseException:
   if p.poll() is None:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=10)
   raise
 row.update(exitCode=code,finishedAt=time.time());save();assert code==0,name+' failed'
 return row

def archive(batch,number):
 root=Path(batch[0]['root']);assert all(x['root']==str(root) for x in batch);name='b'+str(number).zfill(3)+'-'+root.name;out=D/'archives'/(name+'.tar.zst');partial=out.with_suffix(out.suffix+'.partial');manifest=D/'batches'/(name+'.json');nul=D/'batches'/(name+'.members.nul')
 for x in batch:assert metadata_matches(Path(x['path']),x['originalIdentity'])
 b={'id':name,'root':str(root),'archive':str(out),'manifest':str(manifest),'state':'packing_originals_in_place','members':batch,'sourceBytes':sum(x['originalIdentity']['bytes'] for x in batch),'sourceAllocatedBytes':sum(x['originalIdentity']['blocks']*512 for x in batch),'freeBefore':shutil.disk_usage(D).free,'removedPaths':[]};R['batches'].append(b);write_json(manifest,b);save();print('START',name,len(batch),'sourceGiB',round(b['sourceBytes']/2**30,2),flush=True)
 with nul.open('xb') as f:f.write(b''.join(x['member'].encode()+b'\0' for x in batch));f.flush();os.fsync(f.fileno())
 tar_argv=['/usr/bin/tar','--format=pax','--pax-option=delete=atime,delete=ctime','--numeric-owner','--no-recursion','--null','--verbatim-files-from','-C',str(root),'-T',str(nul),'-cf','-']
 with partial.open('xb') as f,(D/'batches'/(name+'.pack-tar.stderr')).open('xb') as terr,(D/'batches'/(name+'.pack-zstd.stderr')).open('xb') as zerr:
  tar=subprocess.Popen(tar_argv,stdout=subprocess.PIPE,stderr=terr,start_new_session=True)
  zstd=subprocess.Popen(['/usr/bin/zstd','-T2','-3','--check','-q','-c'],stdin=tar.stdout,stdout=f,stderr=zerr,start_new_session=True);tar.stdout.close()
  b['packProcesses']=[{'pid':p.pid,'startToken':Path('/proc',str(p.pid),'stat').read_text().split(') ',1)[1].split()[19]} for p in [tar,zstd]];save()
  try:
   zcode=zstd.wait(timeout=1800);tcode=tar.wait(timeout=30);assert zcode==0 and tcode==0,'tar/zstd pack failure'
  finally:
   for p in [tar,zstd]:
    if p.poll() is None:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=10)
  f.flush();os.fsync(f.fileno())
 syncdir(partial.parent);b['packExitCodes']={'tar':tcode,'zstd':zcode};b['archiveBytes']=partial.stat().st_size;b['archiveSha256']=sha(partial);assert b['archiveBytes']<9*2**30,'bounded batch output'
 command(name+'-zstd-integrity',['/usr/bin/zstd','-q','-t',str(partial)])
 with (D/'batches'/(name+'.tar-list.txt')).open('xb') as listing:command(name+'-standard-tar-list',['/usr/bin/tar','--zstd','-tf',str(partial)],stdout=listing)
 names=(D/'batches'/(name+'.tar-list.txt')).read_text().splitlines();assert names==[x['member'] for x in batch],'standard tar member identity/order mismatch'
 expected={x['member']:x for x in batch};verified=[]
 with (D/'batches'/(name+'.verify-zstd.stderr')).open('xb') as err:
  p=subprocess.Popen(['/usr/bin/zstd','-q','-d','-c',str(partial)],stdout=subprocess.PIPE,stderr=err,start_new_session=True)
  try:
   with tarfile.open(fileobj=p.stdout,mode='r|') as tf:
    for m in tf:
     assert m.name in expected and m.name not in verified and m.isfile() and not m.islnk() and not m.issym(),'unexpected archive member'
     x=expected[m.name];v=x['originalIdentity'];assert m.size==v['bytes'] and m.uid==v['uid'] and m.gid==v['gid'] and m.mode==stat.S_IMODE(v['mode']),'archive metadata mismatch'
     mt=int(decimal.Decimal(m.pax_headers.get('mtime',str(m.mtime)))*decimal.Decimal(1000000000));assert mt==v['mtimeNs'],'archive nanosecond mtime mismatch'
     content=tf.extractfile(m);actual=hashlib.file_digest(content,'sha256').hexdigest();assert actual==v['sha256'],'archive member SHA mismatch';verified.append(m.name)
   while p.stdout.read(1024*1024):pass
   assert p.wait(timeout=30)==0,'archive decoder failed'
  finally:
   p.stdout.close()
   if p.poll() is None:os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=10)
 assert len(verified)==len(batch);assert sha(partial)==b['archiveSha256'];b['verifiedMembers']=len(verified);b['allMemberShaAndMetadataMatchOriginal']=True;b['standardTarIntegrityExitCode']=0;b['zstdIntegrityExitCode']=0
 guard();refs=live_refs();pins=pinned_paths()
 for x in batch:
  path=Path(x['path']);assert metadata_matches(path,x['originalIdentity']) and x['path'] not in refs and not any(overlap(path,p) for p in pins),'new in-place pin or original change'
 # Durable complete archive + mapping before any original unlink.
 assert not out.exists();os.rename(partial,out);syncdir(out.parent);b['state']='verified_durable_archive_originals_still_in_place';write_json(manifest,b);save();syncdir(manifest.parent)
 for x in batch:
  path=Path(x['path']);assert metadata_matches(path,x['originalIdentity']) and path.lstat().st_nlink==1;path.unlink();b['removedPaths'].append(x['path'])
 syncdir(root/'debug/deps');b['state']='relocated_losslessly_original_paths_absent';b['freeAfter']=shutil.disk_usage(D).free;b['archiveAllocatedBytes']=out.stat().st_blocks*512;b['netAllocatedBytesRecovered']=b['sourceAllocatedBytes']-b['archiveAllocatedBytes'];b['restoreArgv']=['/usr/bin/tar','--zstd','--extract','--file='+str(out),'--directory='+str(root),'--keep-old-files','--same-permissions','--same-owner','--numeric-owner'];write_json(manifest,b);save();print('DONE',name,'archiveGiB',round(b['archiveBytes']/2**30,2),'freeGiB',round(b['freeAfter']/2**30,2),flush=True)

try:
 with contextlib.ExitStack() as stack:
  for name in ['retention.lock','build-cleanup.lock']:
   f=stack.enter_context((STATE/name).open('a'));fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  for root in ROOTS:stack.enter_context(retention.exclusion(root))
  R['freeBefore']=shutil.disk_usage(D).free;R['v23AuthoritySha256']=sha(OLD/'preserved-artifact-identities-before.json');R['v23ReceiptSha256']=sha(OLD/'receipt-v3.json');R['owners']={};R['fixturesBefore']={str(p):fixtures(p) for p in sourceRoots};R['sourcesBefore']={str(p):source(p) for p in sourceRoots};assert R['sourcesBefore']==V['sourcesAfter']
  R['toolsBefore']={str(p):{'bytes':p.stat().st_size,'sha256':sha(p)} for p in [Path('/usr/bin/tar'),Path('/usr/bin/zstd'),Path(sys.executable).resolve(),Path(retention.__file__),Path('/home/louistrue/build-workers/machine-health/config.json')]};R['guardBefore']=guard();pins=pinned_paths();refs=live_refs();candidates=[];skips={};all_records=retention.receipts()
  for root in ROOTS:
   assert root.resolve()==root and not root.is_symlink() and (root/'CACHEDIR.TAG').read_text().startswith(retention.SIGNATURE)
   owners=retention.owners(root,all_records);expected={x['id'] for x in V['owners'][root.name]};assert {x['id'] for x in owners}==expected
   for x in owners:assert x['kind']=='ordinary' and x['state'] in ['completed','failed'] and time.time()-x['finishedAt']>21600
   R['owners'][str(root)]=[{'id':x['id'],'cwd':x['cwd'],'state':x['state'],'kind':x['kind'],'finishedAt':x['finishedAt']} for x in owners]
   markers={}
   for p in (root/'debug/.fingerprint').glob('*/*.json'):
    m=re.fullmatch(r'test-(lib|bin|integration-test)-(.+)\.json',p.name)
    if m:markers[m.group(2).replace('-','_')+'-'+p.parent.name.rsplit('-',1)[-1]]={'kind':m.group(1),'path':str(p),'sha256':sha(p)}
   for p in (root/'debug/deps').iterdir():
    st=p.lstat()
    if not stat.S_ISREG(st.st_mode) or not st.st_mode&0o111 or p.suffix or p.name not in markers:continue
    reason='multipleLinks' if st.st_nlink!=1 else 'inPlacePin' if str(p) in refs or any(overlap(p,pin) for pin in pins) else None
    old=BASE[str(root)].get(str(p.relative_to(root)))
    if not old or not metadata_matches(p,old):reason='changedOrUnknownV23Identity'
    if reason:skips[reason]=skips.get(reason,0)+1;continue
    assert st.st_uid==os.getuid() and not st.st_mode&(stat.S_ISUID|stat.S_ISGID)
    with p.open('rb') as f:assert f.read(4)==b'\x7fELF','positive test fingerprint must identify ELF executable'
    candidates.append({'path':str(p),'root':str(root),'member':str(p.relative_to(root)),'originalIdentity':old,'testFingerprint':markers[p.name]})
  candidates.sort(key=lambda x:(x['root'],-x['originalIdentity']['bytes'],x['path']));R['eligibleExecutables']=len(candidates);R['eligibleAllocatedBytes']=sum(x['originalIdentity']['blocks']*512 for x in candidates);R['skips']=skips;write_json(D/'eligible-original-identities.json',candidates);save()
  number=0
  while candidates and shutil.disk_usage(D).free<R['stopFreeBytes']:
   guard();current_refs=live_refs();pins=pinned_paths();batch=[];total=0
   while candidates:
    x=candidates[0]
    if batch and (x['root']!=batch[0]['root'] or total+x['originalIdentity']['bytes']>R['batchSourceLimitBytes']):break
    candidates.pop(0);path=Path(x['path'])
    if x['path'] in current_refs or any(overlap(path,p) for p in pins):R.setdefault('latePinnedSkipPaths',[]).append(x['path']);continue
    assert metadata_matches(path,x['originalIdentity']);batch.append(x);total+=x['originalIdentity']['bytes']
   if batch:number+=1;archive(batch,number)
  R['stopReason']='actualFreeAtLeast330GiB' if shutil.disk_usage(D).free>=R['stopFreeBytes'] else 'eligibleSubsetExhausted';R['unprocessedEligibleExecutables']=len(candidates)
  # Explicit relocation map; every other prior preserved path retains identity.
  moved={p for b in R['batches'] for p in b['removedPaths']};checked=0
  for root in ROOTS:
   for rel,v in BASE[str(root)].items():
    p=root/rel
    if str(p) in moved:assert not p.exists();continue
    assert metadata_matches(p,v),str(p);checked+=1
  R['unmovedMetadataIdentitiesMatch']=checked;R['relocatedExecutables']=len(moved);R['fixturesAfter']={str(p):fixtures(p) for p in sourceRoots};R['sourcesAfter']={str(p):source(p) for p in sourceRoots};assert R['fixturesBefore']==R['fixturesAfter'] and R['sourcesBefore']==R['sourcesAfter']
  for p,v in V['evidenceBefore'].items():assert Path(p).stat().st_size==v['bytes'] and sha(Path(p))==v['sha256']
  R['linkedEvidenceHashesMatch']=len(V['evidenceBefore']);R['guardAfter']=guard();R['freeAfter']=shutil.disk_usage(D).free;R['archiveBytes']=sum(b['archiveBytes'] for b in R['batches']);R['originalAllocatedBytesRelocated']=sum(b['sourceAllocatedBytes'] for b in R['batches']);R['netAllocatedBytesRecovered']=sum(b['netAllocatedBytesRecovered'] for b in R['batches']);R['pathsAndInodesUnchanged']=False;R['complete']=True
except BaseException as e:R['errors'].append({'error':repr(e),'traceback':traceback.format_exc()});raise
finally:
 R['finishedAt']=time.time();R['maintenanceOwnershipReleased']=True;save();print(json.dumps({k:R.get(k) for k in ['complete','stopReason','relocatedExecutables','archiveBytes','netAllocatedBytesRecovered','freeAfter','errors','maintenanceOwnershipReleased']}),flush=True)
