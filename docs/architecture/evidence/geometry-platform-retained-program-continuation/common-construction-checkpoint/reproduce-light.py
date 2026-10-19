#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Reproduce only lightweight source checks; never submit or compile a heavy job.

Run from the checkout: python3 PATH/reproduce-light.py NEW_OUTPUT_DIRECTORY
The directory must not exist. Existing evidence is never overwritten.
"""
from pathlib import Path
import hashlib
import gzip
import json
import subprocess
import sys

package = Path(__file__).resolve().parent
manifest = json.loads((package / 'source-hashes.json').read_text())
output = Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
for row in manifest['files']:
    actual = hashlib.sha256(Path(row['path']).read_bytes()).hexdigest()
    if actual != row['sha256']:
        raise SystemExit(f"source mismatch: {row['path']}")

patch = package / 'owned-paths.patch'
if not patch.exists():
    patch = output / 'owned-paths.patch'
    patch.write_bytes(gzip.decompress((package / 'owned-paths.patch.gz').read_bytes()))
rust = [row['path'] for row in manifest['files'] if row['path'].endswith('.rs')]
commands = [
    ('rust-syntax', ['rustfmt', '--emit', 'stdout', '--config', 'skip_children=true', *rust]),
    ('rust-source-text', ['node', 'scripts/check-rust-source-text-assertions.mjs']),
    ('refwalk', ['node', 'scripts/check-refwalk-guards.mjs']),
    ('license-headers', ['node', 'scripts/add-license-headers.mjs', '--check']),
    ('diff-check', ['git', 'diff', manifest['base_commit'], manifest['source_commit'], '--check']),
    ('patch-reverse-check', ['git', 'apply', '--reverse', '--check', str(patch)]),
]
results = []
for name, command in commands:
    with (output / f'{name}.log').open('w') as log:
        run = subprocess.run(command, stdout=subprocess.DEVNULL if name == 'rust-syntax' else log, stderr=log)
    results.append({'name': name, 'command': command, 'exit_code': run.returncode,
                    'log': f'{name}.log', 'source_commit': manifest['source_commit'],
                    'qualification': 'source-only; no compilation or behavior execution'})
    print(f'{name}: {run.returncode}')
production = [path for path in rust if not (path.endswith('_tests.rs') or Path(path).name == 'tests.rs')]
sizes = {path: len(Path(path).read_text().splitlines()) for path in production}
assert all(size <= 400 for size in sizes.values()), sizes
(output / 'edited-module-lines.json').write_text(json.dumps(sizes, indent=2) + '\n')
(output / 'checks.json').write_text(json.dumps(results, indent=2) + '\n')
