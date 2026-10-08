#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Verify three immutable containers and reconstruct the final 021 evidence.
No model processing, benchmark, installation, or prior receipt rewriting.
"""
import argparse
import importlib.util
import json
from pathlib import Path, PurePosixPath
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path, help='new directory; must not exist')
    args = parser.parse_args()
    evidence = Path(__file__).resolve().parent
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('prior_extractor', evidence / 'extract-revision.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    manifest = json.loads((evidence / 'final-manifest.json').read_text())
    containers = {}
    for prior in manifest['priorArchives']:
        raw = (evidence / prior['manifestFile']).read_bytes()
        if helper.digest(raw) != prior['manifestSha256']:
            raise ValueError('prior manifest changed')
        records = json.loads(raw)['members']
        stored = {n: r for n, r in records.items()
                  if r.get('storage', 'revision-archive') == 'revision-archive'}
        containers[prior['file']] = helper.verified_archive(
            evidence / prior['file'], prior['bytes'], prior['sha256'], stored)
    stored = {n: r for n, r in manifest['members'].items() if r['storage'] == 'final-archive'}
    current = helper.verified_archive(evidence / manifest['archive'], manifest['archiveBytes'],
                                      manifest['archiveSha256'], stored)
    resolved = {}
    for name, record in manifest['members'].items():
        path = PurePosixPath(name)
        if (path.is_absolute() or '..' in path.parts or '\\' in name
                or str(path) != name or len(path.parts) > 16):
            raise ValueError('unsafe reconstructed path')
        if record['storage'] == 'final-archive':
            data = current[name]
        elif record['storage'] == 'prior-archive-reference':
            data = containers[record['archive']][record['member']]
        else:
            raise ValueError('unknown member storage')
        if len(data) != record['bytes'] or helper.digest(data) != record['sha256']:
            raise ValueError('reference identity mismatch: ' + name)
        resolved[name] = data
    if (len(resolved) != manifest['memberCount'] or len(current) != manifest['storedMemberCount']
            or len(resolved) - len(current) != manifest['referenceMemberCount']):
        raise ValueError('reconstructed census mismatch')
    args.destination.mkdir(parents=True, exist_ok=False)
    for name, data in resolved.items():
        output = args.destination / name
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as stream:
            stream.write(data)
        if helper.digest(output.read_bytes()) != manifest['members'][name]['sha256']:
            raise ValueError('extracted bytes changed')
    print(json.dumps({'status': 'verified-extracted', 'members': len(resolved),
                      'finalStored': len(current), 'priorReferences': len(resolved) - len(current),
                      'artifactMembers': sum(n.startswith('final-021-sdk/artifacts/') for n in resolved),
                      'archiveSha256': manifest['archiveSha256'],
                      'manifestSha256': helper.digest((evidence / 'final-manifest.json').read_bytes())}, indent=2))


if __name__ == '__main__':
    main()
