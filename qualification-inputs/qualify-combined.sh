#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
set -Eeuo pipefail
BASE_COMMIT=c53cfaa3a2034638f4c4ab40f7674b29e0528fed
EXPECTED_TREE=323c7c47be86076c438da04d3a7c0f28b4b32b02
EXPECTED_PATCH_SHA=5f750906d0f6b2a56396b7387a4117a2850f6f4f1747c3d3338ba4dd82e67e96
EXPECTED_WASM_TASK=90c398373844d98e
EXPECTED_WASM_SHA=ddce7a28af2d706fe8f601eecbea5f9f2600f68ae42d59093dec995b22338e63
EXPECTED_JS_SHA=04c85b1449d8fee992f25f0685170ff03fb4360726fa4e4d2a2d180314c169c0
EXPECTED_DTS_SHA=e2bf5dee93a6277acee5a814f0bab346ec3c270cbc01bc8a1d0ca75d1c2b65cb
NODE24_DIR=/home/louistrue/.nvm/versions/node/v24.21.0/bin
EXPECTED_FILES=$'apps/viewer/src/components/viewer/PropertiesPanel.tsx\napps/viewer/src/components/viewer/ViewportWelcomeCard.tsx\napps/viewer/src/components/viewer/validation/RuleModelPicker.tsx\napps/viewer/src/lib/commands/modeling/storey-live-frame.test.ts\napps/viewer/src/lib/commands/modeling/workplane.ts'

[[ -n "${IFC_WORKER_ACTIVE_STATE:-}" && -n "${CARGO_TARGET_DIR:-}" ]] || { echo 'fleet admission environment missing'; exit 20; }
[[ -x "$NODE24_DIR/node" && -x "$NODE24_DIR/pnpm" ]] || { echo 'recorded PC Node toolchain missing'; exit 21; }
export PATH="$NODE24_DIR:$PATH"
export NODE_OPTIONS=--max-old-space-size=6144
export CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export RAYON_NUM_THREADS=2 RUST_TEST_THREADS=2 TURBO_CONCURRENCY=1

CANDIDATE_COMMIT=$(git rev-parse HEAD)
ARTIFACT_COMMIT=$(git rev-parse HEAD^1)
[[ "$(git rev-parse "$ARTIFACT_COMMIT^")" == "$BASE_COMMIT" ]] || { echo 'unexpected source artifact ancestry'; exit 22; }
[[ "$(git rev-parse HEAD^{tree})" == "$EXPECTED_TREE" ]] || { echo 'candidate tree pin mismatch'; exit 23; }
git show "$ARTIFACT_COMMIT:qualification-inputs/candidate.json" > "$CARGO_TARGET_DIR/combined-candidate-metadata.json"
python3 - "$CARGO_TARGET_DIR/combined-candidate-metadata.json" <<'PYMETA'
import json,sys
d=json.load(open(sys.argv[1]))
assert d['candidateTree']=='323c7c47be86076c438da04d3a7c0f28b4b32b02'
assert d['diffSha256']=='5f750906d0f6b2a56396b7387a4117a2850f6f4f1747c3d3338ba4dd82e67e96'
PYMETA
[[ -z "$(git status --porcelain)" ]] || { echo 'worker candidate checkout is not clean'; exit 24; }
[[ "$(git diff --name-only "$BASE_COMMIT" "$CANDIDATE_COMMIT")" == "$EXPECTED_FILES" ]] || { echo 'combined diff path set mismatch'; exit 25; }

JOB_ROOT="$CARGO_TARGET_DIR/viewer-combined-qualification"
[[ ! -e "$JOB_ROOT" ]] || { echo "job-private result directory already exists: $JOB_ROOT"; exit 26; }
mkdir -p "$JOB_ROOT/results/base" "$JOB_ROOT/results/candidate" "$JOB_ROOT/logs" "$JOB_ROOT/turbo-cache"
RESULTS="$JOB_ROOT/results"
LOGS="$JOB_ROOT/logs"
export TURBO_CACHE_DIR="$JOB_ROOT/turbo-cache"

