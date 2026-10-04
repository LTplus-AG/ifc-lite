#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Verify/reconstruct retained data only; never execute archived code."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import tarfile
import zipfile

MAX_MEMBERS = 2000
MAX_MEMBER = 128 * 1024**2
MAX_TOTAL = 256 * 1024**2


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe(name):
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or '..' in path.parts or '\\' in name
            or str(path) != name or len(path.parts) > 20 or len(name) > 4096):
        raise ValueError('unsafe member path: ' + name)
    return path


def verified_members(packet_directory=None):
    here = Path(packet_directory).resolve() if packet_directory is not None else Path(__file__).resolve().parent
    index = json.loads((here / 'cohort-index.json').read_text())
    archive_path = here.joinpath(*safe(index['archive']).parts)
    if archive_path.stat().st_size > MAX_MEMBER:
        raise ValueError('compressed archive bound')
    archive = archive_path.read_bytes()
    if len(archive) != index['archiveBytes'] or digest(archive) != index['archiveSha256']:
        raise ValueError('container differs')
    manifest_storage = index.get('manifestStorage', 'external')
    if manifest_storage not in ('external', 'tar'):
        raise ValueError('unknown manifest storage')
    stored = {}; total = 0
    with gzip.GzipFile(fileobj=io.BytesIO(archive)) as stream:
        uncompressed = stream.read(MAX_TOTAL + 4 * 1024**2 + 1)
    if len(uncompressed) > MAX_TOTAL + 4 * 1024**2:
        raise ValueError('uncompressed TAR/header bound')
    with tarfile.open(fileobj=io.BytesIO(uncompressed), mode='r:') as tar:
        for item in tar:
            safe(item.name); total += item.size
            if (not item.isfile() or item.name in stored or item.size > MAX_MEMBER
                    or total > MAX_TOTAL or len(stored) >= MAX_MEMBERS):
                raise ValueError('unsafe/unknown/duplicate TAR member')
            stored[item.name] = tar.extractfile(item).read()
    if manifest_storage == 'tar':
        manifest_name = str(safe(index['manifest']))
        if manifest_name not in stored or len(stored[manifest_name]) > 4 * 1024**2:
            raise ValueError('missing/oversized internal manifest')
        manifest_bytes = stored.pop(manifest_name)
    else:
        manifest_bytes = (here / 'cohort-manifest.json').read_bytes()
    if digest(manifest_bytes) != index['manifestSha256']:
        raise ValueError('manifest differs')
    rows = json.loads(manifest_bytes)['members']
    expected = {r['path']: r for r in rows}
    if len(expected) != len(rows) or len(rows) != index['logicalMemberCount'] or len(rows) > MAX_MEMBERS:
        raise ValueError('manifest census differs')
    if sum(r['bytes'] for r in rows) > MAX_TOTAL:
        raise ValueError('logical total bound')
    for row in rows:
        safe(row['path'])
        if not 0 <= row['bytes'] <= MAX_MEMBER:
            raise ValueError('member size bound')
    if set(stored) != {r['path'] for r in rows if r['storage'] == 'tar'}:
        raise ValueError('stored member census differs')
    decoded = {}
    for container in {r['container'] for r in rows if r['storage'] == 'zip-reference'}:
        safe(container)
        if container not in stored:
            raise ValueError('missing ZIP container')
        references = {r['member']: r for r in rows
                      if r['storage'] == 'zip-reference' and r['container'] == container}
        contents = {}; size = 0
        with zipfile.ZipFile(io.BytesIO(stored[container])) as archive_zip:
            for item in archive_zip.infolist():
                safe(item.filename); size += item.file_size
                mode = item.external_attr >> 16
                if (item.is_dir() or item.filename in contents or item.flag_bits & 1
                        or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))
                        or item.filename not in references
                        or item.file_size != references[item.filename]['bytes']
                        or item.file_size > MAX_MEMBER or size > MAX_TOTAL
                        or len(contents) >= MAX_MEMBERS):
                    raise ValueError('unsafe/duplicate/oversized ZIP member')
                contents[item.filename] = archive_zip.read(item)
        if set(references) != set(contents):
            raise ValueError('ZIP reference census differs')
        decoded[container] = contents
    result = {}
    for row in rows:
        if row['storage'] == 'tar':
            data = stored[row['path']]
        elif row['storage'] == 'zip-reference':
            data = decoded[row['container']][row['member']]
        else:
            raise ValueError('unknown storage')
        if len(data) != row['bytes'] or digest(data) != row['sha256']:
            raise ValueError('member identity differs: ' + row['path'])
        result[row['path']] = data
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path, help='new directory, must not exist')
    parser.add_argument('--packet-directory', type=Path, help='alternate packet using the same bounded codec')
    args = parser.parse_args()
    members = verified_members(args.packet_directory)
    args.destination.mkdir(parents=True, exist_ok=False)
    for name, data in members.items():
        output = args.destination.joinpath(*safe(name).parts)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as stream:
            stream.write(data)
        if digest(output.read_bytes()) != digest(data):
            raise ValueError('extracted bytes differ')
    print(json.dumps({'status': 'verified-data-only-extraction', 'members': len(members)}))


if __name__ == '__main__':
    main()
