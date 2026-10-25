#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955: named behavioral GREEN / preregistered assertion RED / restored GREEN.
Run inside admitted isolated validation. A failure in setup, compilation, a
wrong assertion, another test or an SDK skip cannot qualify the intended cause.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import subprocess


def verify_test_output(output, returncode, row, red=False):
    """Validate the actual named libtest result and, for RED, its pinned panic."""
    if 'SKIP' in output:
        raise RuntimeError('A skipped SDK test cannot qualify')
    state = 'FAILED' if red else 'ok'
    counts = r'FAILED\. 0 passed; 1 failed;' if red else r'ok\. 1 passed; 0 failed;'
    named = r'^test ' + re.escape(row['test']) + r' \.\.\. ' + state + r'\s*$'
    if ((returncode != 0) != red or not re.search(r'^running 1 test\s*$', output, re.M)
            or not re.search(r'^test result: ' + counts, output, re.M)
            or not re.search(named, output, re.M)):
        raise RuntimeError('Expected exactly the named behavioral test result')
    if not red:
        return
    cause = row['expectedFailure']
    panic = (r"^thread '" + re.escape(row['test']) + r"'(?: \(\d+\))? panicked at "
             + re.escape(cause['file']) + ':' + str(cause['line']) + r':\d+:\n')
    matches = list(re.finditer(panic, output, re.M))
    if len(matches) != 1 or len(re.findall(r"^thread '[^\n]* panicked at ", output, re.M)) != 1:
        raise RuntimeError('RED lacks the single preregistered assertion location')
    block = output[matches[0].end():]
    # Do not borrow the expected cause from another panic or later log section.
    block = re.split(r"\nthread '|\n\nfailures:|\nnote: run", block, maxsplit=1)[0]
    if not all(fragment in block for fragment in cause['fragments']):
        raise RuntimeError('RED is not the preregistered failing assertion/cause')
    measurement = cause.get('measurement')
    if measurement is not None:
        observed = re.search(measurement['pattern'], block)
        value = float(observed['actual']) if observed else float('nan')
        if not math.isfinite(value) or abs(value - measurement['value']) > measurement['tolerance']:
            raise RuntimeError('RED numerical observation differs from the preregistered counterfactual')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--oracle', required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    rows = json.loads(Path(__file__).with_name('mutations.json').read_text())
    row = next(row for row in rows if row['id'] == args.oracle)
    # Source-admission refusals deliberately precede worker acquisition.
    # Numerical rows require the actual SDK; an unset flag always requires it.
    if row.get('requiresSdk', True):
        worker = Path(os.environ['IFCLITE_SMLIB_WORKER'])
        if not worker.is_file() or not os.access(worker, os.X_OK):
            raise SystemExit('Actual SDK executable required; skips cannot qualify.')
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--'], cwd=root, check=True)
    out = args.evidence_dir.resolve()
    if out == root or root in out.parents:
        raise SystemExit('Keep execution evidence outside the checkout.')
    out.mkdir(parents=True, exist_ok=False)
    command = ['cargo', 'test', '--locked', '-p', 'ifc-lite-processing', '--features',
               'retained-native', '--lib', row['test'], '--', '--exact', '--nocapture']

    def test(phase, red=False):
        run = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT)
        (out / (phase + '.log')).write_text(run.stdout)
        print(run.stdout, flush=True)
        verify_test_output(run.stdout, run.returncode, row, red)

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
        'oracle': row, 'command': command, 'green': True,
        'preregisteredAssertionRed': True, 'restoredGreen': True, 'acceptance': False,
        'review': 'Pinned assertion observed; independent numerical/release review remains required.'
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