python3 - "$PWD" "$CARGO_TARGET_DIR" "$(dirname "$CARGO_TARGET_DIR")" > "$RESULTS/admitted-capacity.json" <<'PY'
import json,os,sys
rows=[]
for path in sys.argv[1:]:
 s=os.statvfs(path); free=s.f_bavail*s.f_frsize; inodes=s.f_favail
 rows.append({'path':path,'availableBytes':free,'availableGiB':round(free/1024**3,2),'freeInodes':inodes})
 if free <= 60*1024**3 or inodes <= 1_000_000: raise SystemExit('admission requires >60 GiB and >1,000,000 free inodes at each owned resource')
print(json.dumps(rows,indent=2))
PY
cat "$RESULTS/admitted-capacity.json"

# Retrieve exactly the three immutable files from the private source-artifact parent.
for name in 90c398373844d98e.tar.zst 90c398373844d98e-manifest.json 90c398373844d98e-meta.json; do
  git show "$ARTIFACT_COMMIT:qualification-inputs/turbo-cache/$name" > "$TURBO_CACHE_DIR/$name"
done
printf '%s  %s\n' \
  589185de6ddd40e56456043ebdfbde6b3ae96e445f359328685e822bddf1b585 "$TURBO_CACHE_DIR/90c398373844d98e.tar.zst" \
  993426d7083b71f6c8d1c747b4b8926e47d02760c3ad13051361a1ebdad9733b "$TURBO_CACHE_DIR/90c398373844d98e-manifest.json" \
  f46a6f497f32eac051e3269884f5450539245fef6ad89e5049d3d8ce4e231eab "$TURBO_CACHE_DIR/90c398373844d98e-meta.json" | sha256sum -c - > "$RESULTS/reused-cache-hashes.txt"

[[ "$(node --version)" == v24.21.0 && "$(pnpm --version)" == 10.8.1 ]] || { echo 'Node/pnpm version mismatch'; exit 27; }
{
 echo "node=$(node --version)"; echo "pnpm=$(pnpm --version)"; rustc --version; cargo --version; wasm-pack --version
} > "$RESULTS/toolchain.txt"

# The PC 7901 target/runtime is deliberately not reused: its Rust sources differ from c53.
# This source-compatible c53 Turbo task output is copied into the job-private cache above.
if [[ ! -f node_modules/.pnpm/lock.yaml ]]; then
 pnpm install --frozen-lockfile --prefer-offline > "$LOGS/install.log" 2>&1
else
 echo 'existing worker checkout dependency marker present' > "$LOGS/install.log"
fi

record_pin() {
 local label=$1
 {
  echo "head=$(git rev-parse HEAD)"
  echo "tree=$(git rev-parse HEAD^{tree})"
  echo 'status=clean'
  for f in rust-toolchain.toml Cargo.lock pnpm-lock.yaml package.json turbo.json rust packages/wasm apps/viewer/package.json; do
   echo "$f=$(git rev-parse "HEAD:$f")"
  done
 } > "$RESULTS/$label-source-pin.txt"
 git status --porcelain > "$RESULTS/$label-status.txt"
 [[ ! -s "$RESULTS/$label-status.txt" ]]
}

assert_wasm_cache_hit() {
 local label=$1
 pnpm exec turbo build --filter=@ifc-lite/viewer --concurrency=1 --env-mode=loose --cache-dir="$TURBO_CACHE_DIR" --dry=json > "$RESULTS/$label-turbo-dryrun.json" 2> "$LOGS/$label-turbo-dryrun.stderr"
 node --input-type=module - "$RESULTS/$label-turbo-dryrun.json" "$EXPECTED_WASM_TASK" "$BASE_COMMIT" > "$RESULTS/$label-wasm-cache-preflight.json" <<'NODE'
import { readFileSync } from 'node:fs';
const d=JSON.parse(readFileSync(process.argv[2],'utf8'));
const t=(d.tasks||[]).find(x=>x.taskId==='@ifc-lite/wasm#build');
if(!t) throw new Error('missing root Turbo @ifc-lite/wasm#build task');
const o={taskId:t.taskId,hash:t.hash,cache:t.cache};
console.log(JSON.stringify(o,null,2));
if(t.hash!==process.argv[3] || t.cache?.status!=='HIT' || t.cache?.sha!==process.argv[4]) process.exit(30);
NODE
}

