#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955: captured SDK triangle GREEN / original slicing RED / restored GREEN.
Run in an isolated admitted checkout. This is numerical replay, not SDK approval.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-dir', type=Path, required=True)
args = parser.parse_args()
root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=root, check=True)
out = args.evidence_dir.resolve()
if out == root or root in out.parents:
    raise SystemExit('Keep execution evidence outside the checkout.')
out.mkdir(parents=True, exist_ok=False)
name = 'issue_7955_captured_sdk_shared_edge_section'
command = ['cargo','test','--locked','-p','ifc-lite-processing','--test','profile_section',name,'--','--exact','--nocapture']
patch = root / 'tests/evidence/profile-section-oracle/section.oracle.patch'
source = root / 'rust/processing/tests/support/profile_section.rs'
original_hash = hashlib.sha256(source.read_bytes()).hexdigest()

def test(phase, red=False):
    run = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, timeout=900)
    (out / (phase + '.log')).write_text(run.stdout)
    print(run.stdout, flush=True)
    summary = ('test result: FAILED. 0 passed; 1 failed;' if red
               else 'test result: ok. 1 passed; 0 failed;')
    marker = name + (' ... FAILED' if red else ' ... ok')
    if run.returncode != (101 if red else 0) or summary not in run.stdout or marker not in run.stdout or 'SKIP' in run.stdout:
        raise RuntimeError('Expected named behavioral ' + phase + '; no compile/timeout/skip acceptance')
    if red and ('REGION_CAPTURED_SHARED_EDGE' not in run.stdout or 'panicked at' not in run.stdout):
        raise RuntimeError('The intended captured shared-edge assertion did not fail')

test('green')
subprocess.run(['git','apply','--reverse','--check',str(patch)], cwd=root, check=True)
subprocess.run(['git','apply','--reverse',str(patch)], cwd=root, check=True)
try:
    test('red', red=True)
finally:
    subprocess.run(['git','apply',str(patch)], cwd=root, check=True)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    subprocess.run(['git','diff','--exit-code','HEAD','--'], cwd=root, check=True)
    test('restored-green')
(out/'result.json').write_text(json.dumps({
    'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
    'command': command, 'sourceSha256': original_hash,
    'green': True, 'intendedRed': True, 'restoredGreen': True, 'acceptance': False,
    'scope': 'Captured four-triangle replay only; actual native and browser SDK remain required.'
},indent=2)+'\n')
