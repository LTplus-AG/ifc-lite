#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Verify the two pinned evidence containers and safely reconstruct this revision.
No model processing, benchmark, tool install, or historical receipt rewriting.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verified_archive(path, expected_bytes, expected_sha, expected_members):
    raw = path.read_bytes()
    if len(raw) != expected_bytes or digest(raw) != expected_sha:
        raise ValueError(f'container identity mismatch: {path.name}')
    records = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if (not member.isfile() or name.is_absolute() or '..' in name.parts
                    or '\\' in member.name or str(name) != member.name
                    or len(name.parts) > 16 or member.name in records):
                raise ValueError(f'unsafe/duplicate member: {member.name}')
            if member.size > 32 * 1024 * 1024 or len(records) >= 3000:
                raise ValueError('member bounds exceeded')
            total += member.size
            if total > 256 * 1024 * 1024:
                raise ValueError('expanded container bounds exceeded')
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError('missing regular member bytes')
            data = stream.read()
            expected = expected_members.get(member.name)
            if expected is None or len(data) != expected['bytes'] or digest(data) != expected['sha256']:
                raise ValueError(f'member identity mismatch: {member.name}')
            records[member.name] = data
    if set(records) != set(expected_members):
        raise ValueError('container census mismatch')
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path, help='new directory; must not exist')
    args = parser.parse_args()
    evidence = Path(__file__).resolve().parent
    revision = json.loads((evidence / 'revision-manifest.json').read_text())
    original = revision['originalArchive']
    original_manifest_bytes = (evidence / original['manifestFile']).read_bytes()
    if digest(original_manifest_bytes) != original['manifestSha256']:
        raise ValueError('original manifest changed')
    original_manifest = json.loads(original_manifest_bytes)
    prior = verified_archive(evidence / original['file'], original['bytes'], original['sha256'],
                             original_manifest['members'])
    stored = {name: rec for name, rec in revision['members'].items()
              if rec['storage'] == 'revision-archive'}
    current = verified_archive(evidence / revision['archive'], revision['archiveBytes'],
                               revision['archiveSha256'], stored)
    resolved = {}
    for name, rec in revision['members'].items():
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name or str(path) != name:
            raise ValueError('unsafe reconstructed path')
        if rec['storage'] == 'revision-archive':
            data = current[name]
        elif rec['storage'] == 'original-archive-reference':
            data = prior[rec['originalMember']]
        else:
            raise ValueError('unknown member storage')
        if len(data) != rec['bytes'] or digest(data) != rec['sha256']:
            raise ValueError(f'reference identity mismatch: {name}')
        resolved[name] = data
    args.destination.mkdir(parents=True, exist_ok=False)
    for name, data in resolved.items():
        output = args.destination / name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
        if digest(output.read_bytes()) != revision['members'][name]['sha256']:
            raise ValueError('extracted bytes changed')
    print(json.dumps({'status': 'verified-extracted', 'members': len(resolved),
                      'revisionStored': len(current), 'originalReferences': len(resolved) - len(current),
                      'sha256': revision['archiveSha256']}, indent=2))


if __name__ == '__main__':
    main()
