# Diagnostic controller only, never merged.
import sys,os,json,subprocess,hashlib,time,pathlib
source,out=map(pathlib.Path,sys.argv[1:])
def git(*args): return subprocess.check_output(['git',*args],cwd=source).decode().strip()
assert git('rev-parse','HEAD')==os.environ['SOURCE_SHA']
initial=git('diff','--binary','HEAD')
assert not initial
commands=[
('manifold-clippy',['cargo','clippy','-p','ifc-lite-geometry','--features','csg_manifold_gate','--all-targets','--','-D','warnings'],{}),
('topology-clippy',['cargo','clippy','-p','ifc-lite-geometry','--features','csg_topology_gate','--all-targets','--','-D','warnings'],{}),
('combined-clippy',['cargo','clippy','-p','ifc-lite-geometry','--features','csg_manifold_gate,csg_topology_gate','--all-targets','--','-D','warnings'],{}),
('all-features-clippy',['cargo','clippy','-p','ifc-lite-geometry','--all-features','--all-targets','--','-D','warnings'],{}),
('manifold-tests',['cargo','test','-p','ifc-lite-geometry','--features','csg_manifold_gate','--no-fail-fast'],{}),
('topology-tests',['cargo','test','-p','ifc-lite-geometry','--features','csg_topology_gate','--no-fail-fast'],{}),
('combined-tests',['cargo','test','-p','ifc-lite-geometry','--features','csg_manifold_gate,csg_topology_gate','--no-fail-fast'],{}),
('capture-tests',['cargo','test','-p','ifc-lite-geometry','--features','csg_capture','--no-fail-fast'],{}),
('opening-counter-tests',['cargo','test','-p','ifc-lite-geometry','--features','opening-perf-trace','--lib','csg::consolidate::ring_ops::tests'],{}),
('opening-diagnostic-tests',['cargo','test','-p','ifc-lite-processing','--features','opening-perf-trace','--example','opening_work_probe'],{}),
('opening-diagnostic-clippy',['cargo','clippy','-p','ifc-lite-processing','--features','opening-perf-trace','--example','opening_work_probe','--','-D','warnings'],{}),
('detached-native',['cargo','test','--manifest-path','rust/csg-thread-bench/Cargo.toml'],{}),
('detached-wasm-plain',['cargo','build','--release','--manifest-path','rust/csg-thread-bench/Cargo.toml','--target','wasm32-unknown-unknown','-Z','build-std=std,panic_abort'],{}),
('detached-wasm-threads',['cargo','build','--release','--manifest-path','rust/csg-thread-bench/Cargo.toml','--target','wasm32-unknown-unknown','--features','threads','-Z','build-std=std,panic_abort'],{'RUSTFLAGS':'-C link-arg=--max-memory=4294967296 -C link-arg=-zstack-size=8388608 -C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base -C link-arg=--export=__heap_base'}),
]
summary={'source':git('rev-parse','HEAD'),'controller':os.environ['GITHUB_SHA'],'scope':'Actual feature contracts and detached Rust consumer compilation, not browser/runtime qualification','commands':[]}
for name,cmd,extra in commands:
    env=dict(os.environ,**extra); start=time.time()
    with (out/(name+'.stdout')).open('wb') as stdout,(out/(name+'.stderr')).open('wb') as stderr:
        result=subprocess.run(cmd,cwd=source,env=env,stdout=stdout,stderr=stderr)
    record={'name':name,'command':cmd,'extraEnvironment':extra,'exitCode':result.returncode,'durationSeconds':time.time()-start}
    summary['commands'].append(record)
    summary['sourceUnchanged']=git('diff','--binary','HEAD')==initial
    (out/'summary.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(record),flush=True)
assert summary['sourceUnchanged'],'tracked tested source mutated'
sys.exit(int(any(x['exitCode'] for x in summary['commands'])))
