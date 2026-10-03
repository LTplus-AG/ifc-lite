# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Offline replay; no GPU/model/timing. Requires the qualified commit in Git."""
from pathlib import Path, PurePosixPath
import ast
import contextlib
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile

folder = Path(__file__).resolve().parent
repo = folder.parents[3]
manifest = json.loads((folder / 'manifest.json').read_text())
archive = folder / manifest['archive']['path']
def sha(data):
    return hashlib.sha256(data).hexdigest()
if sha(archive.read_bytes()) != manifest['archive']['sha256']:
    raise SystemExit('Archive SHA256 mismatch')
expected = {r['path']: r for r in manifest['members']}
with tempfile.TemporaryDirectory(prefix='6537-symbolic-replay-') as directory:
    with tarfile.open(archive, 'r:gz') as stream:
        rows = stream.getmembers()
        if len(rows) != len(expected) or {r.name for r in rows} != set(expected):
            raise SystemExit('Archive member inventory mismatch')
        for row in rows:
            name = PurePosixPath(row.name)
            if not row.isfile() or name.is_absolute() or '..' in name.parts:
                raise SystemExit('Unsafe archive member')
            data = stream.extractfile(row).read()
            if len(data) != expected[row.name]['bytes'] or sha(data) != expected[row.name]['sha256']:
                raise SystemExit('Archive member bytes/hash mismatch')
            target = Path(directory) / row.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    source = Path(directory) / 'remote/independent-audit.py'
    original = (source.parent / 'independent-qualification.json').read_bytes()
    tree = ast.parse(source.read_text(), filename=str(source))
    edits = 0
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name) and node.targets[0].id == 'repo':
            node.value = ast.Constant(str(repo)); edits += 1
    if edits != 1:
        raise SystemExit('Original audit repository selection changed')
    subprocess.run(['git', 'cat-file', '-e', manifest['sourceHead']], cwd=repo, check=True)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exec(compile(ast.fix_missing_locations(tree), str(source), 'exec'), {'__file__': str(source), '__name__': '__main__'})
    if (source.parent / 'independent-qualification.json').read_bytes() != original:
        raise SystemExit('Replayed audit differs from retained original')
    print(output.getvalue(), end='')
    print('PASS: safe extraction, all original hashes, exact audit replay; temporary files removed on exit.')
