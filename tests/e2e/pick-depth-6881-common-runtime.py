# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Rebundle the qualified production viewer with the control's exact engine.

The two hosts produced different WASM bytes from identical Rust inputs. Root
dependency builds must already have succeeded; only the viewer is rebuilt here.
Run under fleet admission with 24 GiB, NODE_OPTIONS=--max-old-space-size=8192
and TURBO_CONCURRENCY=1. No generated file contents are edited.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

root, receipt_path, control_path, proof_path = map(lambda value: Path(value).resolve(), sys.argv[1:])
if proof_path.exists():
    raise RuntimeError('Reconcile the original repack attempt instead of replaying it')
if os.environ.get('NODE_OPTIONS') != '--max-old-space-size=8192' or os.environ.get('TURBO_CONCURRENCY') != '1':
    raise RuntimeError('Qualified Node build environment required')
receipt = json.loads(receipt_path.read_text())
control = json.loads(control_path.read_text())
if receipt['state'] != 'completed' or receipt['exitCode'] != 0 or not receipt['sourceUnchanged'] or receipt['cwd'] != str(root):
    raise RuntimeError('Successful source-matched full root build prerequisite absent')
producer = control['receipt']
if producer['state'] != 'completed' or producer['exitCode'] != 0 or not producer['sourceUnchanged']:
    raise RuntimeError('Canonical engine producer not qualified')

def git(checkout, *args):
    return subprocess.check_output(['git', '-C', str(checkout), *args], text=True, timeout=30).strip()

head = git(root, 'rev-parse', 'HEAD')
if head != receipt['sourceAfter']['commit'] or git(root, 'status', '--porcelain'):
    raise RuntimeError('Production source changed')
inputs = ['rust', '.cargo', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml',
          'scripts/build-wasm.sh', 'scripts/run-build-wasm.mjs', 'packages/wasm']
input_hashes = {name: git(root, 'rev-parse', f'{head}:{name}') for name in inputs}
if any(value != git(root, 'rev-parse', f'{control["head"]}:{name}') for name, value in input_hashes.items()):
    raise RuntimeError('Engine source/build inputs differ between arms')
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
staged = Path(control['buildRoot'])
for row in control['files']:
    if digest(staged/row['path']) != row['sha256']:
        raise RuntimeError('Frozen control artifact changed')
names = ['ifc-lite_bg.wasm', 'ifc-lite.js', 'ifc-lite.d.ts']
if (staged/'packages/wasm/pkg/ifc-lite.d.ts').read_bytes() != (root/'packages/wasm/pkg/ifc-lite.d.ts').read_bytes():
    raise RuntimeError('Committed engine type surfaces differ')
proof = {'state':'started', 'startedAt':time.time(), 'head':head, 'originalBuild':receipt['id'],
         'canonicalProducer':producer['id'], 'engineInputGitObjects':input_hashes,
         'originalRuntime':{name:digest(root/'packages/wasm/pkg'/name) for name in names},
         'canonicalRuntime':{name:digest(staged/'packages/wasm/pkg'/name) for name in names}}
proof_path.parent.mkdir(parents=True, exist_ok=True)
proof_path.write_text(json.dumps(proof,indent=2)+'\n')
try:
    for name in names:
        if name != 'ifc-lite.d.ts':
            shutil.copyfile(staged/'packages/wasm/pkg'/name, root/'packages/wasm/pkg'/name)
    command = ['pnpm','build','--filter=@ifc-lite/viewer','--only','--force','--concurrency=1']
    proof['command'] = command
    result = subprocess.run(command, cwd=root, check=True, timeout=900)
    if git(root, 'rev-parse', 'HEAD') != head or git(root, 'status', '--porcelain'):
        raise RuntimeError('Source changed during repack')
    if any(digest(root/'packages/wasm/pkg'/name) != value for name,value in proof['canonicalRuntime'].items()):
        raise RuntimeError('A build replaced the canonical engine')
    emitted = list((root/'apps/viewer/dist').rglob('*.wasm'))
    if not any(digest(path) == control['wasmSha256'] for path in emitted):
        raise RuntimeError('Served viewer does not contain the exact canonical engine')
    proof.update(state='completed', exitCode=result.returncode)
except BaseException as error:
    proof.update(state='failed', error=type(error).__name__+': '+str(error))
    raise
finally:
    proof['finishedAt'] = time.time()
    proof_path.write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'state':proof['state'], 'head':head, 'canonicalRuntime':proof['canonicalRuntime']}))