measure_arm() {
 local label=$1 commit=$2
 [[ "$(git rev-parse HEAD)" == "$commit" ]]
 record_pin "$label"
 if ! pnpm exec turbo build --filter=@ifc-lite/viewer --concurrency=1 --env-mode=loose --cache-dir="$TURBO_CACHE_DIR" > "$LOGS/$label-viewer-build.log" 2>&1; then tail -100 "$LOGS/$label-viewer-build.log"; return 1; fi
 [[ -s apps/viewer/dist/index.html && -s packages/wasm/pkg/ifc-lite_bg.wasm ]]
 sha256sum packages/wasm/pkg/ifc-lite_bg.wasm packages/wasm/pkg/ifc-lite.js packages/wasm/pkg/ifc-lite.d.ts > "$RESULTS/$label-runtime-hashes.txt"
 [[ "$(sha256sum packages/wasm/pkg/ifc-lite_bg.wasm | cut -d' ' -f1)" == "$EXPECTED_WASM_SHA" ]]
 [[ "$(sha256sum packages/wasm/pkg/ifc-lite.js | cut -d' ' -f1)" == "$EXPECTED_JS_SHA" ]]
 [[ "$(sha256sum packages/wasm/pkg/ifc-lite.d.ts | cut -d' ' -f1)" == "$EXPECTED_DTS_SHA" ]]
 node scripts/perf-ratchet/measure-bundle.mjs --wasm packages/wasm/pkg/ifc-lite_bg.wasm --dist apps/viewer/dist --out "$RESULTS/$label/bundle.json" --commit "$commit"
 local gate=0
 node scripts/perf-ratchet/perf-ratchet.mjs check --measured-dir "$RESULTS/$label" --markdown "$RESULTS/$label/perf-ratchet-report.md" > "$LOGS/$label-perf-gate.log" 2>&1 || gate=$?
 echo "$gate" > "$RESULTS/$label-perf-gate-exit.txt"
 node --input-type=module - "$label" "$commit" <<'NODE' > "$RESULTS/$label/assets.json"
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { eagerJsFiles, resolveAsset } from './scripts/perf-ratchet/measure-bundle.mjs';
const label=process.argv[2],commit=process.argv[3],dist='apps/viewer/dist';
const hash=p=>{const b=readFileSync(p);return {bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')}};
const eager=eagerJsFiles(dist,readFileSync(join(dist,'index.html'),'utf8'));
const entry={url:eager.entry,...hash(resolveAsset(dist,eager.entry))};
const eagerJs=eager.files.map(x=>({url:x.url,...hash(x.file)}));
const css=[];function walk(d){for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())walk(p);else if(p.endsWith('.css'))css.push({path:relative(dist,p),...hash(p)})}}
walk(dist);css.sort((a,b)=>a.path.localeCompare(b.path));
const wasm='packages/wasm/pkg/ifc-lite_bg.wasm';
console.log(JSON.stringify({label,commit,entry,eagerJs,eagerJsBytes:eagerJs.reduce((n,x)=>n+x.bytes,0),css,cssBytes:css.reduce((n,x)=>n+x.bytes,0),wasm:{path:wasm,...hash(wasm)}},null,2));
NODE
 [[ -z "$(git status --porcelain)" ]] || { git status --short; return 1; }
}

REFS_BEFORE=$(git show-ref --heads || true)
printf '%s\n' "$REFS_BEFORE" > "$RESULTS/refs-before.txt"
BASE_TREE=$(git rev-parse "$BASE_COMMIT^{tree}")
git switch --detach "$BASE_COMMIT" > "$LOGS/checkout-base.log" 2>&1
[[ "$(git rev-parse HEAD^{tree})" == "$BASE_TREE" && -z "$(git status --porcelain)" ]]
record_pin base
assert_wasm_cache_hit base
measure_arm base "$BASE_COMMIT"

# Return to the exact reviewed five-file source tree; no edits or test mirroring.
git switch --detach "$CANDIDATE_COMMIT" > "$LOGS/checkout-candidate.log" 2>&1
[[ "$(git rev-parse HEAD^{tree})" == "$EXPECTED_TREE" && -z "$(git status --porcelain)" ]]
assert_wasm_cache_hit candidate
measure_arm candidate "$CANDIDATE_COMMIT"

