from pathlib import Path
import json,os,subprocess,time,statistics
root=Path('/home/louistrue/.t3/worktrees/ifc-lite/t3-f778e361')
base=Path('/tmp/ifclite-smlib-base-8acd0715a')
fixtures=['ara3d/AC20-FZK-Haus.ifc','ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc','ara3d/ISSUE_053_20181220Holter_Tower_10.ifc','buildingsmart/annex_e/advanced-geometric-shape/basin-advanced-brep.ifc','buildingsmart/annex_e/advanced-geometric-shape/cube-advanced-brep.ifc','ara3d/duplex.ifc']
runs=[];started=time.time()
for name in fixtures:
    for order,side in enumerate(['base','branch','branch','base']):
        cwd=base if side=='base' else root
        command=['bash','scripts/perf/probe.sh',str(root/'tests/models'/name),'--iters','5','--fingerprint','--json']
        load=os.getloadavg()
        result=subprocess.run(command,cwd=cwd,capture_output=True,text=True,check=True)
        data=json.loads(result.stdout)
        if isinstance(data,list):
            assert len(data)==1
            data=data[0]
        runs.append({'fixture':name,'side':side,'order':order,'command':command,'load_average':load,'probe':data})
    print('Completed ABBA5: '+name,flush=True)
summaries=[]
for name in fixtures:
    items=[r for r in runs if r['fixture']==name]
    counts={(r['probe']['meshes'],r['probe']['vertices'],r['probe']['triangles']) for r in items}
    hashes={h for r in items for h in r['probe']['meshFingerprintsFnv1a64']}
    assert len(counts)==len(hashes)==1
    phases={side:{key:statistics.median(r['probe'][key] for r in items if r['side']==side) for key in ['parseMs','geometryMs','totalMs']} for side in ['base','branch']}
    summaries.append({'fixture':name,'counts':list(next(iter(counts))),'mesh_fingerprint_fnv1a64':next(iter(hashes)),'ordered_mesh_hash_identical':True,'reported_best_run_phase_medians_ms':phases,'phase_deltas_ms':{k:phases['branch'][k]-phases['base'][k] for k in phases['base']}})
out={'base_commit':'8acd0715a5ad266cd57808b9889f6549fbf93631','candidate':'source-manifest.json','method':'ABBA,5 iterations per invocation; native whole-worker-pool; fingerprints computed after timing','timing_verdict':'unqualified shared-host diagnostic; no optimization or latency non-regression claim','timing_qualified':False,'elapsed_seconds':time.time()-started,'summaries':summaries,'runs':runs}
(root/'docs/architecture/evidence/geometry-platform-work/default-path-perf.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(summaries,indent=2))
