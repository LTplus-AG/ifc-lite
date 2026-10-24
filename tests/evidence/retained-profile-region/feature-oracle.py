#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955: one independent source-region GREEN / reverse RED / restored GREEN.
Run only in the parent's admitted, isolated validation checkout. Compilation,
skips, zero selected tests and a different failing test never qualify a RED.
"""
import argparse
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--oracle', required=True)
parser.add_argument('--evidence-dir', type=Path, required=True)
args = parser.parse_args()
root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
rows = json.loads((Path(__file__).with_name('mutations.json')).read_text())
row = next(row for row in rows if row['id'] == args.oracle)
subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=root, check=True)
out = args.evidence_dir.resolve()
if out == root or root in out.parents:
    raise SystemExit('Keep immutable execution evidence outside the checkout.')
out.mkdir(parents=True, exist_ok=False)
command = ['cargo', 'test', '--locked', '-p', 'ifc-lite-geometry', '--lib', row['test'], '--', '--exact', '--nocapture']

def test(phase, red=False):
    run = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT)
    (out / (phase + '.log')).write_text(run.stdout)
    print(run.stdout, flush=True)
    if 'SKIP' in run.stdout:
        raise RuntimeError('A skipped source test cannot qualify ' + phase)
    expected = ('test result: FAILED. 0 passed; 1 failed;' if red
                else 'test result: ok. 1 passed; 0 failed;')
    marker = row['test'] + (' ... FAILED' if red else ' ... ok')
    if red and row.get('assertionMarker') and row['assertionMarker'] not in run.stdout:
        raise RuntimeError('Named regression assertion did not fail: ' + row['assertionMarker'])
    if (run.returncode != 0) != red or expected not in run.stdout or marker not in run.stdout:
        raise RuntimeError('Expected the named behavioral ' + phase + '; inspect original log')

test('green')
patch = root / row['patch']
subprocess.run(['git', 'apply', '--reverse', '--check', str(patch)], cwd=root, check=True)
subprocess.run(['git', 'apply', '--reverse', str(patch)], cwd=root, check=True)
try:
    test('red', red=True)
finally:
    subprocess.run(['git', 'apply', str(patch)], cwd=root, check=True)
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=root, check=True)
    test('restored-green')
(out / 'result.json').write_text(json.dumps({
    'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'oracle': row, 'command': command, 'green': True, 'intendedRed': True,
    'restoredGreen': True, 'acceptance': False,
    'review': 'Review the exact failing assertion; no numerical or release qualification implied.'
}, indent=2) + '\n')
