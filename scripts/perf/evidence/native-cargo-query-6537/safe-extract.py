# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Validate retained bytes and extract receipts; never execute archived code."""
from pathlib import Path, PurePosixPath
import hashlib
import gzip
import io
import json
import sys
import tarfile

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'manifest.json').read_text())
if manifest['archive'] != 'receipts.tar.gz':
    raise SystemExit('archive name refused')
archive = root / 'receipts.tar.gz'
if archive.stat().st_size > 64 * 1024**2:
    raise SystemExit('compressed archive bound refused')
sha = lambda value: hashlib.sha256(value).hexdigest()
if archive.stat().st_size != manifest['archiveBytes'] or sha(archive.read_bytes()) != manifest['archiveSHA256']:
    raise SystemExit('stored archive identity refused')
rows = manifest['members']
expected = {row['path']: row for row in rows}
if len(expected) != len(rows) or len(rows) != manifest['memberCount'] or len(rows) > 1024:
    raise SystemExit('duplicate/overbudget member manifest refused')
if sum(row['bytes'] for row in rows) != manifest['originalBytes'] or manifest['originalBytes'] > 64 * 1024**2:
    raise SystemExit('original byte budget refused')
destination = Path(sys.argv[1]).absolute()
destination.mkdir(parents=True, exist_ok=False)
seen = set()
maximum_uncompressed = 64 * 1024**2 + 4 * 1024**2
with gzip.open(archive, 'rb') as stream:
    uncompressed = stream.read(maximum_uncompressed + 1)
if len(uncompressed) > maximum_uncompressed:
    raise SystemExit('decompressed TAR/header bound refused')
with tarfile.open(fileobj=io.BytesIO(uncompressed), mode='r:') as tar:
    for member in tar:
        path = PurePosixPath(member.name)
        if '\\' in member.name or len(member.name.encode('utf8')) > 4096 or len(path.parts) > 20:
            raise SystemExit('archive name/depth bound refused')
        if not member.isfile() or path.is_absolute() or str(path) != member.name or any(part in ('', '.', '..') for part in path.parts):
            raise SystemExit('unsafe archive member refused')
        row = expected.get(member.name)
        if member.name in seen or row is None or member.size != row['bytes'] or not 0 <= member.size <= 16 * 1024**2:
            raise SystemExit('unexpected/duplicate/overbudget member refused')
        source = tar.extractfile(member)
        if source is None:
            raise SystemExit('missing member payload refused')
        payload = source.read(member.size + 1)
        if len(payload) != member.size or sha(payload) != row['sha256']:
            raise SystemExit('original member bytes refused')
        target = destination.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            output.write(payload)
        seen.add(member.name)
if seen != set(expected):
    raise SystemExit('incomplete archive refused')
print(json.dumps({'status': 'PASS_BYTE_INTEGRITY_ONLY', 'members': len(seen),
                  'originalBytes': manifest['originalBytes'], 'storedBytes': manifest['archiveBytes'],
                  'archiveSHA256': manifest['archiveSHA256'], 'destination': str(destination),
                  'executedArchivedCode': False}))
