# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Repackage the TS-only candidate against the control's exact Rust artifact.

Both full root-Turbo preparations must already pass. Their Rust source/build
inputs and generated JS/types must match. Only the generated runtime is copied;
no generated content is edited. Root Turbo then rebuilds/tests the viewer only,
keeping the already-built upstream packages and shared runtime in place.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

out = Path(__file__).parent
proof_path = out / 'pc-shared-runtime-repack.json'
assert not proof_path.exists(), 'Recover original repack outcome before continuing'
state = Path('/home/louistrue/build-workers/worker-state')
pair = json.loads((out / 'source-pair.json').read_text())
candidate_job, control_job = sys.argv[1:]
assert all(re.fullmatch(r'[0-9a-f-]{36}', job) for job in [candidate_job, control_job])

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, timeout=60).strip()

receipts = {}
for side, job in [('candidate', candidate_job), ('control', control_job)]:
    path = state / 'jobs' / job / 'receipt.json'
    r = json.loads(path.read_text())
    assert r['id'] == job and r['state'] == 'completed' and r['exitCode'] == 0
    assert r['sourceUnchanged'] and r['sourceBefore'] == r['sourceAfter']
    assert sha(path.with_name('output.log')) == r['outputSha256']
    root = Path(r['cwd'])
    assert git(root, 'rev-parse', 'HEAD') == pair[side]
    assert not git(root, 'status', '--porcelain')
    command = ' '.join(r['command'])
    if side == 'candidate':
        assert 'pnpm test --filter=@ifc-lite/viewer' in command and 'TEST_PATTERN=' in command
    else:
        assert 'pnpm build --filter=@ifc-lite/viewer --concurrency=2' in command
    receipts[side] = r
candidate = Path(receipts['candidate']['cwd'])
control = Path(receipts['control']['cwd'])
assert receipts['candidate']['sourceAfter']['toolchainInputs'] == receipts['control']['sourceAfter']['toolchainInputs']
assert not git(candidate, 'diff', pair['candidate'], pair['control'], '--',
               'rust', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
               'scripts/build-wasm.sh', 'packages/wasm'), 'Rust or WASM package inputs differ'
names = ['ifc-lite_bg.wasm', 'ifc-lite.js', 'ifc-lite.d.ts']
canonical = {name: sha(control / 'packages/wasm/pkg' / name) for name in names}
for name in names[1:]:
    assert sha(candidate / 'packages/wasm/pkg' / name) == canonical[name], 'Generated binding surface differs'
assert (control / 'packages/wasm/pkg/ifc-lite_bg.wasm').stat().st_mtime >= max(p.stat().st_mtime for p in (control / 'rust').rglob('*.rs'))
proof = {'state': 'running', 'startedAt': time.time(), 'scriptSHA256': sha(Path(__file__)),
         'preparations': receipts, 'canonicalProducer': control_job, 'canonicalRuntime': canonical,
         'priorCandidateRuntime': {name: sha(candidate / 'packages/wasm/pkg' / name) for name in names},
         'rustAndWasmInputsIdentical': True, 'steps': []}
proof_path.write_text(json.dumps(proof, indent=2) + '\n')
try:
    shutil.copyfile(candidate / 'packages/wasm/pkg/ifc-lite_bg.wasm', out / 'prior-candidate.wasm')
    for name in names:
        shutil.copyfile(control / 'packages/wasm/pkg' / name, candidate / 'packages/wasm/pkg' / name)
    env = os.environ | {'NODE_OPTIONS': '--max-old-space-size=6144',
          'TEST_PATTERN': r'useAnimationLoop[.](capture|capture-async|capture-lifecycle|capture-refusal|renderThrow)[.]test|toolbar/export-ui-ribbon[.]test|useBCF[.](aspect-ratio|clash-viewpoint-selection)[.]test|idsBcfExport[.]test|basketSave[.]selection-race[.]test'}
    for command in [
        ['pnpm', 'build', '--filter=@ifc-lite/viewer', '--only', '--force', '--concurrency=1'],
        ['pnpm', 'test', '--filter=@ifc-lite/viewer', '--only', '--force', '--env-mode=loose', '--concurrency=1'],
    ]:
        print('Root Turbo with previously validated upstreams:', command, flush=True)
        subprocess.run(command, cwd=candidate, env=env, check=True, timeout=600)
        proof['steps'].append({'command': command, 'exitCode': 0})
        proof_path.write_text(json.dumps(proof, indent=2) + '\n')
    for name in names:
        assert sha(candidate / 'packages/wasm/pkg' / name) == canonical[name]
        assert sha(control / 'packages/wasm/pkg' / name) == canonical[name]
    for side, root in [('candidate', candidate), ('control', control)]:
        assert git(root, 'rev-parse', 'HEAD') == pair[side] and not git(root, 'status', '--porcelain')
    proof['state'] = 'completed'
except BaseException as error:
    proof.update(state='failed', error=type(error).__name__ + ': ' + str(error))
    raise
finally:
    proof['finishedAt'] = time.time()
    proof_path.write_text(json.dumps(proof, indent=2) + '\n')
print('Candidate viewer rebuilt/tested against exact control Rust runtime; source unchanged', flush=True)
