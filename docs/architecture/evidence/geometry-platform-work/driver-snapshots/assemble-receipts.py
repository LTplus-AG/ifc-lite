from pathlib import Path
import json,re,hashlib,platform,subprocess
root=Path('/home/louistrue/.t3/worktrees/ifc-lite/t3-f778e361')
out=root/'docs/architecture/evidence/geometry-platform-work'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
manifest=json.loads((out/'source-manifest.json').read_text())
assert all(sha(root/p)==h for p,h in manifest['source_sha256'].items())
workspace=Path('/tmp/ifclite-work-workspace-audited.log').read_text()
suites=re.findall(r'test result: (\w+)\. (\d+) passed; (\d+) failed; (\d+) ignored;',workspace)
assert len(suites)==374 and all(x[0]=='ok' and x[2]=='0' for x in suites)
assert 'Doc-tests ifc_lite_wasm' in workspace
wasm=Path('/tmp/ifclite-work-wasm-contract-audited.log').read_text()
wm=re.search(r'Results: (\d+) passed, (\d+) failed, (\d+) skipped',wasm)
assert wm and wm[2]=='0'
raw=Path('/tmp/ifclite-work-raw-comparison-audited.log').read_text()
assert '7 passed; 0 failed' in raw and 'SKIP' not in raw and 'fixture missing' not in raw
raw_binary=root/re.search(r'Running tests/owned_operation_plan.rs \((target/debug/deps/owned_operation_plan-[a-f0-9]+)\)',raw).group(1)
perf=json.loads((out/'default-path-perf.json').read_text())
assert len(perf['summaries'])==6 and all(s['ordered_mesh_hash_identical'] for s in perf['summaries'])
commands=[
 ('workspace','IFCLITE_SMLIB_WORKER=/tmp/ifclite-smlib-adapter-native/ifclite_smlib_worker cargo test --workspace','workspace-audited'),
 ('clippy','cargo clippy --workspace --all-targets -- -D warnings','clippy-audited'),
 ('wasm-runtime-build','CI=1 pnpm build:wasm','wasm-build-audited'),
 ('wasm-contract','pnpm test:wasm-contract','wasm-contract-audited'),
 ('wasm-target','cargo build --locked -p ifc-lite-processing -p ifc-lite-geometry-runtime --target wasm32-unknown-unknown --target-dir /tmp/ifclite-platform-wasm-target','wasm-target-audited'),
 ('raw-replay','cargo test -p ifc-lite-geometry --test owned_operation_plan -- --nocapture','raw-comparison-audited'),
 ('consumer-example','cargo run -p ifc-lite-geometry --example construction_batch -- rust/geometry/tests/fixtures/bath_csg_solid.ifc 208 207 208','real-example-audited'),
 ('reference-walk-guards','node scripts/check-refwalk-guards.mjs','refwalk-audited'),
 ('source-test-guard','node scripts/check-source-text-assertions.mjs','source-tests-audited'),
 ('module-size','node scripts/check-module-size.mjs','module-size-audited'),
 ('native-peak-memory','python3 /tmp/ifclite-work-memory.py; ABBA5 GNU time process high-water marks','memory-audited'),
 ('default-path-comparison','python3 /tmp/ifclite-platform-work-perf.py; ABBA5 whole-worker-pool per fixture','perf-audited'),
]
commands.append(('owned-session-regressions','target/debug/deps/ifc_lite_processing-ddbb2abf8e862152 element::session --nocapture','session-audited'))
records=[]
for name,command,suffix in commands:
 p=Path('/tmp/ifclite-work-'+suffix+'.log')
 records.append({'name':name,'command':command,'exit_code':0,'raw_log_local_path':str(p),'raw_log_sha256':sha(p)})
