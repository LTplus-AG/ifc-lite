# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Recover the unique original PC repack, then stage it under Pop admission.

This never submits or retries a PC producer. A failed original is terminal here.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import time

out = Path(__file__).parent
candidate_original, control_original = sys.argv[1:]
assert all(re.fullmatch(r'[0-9a-f-]{36}', x) for x in [candidate_original, control_original])
assert not (out / 'candidate-stage-binding.json').exists(), 'Inspect original staging outcome'
query = r'''
import json,sys
from pathlib import Path
script='/home/louistrue/build-workers/worker-state/storage-tasks/hidpi-6709-candidate-pc-20261024/shared-runtime-repack/repack-pc-candidate.py'
expected=['python3',script,*sys.argv[1:]]
found=[]
for path in Path('/home/louistrue/build-workers/worker-state/jobs').glob('*/receipt.json'):
 r=json.loads(path.read_text())
 if r.get('command')==expected:found.append({k:r.get(k) for k in ['id','state','exitCode','sourceUnchanged']})
assert len(found)<=1, 'Multiple original repack jobs; reconcile receipts before proceeding'
print(json.dumps(found))
'''
end = time.monotonic() + 600
while time.monotonic() < end:
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                             'ifc-pc-worker', 'python3', '-', candidate_original, control_original],
                            input=query, capture_output=True, text=True, check=True, timeout=30)
    found = json.loads(result.stdout)
    if found:
        original = found[0]
        if original['state'] in ['completed', 'failed', 'orphaned']:
            assert original['state'] == 'completed' and original['exitCode'] == 0 and original['sourceUnchanged'], original
            break
    time.sleep(5)
else:
    raise RuntimeError('Original PC repack not qualified within bounded preparation wait; no retry submitted')
command = ['python3', str(out / 'stage-pc-build.py'), 'candidate', original['id']]
subprocess.run(command, check=True, timeout=960)
jobs_path = out / 'preparation-jobs.json'
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
