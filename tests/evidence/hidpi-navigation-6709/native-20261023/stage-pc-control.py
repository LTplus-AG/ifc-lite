# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Stage one successful PC control build under Pop ordinary admission.

Invoke with the original PC worker job UUID. No compilation occurs here.
The subsequent cohort still freezes and revalidates every served byte.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

out = Path(__file__).parent
pair = json.loads((out / 'source-pair.json').read_text())
job = sys.argv[1]
assert re.fullmatch(r'[0-9a-f-]{36}', job)
root = Path('/home/louistrue/build-workers/worker-state/checkouts') / pair['control']
candidate = root.parent / pair['candidate']
assert not (out / 'pc-control-transfer.json').exists(), 'Recover original staging outcome'
assert not (root / 'apps/viewer/dist/index.html').exists(), 'Do not replace an existing served build'
remote = r'''
import hashlib, io, json, subprocess, sys, tarfile
from pathlib import Path
job = sys.argv[1]
receipt_path = Path('/home/louistrue/build-workers/worker-state/jobs') / job / 'receipt.json'
r = json.loads(receipt_path.read_text())
assert r['state'] == 'completed' and r['exitCode'] == 0 and r['sourceUnchanged']
assert r['sourceBefore'] == r['sourceAfter']
root = Path(r['cwd'])
assert not subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True,timeout=60)
assert subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True,timeout=60).strip() == r['sourceAfter']['commit']
log = receipt_path.with_name('output.log')
assert hashlib.sha256(log.read_bytes()).hexdigest() == r['outputSha256']
command = ' '.join(r['command'])
assert 'pnpm build --filter=@ifc-lite/viewer --concurrency=2' in command
files = sorted(p for p in (root/'apps/viewer/dist').rglob('*') if p.is_file())
assert (root/'apps/viewer/dist/index.html') in files
files += [root/'packages/wasm/pkg'/n for n in ['ifc-lite_bg.wasm','ifc-lite.js','ifc-lite.d.ts']]
assert all(not p.is_symlink() for p in files)
wasm = root/'packages/wasm/pkg/ifc-lite_bg.wasm'
assert wasm.stat().st_mtime >= max(p.stat().st_mtime for p in (root/'rust').rglob('*.rs'))
manifest = {'host':'pc-wsl','receipt':r,'receiptSHA256':hashlib.sha256(receipt_path.read_bytes()).hexdigest(),'artifacts':[{'path':str(p.relative_to(root)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as tar:
 payload=json.dumps(manifest,indent=2).encode(); member=tarfile.TarInfo('build-proof.json');member.size=len(payload);tar.addfile(member,io.BytesIO(payload))
 for p in files:tar.add(p,arcname=str(p.relative_to(root)),recursive=False)
'''
with tempfile.TemporaryDirectory(prefix='control-stage-', dir=out) as scratch:
    archive = Path(scratch) / 'build.tar'
    with archive.open('wb') as target:
        subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                        'ifc-pc-worker', 'python3', '-', job], input=remote.encode(),
                       stdout=target, check=True, timeout=900)
    with tarfile.open(archive) as tar:
        proof = json.load(tar.extractfile('build-proof.json'))
        receipt = proof['receipt']
        assert receipt['id'] == job and receipt['sourceAfter']['commit'] == pair['control']
        rows = {row['path']: row for row in proof['artifacts']}
        names = [m.name for m in tar.getmembers()]
        assert len(names) == len(set(names)) and set(names) == set(rows) | {'build-proof.json'}
        for name, row in rows.items():
            path = Path(name)
            assert not path.is_absolute() and '..' not in path.parts
            assert name.startswith('apps/viewer/dist/') or name in {
                'packages/wasm/pkg/ifc-lite_bg.wasm', 'packages/wasm/pkg/ifc-lite.js',
                'packages/wasm/pkg/ifc-lite.d.ts'}
            member = tar.getmember(name)
            assert member.isfile(), name
            data = tar.extractfile(member).read()
            assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
            if name.startswith('packages/wasm/'):
                assert hashlib.sha256((candidate / name).read_bytes()).hexdigest() == row['sha256'], 'Cross-host WASM runtime differs'
        for name in rows:
            target = root / name
            assert not target.is_symlink() and not any(p.is_symlink() for p in target.parents)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(name).read())
    assert not subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True,timeout=60)
    proof.update(stagedCheckout=str(root), archiveSHA256=hashlib.sha256(archive.read_bytes()).hexdigest())
    (out / 'pc-control-transfer.json').write_text(json.dumps(proof, indent=2) + '\n')
    print('Staged source-pinned PC control:', job, pair['control'], len(rows), 'verified artifacts; identical WASM runtime')
