#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

import hashlib,json,os,subprocess,statistics
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path('/home/louistrue/.t3/worktrees/ifc-lite/t3-f778e361')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
pinpath=Path('/tmp/ifclite-context-final-scene-library-pins.json');pins=json.loads(pinpath.read_text())
receipt={'method':'Same bounded System GlobalAlloc stack sampler; successful allocation/reallocation modulo2048, only while process_geometry runs; Holter ABBA2loads per process after source read, pool and backtrace warmup. Not latency/RSS qualification.','pins_file':str(pinpath),'pins_file_sha256':sha(pinpath),'libraries':pins['libraries'],'compiler':subprocess.check_output(['rustc','-vV'],text=True),'source_files':{p.name:sha(p) for p in HERE.glob('*.rs')},'commands':{},'env':{n:os.environ.get(n) for n in ['RAYON_NUM_THREADS','IFC_LITE_CSG_BUDGET','IFC_LITE_CSG_ELEMENT_BUDGET','IFC_LITE_INSTANCING']},'runs':[]}
for label,libs in receipt['libraries'].items():
    for n,l in libs.items():assert sha(l['path'])==l['sha256'],(label,n)
    deps=Path(libs['ifc_lite_processing']['path']).parent
    rayon=list(deps.glob('librayon-*.rlib'));assert len(rayon)==1,rayon
    libs['rayon']={'path':str(rayon[0]),'bytes':rayon[0].stat().st_size,'sha256':sha(rayon[0])}
    cmd=['rustc','--edition=2021','-C','opt-level=3','-C','panic=abort','-C','force-frame-pointers=yes','-C','relocation-model=static','-C','link-arg=-no-pie',str(HERE/'main.rs'),'-L','dependency='+str(deps),'-o',str(HERE/('alloc-'+label))]
    for n,l in libs.items():cmd+=['--extern',n+'='+l['path']]
    receipt['commands'][label]=cmd
    r=subprocess.run(cmd,capture_output=True,text=True);(HERE/(label+'-build.log')).write_text(r.stdout+r.stderr)
    assert r.returncode==0,r.stderr
    receipt[label+'_executable_sha256']=sha(HERE/('alloc-'+label));print(label,'built',flush=True)
(HERE/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
for order,label in enumerate(['base','candidate','candidate','base']):
    fixture=ROOT/'tests/models/ara3d/ISSUE_053_20181220Holter_Tower_10.ifc'
    stem=str(order)+'-'+label;out=HERE/(stem+'.json');log=HERE/(stem+'.log')
    cmd=[str(HERE/('alloc-'+label)),str(fixture),'2']
    with out.open('w') as o,log.open('w') as e:r=subprocess.run(cmd,stdout=o,stderr=e,timeout=1200)
    assert r.returncode==0,(stem,r.returncode)
    data=json.loads(out.read_text());assert data['sampler_probe_verified']
    receipt['runs'].append({'fixture':str(fixture),'fixture_sha256':sha(fixture),'label':label,'order':order,'command':cmd,'data_file':str(out),'traces':len(data['traces']),'dropped':data['dropped'],'truncated':sum(t['truncated'] for t in data['traces']),'reentrant_excluded':data['reentrant_excluded'],'iterations':data['iterations'],'artifacts':{p.name:{'path':str(p),'sha256':sha(p),'bytes':p.stat().st_size} for p in [out,log]}})
    (HERE/'running-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(stem,'finished',len(data['traces']),'samples',flush=True)
signatures={(x['meshes'],x['vertices'],x['triangles'],x['fingerprint']) for r in receipt['runs'] for x in r['iterations']};assert len(signatures)==1,signatures
receipt['identical_geometry_signature_all8loads']=list(next(iter(signatures)))
for libs in receipt['libraries'].values():
    for n,l in libs.items():assert sha(l['path'])==l['sha256'],n
assert {p.name:sha(p) for p in HERE.glob('*.rs')}==receipt['source_files']
receipt['final_library_and_source_pins_match']=True
(HERE/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print('sampling runs complete',flush=True)
