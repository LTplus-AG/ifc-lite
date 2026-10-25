# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Recover the unique original PC repack, then stage it under Pop admission.

This never submits or retries a PC producer. A failed original is terminal here.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

out = Path(__file__).parent
candidate_original, control_original = sys.argv[1:]
assert all(re.fullmatch(r'[0-9a-f-]{36}', x) for x in [candidate_original, control_original])
assert not (out / 'candidate-stage-binding.json').exists(), 'Inspect original staging outcome'
jobs_path = out / 'preparation-jobs.json'
repack_script = json.loads(jobs_path.read_text())['pcRepackScript']
assert re.fullmatch(r'/home/louistrue/build-workers/worker-state/storage-tasks/[A-Za-z0-9_-]+/shared-runtime-repack/repack-pc-candidate[.]py', repack_script)
query = r'''
import json,sys
from pathlib import Path
script=sys.argv[1]
expected=['python3',script,*sys.argv[2:]]
found=[]
for path in Path('/home/louistrue/build-workers/worker-state/jobs').glob('*/receipt.json'):
 r=json.loads(path.read_text())
 if r.get('command')==expected:found.append({k:r.get(k) for k in ['id','state','exitCode','sourceUnchanged']})
assert len(found)<=1, 'Multiple original repack jobs; reconcile receipts before proceeding'
print(json.dumps(found))
'''
end = time.monotonic() + 600
while time.monotonic() < end:
    try:
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                 'ifc-pc-worker', 'python3', '-', repack_script, candidate_original, control_original],
                                input=query, capture_output=True, text=True,
                                timeout=max(0.001, min(30, end - time.monotonic())))
    except subprocess.TimeoutExpired:
        print('Original receipt query timed out; retrying transport within the existing deadline', file=sys.stderr, flush=True)
        time.sleep(min(5, max(0, end - time.monotonic())))
        continue
    if result.returncode == 255:
        print('Original receipt query SSH transport failed; retrying within the existing deadline', file=sys.stderr, flush=True)
        time.sleep(min(5, max(0, end - time.monotonic())))
        continue
    result.check_returncode()  # Remote assertions remain terminal; no producer is submitted.
    found = json.loads(result.stdout)
    if found:
        original = found[0]
        if original['state'] in ['completed', 'failed', 'orphaned']:
            assert original['state'] == 'completed' and original['exitCode'] == 0 and original['sourceUnchanged'], original
            break
    time.sleep(min(5, max(0, end - time.monotonic())))
else:
    raise RuntimeError('Original PC repack not qualified within bounded preparation wait; no retry submitted')
pair = json.loads((out / 'source-pair.json').read_text())
source = Path('/home/louistrue/build-workers/worker-state/checkouts') / pair['candidate']
command = ['python3', str(out / 'stage-pc-build.py'), 'candidate', original['id']]
subprocess.run(command, check=True, timeout=960)
subprocess.run(['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], cwd=source, check=True, timeout=600)
for name in ['ifc-lite_bg.wasm', 'ifc-lite.js', 'ifc-lite.d.ts']:
    shutil.copyfile(out / 'staged-candidate/packages/wasm/pkg' / name, source / 'packages/wasm/pkg' / name)
plan_command = ['node', '--import', str(source / 'node_modules/tsx/dist/loader.mjs'), str(out / 'qualification.mts'), '--plan']
plan = subprocess.check_output(plan_command, env=os.environ | {'IFC_6709_ROOT': str(source), 'IFC_6709_EVIDENCE': str(out)}, text=True, timeout=60)
assert len(json.loads(plan)) == 20, 'Native harness import/schedule prerequisite failed'
(out / 'node-harness-plan.json').write_text(plan)
jobs = json.loads(jobs_path.read_text())
assert jobs['pcCandidateOriginalProducer'] == candidate_original and jobs['pcBaseProducer'] == control_original
assert jobs.get('pcCandidateProducer') in [None, original['id']]
jobs['pcCandidateProducer'] = original['id']
jobs_path.write_text(json.dumps(jobs, indent=2) + '\n')
(out / 'candidate-stage-binding.json').write_text(json.dumps({
    'pcProducer': original['id'], 'originalCandidate': candidate_original,
    'originalControl': control_original, 'childCommand': command,
}, indent=2) + '\n')
print('Recovered and staged original PC repack', original['id'], flush=True)
