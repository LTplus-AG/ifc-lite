#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Replay preserved data/Git audits into new output; no builds or models.
Run extract-final.py first. Repository must contain all three exact Git commits.
Retained scripts stay unchanged; only their input/repository path assignments
are substituted in new scratch copies. The remote filesystem is not recreated.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('extracted', type=Path)
    parser.add_argument('repository', type=Path)
    parser.add_argument('output', type=Path, help='new directory; must not exist')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    raw = (args.extracted / 'final-021-sdk').resolve()
    saved = args.extracted / 'independent-021-qualification'
    replacements = {
        "Path('/tmp/6232-takeover/6537-browser-init-sdk-remote-v3/artifacts/sdk-worker-37155827255-1')":
            'Path(' + repr(str(raw / 'artifacts/sdk-worker-37155827255-1')) + ')',
        "Path('/tmp/6232-takeover/6537-browser-init-sdk-remote-v3/run.json')":
            'Path(' + repr(str(raw / 'run.json')) + ')',
        "repo='/home/louistrue/wt/6537-browser-init-failure-semantics-session6503'":
            'repo=' + repr(str(args.repository.resolve())),
    }
    for name in ['audit.py', 'git-and-wasm-audit.py']:
        source = (saved / name).read_text()
        for old, new in replacements.items():
            source = source.replace(old, new)
        script = args.output / name
        script.write_text(source)
        with (args.output / (name + '.stdout')).open('wb') as out, \
                (args.output / (name + '.stderr')).open('wb') as err:
            subprocess.run(['python3', str(script)], stdout=out, stderr=err,
                           check=True, timeout=90)
    expected = [('qualification.json', 1508), ('git-and-closure-attachment.json', 59242)]
    checks = []
    for name, count in expected:
        actual = json.loads((args.output / name).read_text())
        recorded = json.loads((saved / name).read_text())
        # Only replay-local location/time metadata differs. All gate labels,
        # full diagnostics, statistics, source hashes and pins must remain equal.
        if name == 'qualification.json':
            for key in ['artifactDirectory', 'capturedUTC']:
                actual.pop(key)
                recorded.pop(key)
        if len(actual['checks']) != count or actual['failedChecks']:
            raise ValueError('replayed gate census/status differs: ' + name)
        if actual != recorded:
            raise ValueError('replayed derivation differs: ' + name)
        checks.append({'file': name, 'expectedRecordedChecks': count, 'equal': True})
    (args.output / 'replay.json').write_text(json.dumps({'status': 'equal-replayed-audits',
                                                       'checks': checks}, indent=2) + '\n')
    print('Equal replayed retained-receipt and immutable Git/declared-closure audits.')


if __name__ == '__main__':
    main()