set +e
TEST_PATTERN=storey-live-frame.test pnpm test --filter=@ifc-lite/viewer --concurrency=1 --env-mode=loose > "$LOGS/candidate-storey-test.log" 2>&1
TEST_EXIT=$?
pnpm exec turbo typecheck --filter=@ifc-lite/viewer --concurrency=1 --env-mode=loose > "$LOGS/candidate-viewer-typecheck.log" 2>&1
TYPE_EXIT=$?
pnpm run typecheck:tail > "$LOGS/candidate-typecheck-tail.log" 2>&1
TAIL_EXIT=$?
set -e
printf '%s\n' "$TEST_EXIT" > "$RESULTS/candidate-test-exit.txt"
printf '%s\n' "$TYPE_EXIT" > "$RESULTS/candidate-typecheck-exit.txt"
printf '%s\n' "$TAIL_EXIT" > "$RESULTS/candidate-typecheck-tail-exit.txt"

cp tests/perf-ratchets/bundle.json "$RESULTS/ceilings.json"
python3 - "$RESULTS" "$BASE_COMMIT" "$CANDIDATE_COMMIT" <<'PY'
import json,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]); base=json.loads((p/'base/assets.json').read_text()); cand=json.loads((p/'candidate/assets.json').read_text())
bb=json.loads((p/'base/bundle.json').read_text()); cb=json.loads((p/'candidate/bundle.json').read_text())
c=json.loads((p/'ceilings.json').read_text())
def by(a,k): return {x[k]:x for x in a}
bj,cj=by(base['eagerJs'],'url'),by(cand['eagerJs'],'url'); bc,cc=by(base['css'],'path'),by(cand['css'],'path')
s={'baseCommit':sys.argv[2],'candidateCommit':sys.argv[3],'baseTree':(p/'base-source-pin.txt').read_text().split('tree=')[1].splitlines()[0],
'candidateTree':(p/'candidate-source-pin.txt').read_text().split('tree=')[1].splitlines()[0],
'metrics':{'base':bb,'candidate':cb,'entryDeltaBytes':cand['entry']['bytes']-base['entry']['bytes'],'eagerJsDeltaBytes':cand['eagerJsBytes']-base['eagerJsBytes'],'cssDeltaBytes':cand['cssBytes']-base['cssBytes'],
'wasmBytesIdentical':base['wasm']['bytes']==cand['wasm']['bytes'],'wasmShaIdentical':base['wasm']['sha256']==cand['wasm']['sha256'],
'eagerFileCountBase':len(base['eagerJs']),'eagerFileCountCandidate':len(cand['eagerJs']),'cssFileCountBase':len(base['css']),'cssFileCountCandidate':len(cand['css']),
'changedEagerUrls':sorted(k for k in bj.keys()&cj.keys() if bj[k]['sha256']!=cj[k]['sha256']),'addedEagerUrls':sorted(cj.keys()-bj.keys()),'removedEagerUrls':sorted(bj.keys()-cj.keys()),
'changedCssPaths':sorted(k for k in bc.keys()&cc.keys() if bc[k]['sha256']!=cc[k]['sha256']),'addedCssPaths':sorted(cc.keys()-bc.keys()),'removedCssPaths':sorted(bc.keys()-cc.keys())},
'ratchet':{'ceilings':c,'baseExit':int((p/'base-perf-gate-exit.txt').read_text()),'candidateExit':int((p/'candidate-perf-gate-exit.txt').read_text())},
'focusedTestExit':int((p/'candidate-test-exit.txt').read_text()),'viewerTypecheckExit':int((p/'candidate-typecheck-exit.txt').read_text()),'typecheckTailExit':int((p/'candidate-typecheck-tail-exit.txt').read_text()),
'headRefsUnchanged':(p/'refs-before.txt').read_text()==subprocess.check_output(['git','show-ref','--heads'],text=True)}
(p/'READY.json').write_text(json.dumps(s,indent=2)+'\n'); print(json.dumps(s,indent=2))
PY

git show-ref --heads > "$RESULTS/refs-after.txt"
[[ "$(git rev-parse HEAD)" == "$CANDIDATE_COMMIT" && "$(git rev-parse HEAD^{tree})" == "$EXPECTED_TREE" && -z "$(git status --porcelain)" ]]
[[ "$REFS_BEFORE" == "$(git show-ref --heads || true)" ]]
echo "RESULTS_PATH=$RESULTS"
echo "SOURCE_FINAL=$(git rev-parse HEAD)"
[[ "$TEST_EXIT" == 0 && "$TYPE_EXIT" == 0 && "$TAIL_EXIT" == 0 && "$(cat "$RESULTS/candidate-perf-gate-exit.txt")" == 0 ]]
