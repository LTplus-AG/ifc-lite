# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Offline safe extraction and original audit replay; no Git/GPU/models required."""
from pathlib import Path, PurePosixPath
import ast
import contextlib
import hashlib
import io
import json
import tarfile
import tempfile

folder = Path(__file__).resolve().parent
manifest = json.loads((folder / 'manifest.json').read_text())
archive = folder / manifest['archive']['path']
def sha(data): return hashlib.sha256(data).hexdigest()
if archive.stat().st_size != manifest['archive']['bytes'] or sha(archive.read_bytes()) != manifest['archive']['sha256']:
    raise SystemExit('Archive size/hash mismatch')
if int.from_bytes(archive.read_bytes()[4:8], 'little') != 0:
    raise SystemExit('Non-deterministic gzip timestamp')
expected = {r['path']: r for r in manifest['members']}
if len(expected) != len(manifest['members']) or sum(r['bytes'] for r in expected.values()) != manifest['originalBytes']:
    raise SystemExit('Duplicate inventory or original byte-count mismatch')

class FrozenSourceLookup(ast.NodeTransformer):
    """Replace only original Git-byte lookup with its captured literal bytes."""
    def __init__(self): self.edits = 0
    def visit_Call(self, node):
        pattern = "subprocess.check_output(['git', 'show', head + ':' + path], cwd=repo)"
        if ast.dump(node, include_attributes=False) == ast.dump(ast.parse(pattern, mode='eval').body, include_attributes=False):
            self.edits += 1
            return ast.copy_location(ast.parse("(root / 'committed-source' / path).read_bytes()", mode='eval').body, node)
        return self.generic_visit(node)

with tempfile.TemporaryDirectory(prefix='6537-post-timer-replay-') as directory:
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
                raise SystemExit('Archive member size/hash mismatch')
            target = Path(directory) / row.name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    for version in ['v1', 'v2']:
        source = Path(directory) / ('remote-' + version) / 'independent-audit.py'
        original_result = (source.parent / 'independent-qualification.json').read_bytes()
        original_artifacts = (source.parent / 'artifact-hashes.json').read_bytes()
        tree = ast.parse(source.read_text(), filename=str(source))
        substitution = FrozenSourceLookup(); tree = substitution.visit(tree)
        if substitution.edits != 1:
            raise SystemExit('Original audit source lookup changed')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(compile(ast.fix_missing_locations(tree), str(source), 'exec'), {'__file__': str(source), '__name__': '__main__'})
        if (source.parent / 'independent-qualification.json').read_bytes() != original_result:
            raise SystemExit('Replayed qualification differs from retained original')
        if (source.parent / 'artifact-hashes.json').read_bytes() != original_artifacts:
            raise SystemExit('Replayed artifact manifest differs from retained original')
        print(version + ': ' + output.getvalue().strip())
    print('PASS: all original bytes/hashes, safe extraction, exact refused and qualified audits; temporary files removed.')
