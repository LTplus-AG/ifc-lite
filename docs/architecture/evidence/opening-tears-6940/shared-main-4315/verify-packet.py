# SPDX-License-Identifier: MPL-2.0
"""Verify published containers and selected bytes; no geometry/perf execution."""
from pathlib import Path
import hashlib
import json
import sys
import tarfile


def require(condition, context):
    """Reject an integrity failure even when Python optimization is enabled."""
    if not condition:
        raise ValueError(context)


def checked_bytes(data, record, context):
    """Check both length and SHA256, identifying the failed record."""
    require(len(data) == record['bytes'], f'{context}: byte length differs')
    require(hashlib.sha256(data).hexdigest() == record['sha256'],
            f'{context}: SHA256 differs')
    return data


def unique_paths(paths, context):
    """Reject ambiguous duplicate names before any archive member lookup."""
    seen = set()
    for name in paths:
        require(name not in seen, f'{context}: duplicate path {name!r}')
        seen.add(name)
    return seen


def check_members(archive, records, context):
    """Require an exact, unique member set in the archive and its manifest."""
    expected = unique_paths([r['path'] for r in records], f'{context} records')
    actual = unique_paths(archive.getnames(), f'{context} archive')
    require(actual == expected, f'{context}: member set differs')
    return {member.name: member for member in archive.getmembers()}


def member_bytes(archive, members, name, context):
    """Read only regular file members, never links or directories."""
    member = members[name]
    require(member.isfile(), f'{context}: {name!r} is not a regular file')
    with archive.extractfile(member) as stream:
        return stream.read()


def verify(packet):
    """Verify all published bindings while preserving the original evidence."""
    index = json.loads((packet / 'manifest.json').read_text())
    for field in ['archive', 'auditMetadata']:
        record = index[field]
        checked_bytes((packet / record['path']).read_bytes(), record, record['path'])
    with tarfile.open(packet / index['auditMetadata']['path'], 'r:*') as meta:
        expected = index['auditMetadata']['members']
        meta_members = check_members(meta, expected, 'auditMetadata')
        for record in expected:
            data = member_bytes(meta, meta_members, record['path'], 'auditMetadata')
            checked_bytes(data, record, f'auditMetadata/{record["path"]}')
        record = index['originalMemberManifest']
        require(record['member'] in {r['path'] for r in expected},
                'originalMemberManifest: member is not in auditMetadata records')
        data = member_bytes(meta, meta_members, record['member'], 'originalMemberManifest')
        original = json.loads(checked_bytes(data, record, 'originalMemberManifest'))
    require(original['archive'] == index['archive'], 'original archive binding differs')
    unique_paths([r['path'] for r in original['files']], 'original file records')
    with tarfile.open(packet / index['archive']['path'], 'r:*') as archive:
        rows = [r for r in original['files'] if r['storage'] == 'archive']
        require(len(rows) == index['archive']['members'], 'archive: member count differs')
        evidence_members = check_members(archive, rows, 'execution evidence')
        for record in original['files']:
            if record['storage'] == 'archive':
                data = member_bytes(archive, evidence_members, record['path'], 'execution evidence')
            else:
                require(record['storage'] == 'copy',
                        f'{record["path"]}: unknown storage {record["storage"]!r}')
                data = (packet / record['path']).read_bytes()
            checked_bytes(data, record, record['path'])
    return {'allSelectedBytesVerified': True, 'archiveMembers': len(rows),
            'originalMetadataByteIdentical': True, 'geometryExecution': False}


if __name__ == '__main__':
    try:
        print(json.dumps(verify(Path(sys.argv[1]))))
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        sys.exit(f'Packet verification failed: {error}')
