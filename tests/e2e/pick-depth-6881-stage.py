# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Stage only an original successful PC viewer build for #6881 native checks.

Run through ordinary local fleet admission. No producer is submitted or retried.
An interrupted destination is inspected, never overwritten by another attempt.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

job, checkout, destination = sys.argv[1:]
# The producer host (an ssh alias) and its worker jobs directory are environment-specific.
host = os.environ.get('IFC_6881_PRODUCER_HOST', 'ifc-pc-worker')
jobs_root = os.environ.get('IFC_6881_PRODUCER_JOBS_ROOT', '/home/louistrue/build-workers/worker-state/jobs')
if not all(c in '0123456789abcdef-' for c in job) or len(job) != 36:
    raise ValueError('Expected original worker job UUID')
source = Path(checkout).resolve()
root = Path(destination).resolve()
if root.exists():
    raise RuntimeError('Destination already exists; reconcile its original transfer')
root.mkdir(parents=True)
remote = r'''
import hashlib, io, json, subprocess, sys, tarfile
from pathlib import Path
p = Path(sys.argv[2]) / sys.argv[1] / 'receipt.json'
r = json.loads(p.read_text())
assert r['state'] == 'completed' and r['exitCode'] == 0 and r['sourceUnchanged']
assert r['sourceBefore'] == r['sourceAfter']
root = Path(r['cwd'])
assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'], text=True).strip() == r['sourceAfter']['commit']
assert not subprocess.check_output(['git','-C',str(root),'status','--porcelain'], text=True)
log = p.with_name('output.log').read_bytes()
assert hashlib.sha256(log).hexdigest() == r['outputSha256']
assert not any(text in log.lower() for text in [b'falling back to the runtime', b'wasm-pack not found'])
files = sorted(q for q in (root/'apps/viewer/dist').rglob('*') if q.is_file())
assert root/'apps/viewer/dist/index.html' in files
files += [root/'packages/wasm/pkg'/name for name in ['ifc-lite_bg.wasm','ifc-lite.js','ifc-lite.d.ts']]
assert all(not q.is_symlink() for q in files)
latest_rust = max(q.stat().st_mtime for q in (root/'rust').rglob('*.rs'))
assert (root/'packages/wasm/pkg/ifc-lite_bg.wasm').stat().st_mtime >= latest_rust
manifest = {'receipt':r, 'receiptSha256':hashlib.sha256(p.read_bytes()).hexdigest(),
 'files':[{'path':str(q.relative_to(root)), 'bytes':q.stat().st_size, 'sha256':hashlib.sha256(q.read_bytes()).hexdigest()} for q in files]}
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:
 payload=json.dumps(manifest,indent=2).encode();item=tarfile.TarInfo('build-proof.json');item.size=len(payload)
 archive.addfile(item,io.BytesIO(payload))
 for q in files:archive.add(q, arcname=str(q.relative_to(root)), recursive=False)
'''
archive_path = root / 'transfer.tar'
with archive_path.open('xb') as output:
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                             '-o', 'ConnectTimeout=10', '-o', 'ForwardAgent=no',
                             # ssh joins these arguments and a remote shell splits them again, so the
                             # jobs root is shell-quoted and '--' stops a host from being read as an option.
                             '--', host, 'python3', '-', job, shlex.quote(jobs_root)], input=remote.encode(),
                            stdout=output, check=True, timeout=900)
with tarfile.open(archive_path) as archive:
    proof = json.load(archive.extractfile('build-proof.json'))
    receipt = proof['receipt']
    if receipt['id'] != job:
        raise RuntimeError('Receipt identity mismatch')
    head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if head != receipt['sourceAfter']['commit'] or subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True):
        raise RuntimeError('Local source does not match the successful producer')
    rows = {row['path']: row for row in proof['files']}
    members = archive.getmembers()
    if len({member.name for member in members}) != len(members) or {m.name for m in members} != set(rows) | {'build-proof.json'}:
        raise RuntimeError('Unexpected or duplicate archive member')
    for member in members:
        if member.name == 'build-proof.json':
            continue
        if not member.isfile() or member.name.startswith('/') or '..' in Path(member.name).parts:
            raise RuntimeError('Unsafe build artifact member')
        data = archive.extractfile(member).read()
        if len(data) != rows[member.name]['bytes'] or hashlib.sha256(data).hexdigest() != rows[member.name]['sha256']:
            raise RuntimeError('Transferred artifact does not match original producer')
        target = root / member.name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
proof.update(checkout=str(source), buildRoot=str(root), head=head,
             wasmSha256=rows['packages/wasm/pkg/ifc-lite_bg.wasm']['sha256'])
(root/'build-proof.json').write_text(json.dumps(proof, indent=2)+'\n')
archive_path.unlink()  # Retain the needed served runtime once, not its tar duplicate.
print(json.dumps({'state':'staged', 'job':job, 'head':head, 'root':str(root), 'files':len(rows), 'wasmSha256':proof['wasmSha256']}))
