#!/usr/bin/env python3
import hashlib,json,os,subprocess,statistics
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/home/louistrue/.t3/worktrees/ifc-lite/t3-f778e361')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
pinpath=Path('/tmp/ifclite-context-final-scene-library-pins.json');pins=json.loads(pinpath.read_text())
receipt={'method':'Same System GlobalAlloc instrumentation; process_geometry five loads per fresh process after input read and global Rayon pool initialization; FZK control then Holter, ABBA each. Not latency qualification.','pins_file':str(pinpath),'pins_file_sha256':sha(pinpath),'libraries':pins['libraries'],'compiler':subprocess.check_output(['rustc','-vV'],text=True),'source_files':{p.name:sha(p) for p in HERE.glob('*.rs')},'commands':{},'env':{n:os.environ.get(n) for n in ['RAYON_NUM_THREADS','IFC_LITE_CSG_BUDGET','IFC_LITE_CSG_ELEMENT_BUDGET','IFC_LITE_INSTANCING']},'runs':[]}
for label,libs in receipt['libraries'].items():
    for n,l in libs.items():assert sha(l['path'])==l['sha256'],(label,n)
    deps=Path(libs['ifc_lite_processing']['path']).parent
    rayon=list(deps.glob('librayon-*.rlib'));assert len(rayon)==1,rayon
    libs['rayon']={'path':str(rayon[0]),'bytes':rayon[0].stat().st_size,'sha256':sha(rayon[0])}
    cmd=['rustc','--edition=2021','-C','opt-level=3','-C','panic=abort',str(HERE/'main.rs'),'-L','dependency='+str(deps),'-o',str(HERE/('alloc-'+label))]
    for n,l in libs.items():cmd+=['--extern',n+'='+l['path']]
    receipt['commands'][label]=cmd
    r=subprocess.run(cmd,capture_output=True,text=True);(HERE/(label+'-build.log')).write_text(r.stdout+r.stderr)
    assert r.returncode==0,r.stderr
    receipt[label+'_executable_sha256']=sha(HERE/('alloc-'+label));print(label,'built',flush=True)
(HERE/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
for name,relative in [('fzk','AC20-FZK-Haus.ifc'),('holter','ISSUE_053_20181220Holter_Tower_10.ifc')]:
    fixture=ROOT/'tests/models/ara3d'/relative
    for order,label in enumerate(['base','candidate','candidate','base']):
        stem=name+'-'+str(order)+'-'+label;out=HERE/(stem+'.json');log=HERE/(stem+'.log');rss=HERE/(stem+'-rss.txt')
        cmd=['/usr/bin/time','-f','%M','-o',str(rss),str(HERE/('alloc-'+label)),str(fixture),'5']
        with out.open('w') as o,log.open('w') as e:r=subprocess.run(cmd,stdout=o,stderr=e,timeout=1200)
        assert r.returncode==0,(stem,r.returncode)
        data=json.loads(out.read_text());assert data['allocator_self_check']
        receipt['runs'].append({'fixture':str(fixture),'fixture_sha256':sha(fixture),'label':label,'order':order,'command':cmd,'result':data,'maximum_resident_set_kib':int(rss.read_text()),'artifacts':{p.name:{'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size} for p in [out,log,rss]}})
        (HERE/'running-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(stem,'finished',flush=True)
for name in ['fzk','holter']:
    runs=[r for r in receipt['runs'] if Path(r['fixture']).name.startswith('AC20' if name=='fzk' else 'ISSUE_053')]
    signatures={(r['mesh_count'],r['vertices'],r['triangles'],r['fingerprint']) for run in runs for r in run['result']['records']};assert len(signatures)==1,(name,signatures)
    receipt.setdefault('summaries',{})[name]={'geometry_signature_identical_all20loads':True,'signature':list(next(iter(signatures))),'by_label':{}}
    for label in ['base','candidate']:
        records=[r for run in runs if run['label']==label for r in run['result']['records']]
        metrics={k:statistics.median([r['process_delta'][k] for r in records]) for k in records[0]['process_delta']}
        metrics['peak_live_minus_before']=statistics.median([r['after_process']['peak']-r['before']['live'] for r in records])
        metrics['retained_result_live_delta']=statistics.median([r['after_process']['live']-r['before']['live'] for r in records])
        metrics['after_drop_live_delta']=statistics.median([r['after_result_drop']['live']-r['before']['live'] for r in records])
        receipt['summaries'][name]['by_label'][label]=metrics
for libs in receipt['libraries'].values():
    for n,l in libs.items():assert sha(l['path'])==l['sha256'],n
assert {p.name:sha(p) for p in HERE.glob('*.rs')}==receipt['source_files']
receipt['final_library_and_source_pins_match']=True
receipt['limitations']=['GlobalAlloc/System requested bytes only: allocator arenas, metadata, fragmentation, native malloc, stacks, mmap and GPU/browser memory are outside coverage.','Concurrent atomic snapshots and peak updates are diagnostic observations, not an allocator proof or hard limit. Realloc internal transient old/new coexistence is not observable.','Process counters exclude source read/pool creation but include processing-thread TLS/cache initialization on first load. LIVE/cumulative counters never reset; only PEAK reanchors to baseline at each idle boundary.','Fingerprint runs after process snapshot and excludes text/material definitions/UV/textures/instances; existing separate full-scene correctness evidence is required.','Instrumentation perturbs execution; other shared-host work ran concurrently. RSS is whole-process GNU time high-water, not requested bytes or allocation-site attribution. No latency or causal attribution claim.']
(HERE/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt['summaries'],indent=2),flush=True)