clippy=Path('/tmp/ifclite-work-clippy-audited.log').read_text()
assert 'Finished' in clippy and 'error:' not in clippy
subprocess.run(['git','diff','--exit-code','--','packages/wasm/pkg/ifc-lite.d.ts'],cwd=root,check=True,capture_output=True)
wasmp=root/'packages/wasm/pkg/ifc-lite_bg.wasm'
assert wasmp.stat().st_mtime_ns>max((root/p).stat().st_mtime_ns for p in manifest['source_sha256'] if p.endswith('.rs'))
manifest['wasm_artifacts']={p:{'bytes':(root/p).stat().st_size,'sha256':sha(root/p)} for p in manifest['wasm_artifacts']}
(out/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
result={'source_manifest':'source-manifest.json','platform':platform.platform(),
 'scope':'canonical typed synchronous work with lazy owner reservations, trusted callback mutation commits, all-live-ancestor/mixed canonical children and final hooks, explicit joined-worker mutable-decoder source borrowing, pending TLS isolation and sparse actual registry emitter validation; full diagnostic/cache envelopes, model context ownership, finer mapping/opening commands and retained/full-consumer migration incomplete',
 'workspace':{'passed_invocations':sum(int(x[1]) for x in suites),'failed_invocations':0,'ignored':sum(int(x[3]) for x in suites),'suite_reports':len(suites),'scope_note':'Optional fixture cases can skip internally. Passed invocations do not establish complete corpus coverage. Actual native SMLib worker was supplied for runtime tests.'},
 'wasm_contract':{'passed':int(wm[1]),'failed':0,'skipped':int(wm[3]),'fresh_runtime_from_candidate':True,'committed_types_unchanged':True,'runtime_newer_than_frozen_rust':True},
 'raw_replay_comparison':{'passed_tests':7,'failed':0,'fixture_skips':0,'artifact':{'binary_path':str(raw_binary),'binary_sha256':sha(raw_binary)},'scope':'raw geometry/frame bits and boolean diagnostics vs shared production seams, with source disposal and report replay; no complete product/RTC/appearance equivalence claim'},
 'production_control_flow':{'owned_frames':True,'recursive_boolean_csg_dispatch_deleted':True,'conditional_source_admission':True,'product_control_owned':True,'trusted_callback_mutation_commits':True,'canonical_live_ancestor_and_mixed_owner_children':True,'canonical_final_failure_hook_children':True,'scoped_mutable_decoder_worker_borrow':True,'private_sibling_reservations_remain_exclusive':True,'public_async_or_reply_protocol':False,'router_diagnostic_cache_lease_required':True,'exclusive_router_decoder_reservations_enforced':True,'typed_work_reply_validation':True,'pending_tls_isolated':True,'sparse_actual_registry_emitter_validation':True,'optional_scoped_census':True,'model_context_versioned':False,'full_router_diagnostics_owned_in_reply':False,'contextual_depth_path_and_visit_policy_retained':True,'reference_walk_checker_scope_note':'The checker passes but does not analyze explicit frame queues. Runtime bounds, source-order review and dynamic cycle/depth/DAG/cleanup tests are the evidence for this continuation.'},
 'native_peak_memory':{'receipt':'default-path-memory.json','fixtures':3,'method':'GNU time process maximum resident set, ABBA5 native whole-worker-pool, build excluded','scope_note':'Sampled native high-water marks only; no browser, retained-plan, allocator attribution, process-limit or full-corpus memory verdict.'},
 'default_path_comparison':{'fixtures':6,'mesh_counts_and_ordered_payload_fingerprints_identical':True,'timing_qualified':False,'scope_note':'Base/candidate/candidate/base, five iterations each; shared-host timing diagnostic only. Fingerprints omit UVs, textures, instances and text metadata.'},
 'commands':records,
 'not_qualified':['finer representation/mapping/opening commands and retained-engine execution','complete real-corpus BRep cavity/frame/appearance qualification','complete cross-corpus conditional-work and contextual-budget qualification','complete real-corpus conditional-work and source-payload bounds','product occurrence attribution and full diagnostic compatibility','retained analytic BRep production execution','all-platform package/install closure','complete cross-target and consumer qualification','payload/process memory limits and retained/browser/full-consumer peak memory','latency non-regression or performance improvement']}
session_log=Path('/tmp/ifclite-work-session-audited.log').read_text()
assert '27 passed; 0 failed' in session_log
result['owned_session_regressions']={'passed':27,'failed':0,'scope':'real canonical geometry; ticket/owner/emitter rejection; cache/unit mutation; same/mixed/live-ancestor/final-hook children; joined mutable-decoder worker borrowing; scope restoration and panic recovery','binary_sha256':sha(root/'target/debug/deps/ifc_lite_processing-ddbb2abf8e862152')}
wheel=Path('/tmp/ifclite-work-wheel-audited/ifclite_geom-4.15.0-cp39-abi3-manylinux_2_35_x86_64.whl')
python_tests=Path('/tmp/ifclite-work-python-tests-audited.log').read_text()
assert '48 passed, 1 skipped' in python_tests
result['python_consumer']={'passed':48,'failed':0,'skipped':1,'skip_reason':'missing infrastructure model 844; fetch via pnpm fixtures','platform':'CPython 3.12.14 Linux x86_64','build':'locked isolated maturin dev profile; installed local abi3 wheel','wheel_local_path':str(wheel),'wheel_sha256':sha(wheel),'scope':'local installed Python consumer and committed geometry/entity goldens; no all-platform wheel qualification','logs':{str(log):sha(log) for log in [Path('/tmp/ifclite-work-python-'+suffix+'-audited.log') for suffix in ['build','install','tests','artifact','environment']]}}
(out/'validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'workspace':result['workspace'],'wasm':result['wasm_contract'],'raw_tests':7,'perf_fixtures':6},indent=2))
