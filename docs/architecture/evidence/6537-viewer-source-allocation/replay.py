# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Read-only data/Git replay. Never extracts files or executes archived code."""
import argparse
import base64
import hashlib
import json
import lzma
import os
import posixpath
import re
import struct
import subprocess
import sys
from pathlib import Path

MAX_ARCHIVE = 16 * 1024**2
MAX_EXPANDED = 64 * 1024**2
MAX_PAYLOAD = 16 * 1024**2
BASE = 'c61932d4a9d85efe1b0f817a5274a115f0571ee3'
CAND = '2feb6545b588e02d55d4d6b4d9afbe8be261452e'
CONTROLLER = '32f8b91e0de20faa73a9f77f21b810f81d3646cf'
BYTES = 342657851
FIXTURE_SHA = 'e91ddbbd672bbde946af14631de4c732f0cf8a7cfae5dbbf06fbeab03b5c46df'


def require(condition, reason):
    if not condition:
        raise ValueError('REFUSE: ' + reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_keys(pairs):
    obj = {}
    for key, value in pairs:
        require(key not in obj, 'duplicate JSON key')
        obj[key] = value
    return obj


def parse(data):
    return json.loads(data, object_pairs_hook=unique_keys)


def checked_records(envelope, manifest):
    require(envelope['format'] == manifest['format'] == 'sha256-addressed-lossless-records-v1', 'archive format')
    require(envelope['records'] == manifest['records'], 'record manifest differs')
    require(len(envelope['records']) == manifest['recordCount'] <= 128, 'record count/cap')
    require(len(envelope['payloads']) == manifest['uniquePayloadCount'] <= 128, 'payload count/cap')
    payloads = {}
    for digest, encoded in envelope['payloads'].items():
        require(re.fullmatch('[0-9a-f]{64}', digest) is not None, 'payload digest shape')
        require(isinstance(encoded, str) and len(encoded) <= MAX_PAYLOAD * 4 // 3 + 4, 'encoded payload cap')
        raw = base64.b64decode(encoded, validate=True)
        require(len(raw) <= MAX_PAYLOAD and sha(raw) == digest, 'payload SHA/cap')
        payloads[digest] = raw
    result = {}
    for record in envelope['records']:
        name = record['path']
        require(isinstance(name, str) and re.fullmatch('[A-Za-z0-9_./-]{1,256}', name) is not None
                and not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')), 'logical path')
        require(name not in result, 'duplicate logical record')
        raw = payloads[record['sha256']]
        require(type(record['bytes']) is int and len(raw) == record['bytes'], 'original payload bytes')
        result[name] = raw
    require(set(payloads) == {r['sha256'] for r in envelope['records']}, 'unreferenced payload')
    require(sum(len(v) for v in result.values()) == manifest['originalBytes'], 'original byte total')
    return result


def read_archive(directory):
    manifest = parse((directory / 'receipt-manifest.json').read_bytes())
    require(manifest['archive'] == 'raw-hosted-proof.json.xz', 'fixed archive filename')
    archive = directory / manifest['archive']
    require(archive.stat().st_size <= MAX_ARCHIVE, 'compressed cap')
    packed = archive.read_bytes()
    require(len(packed) == manifest['archiveBytes'] and sha(packed) == manifest['archiveSHA256'], 'archive bytes/SHA')
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=64 * 1024**2)
    expanded = decoder.decompress(packed, max_length=MAX_EXPANDED + 1)
    require(len(expanded) <= MAX_EXPANDED and decoder.eof and not decoder.unused_data, 'expanded cap/trailing stream')
    require(len(expanded) == manifest['decodedJSONBytes'] and sha(expanded) == manifest['decodedJSONSHA256'], 'decoded bytes/SHA')
    return checked_records(parse(expanded), manifest), manifest


def source_replay(repository, groups):
    """Hash immutable Git blobs only; never builds, fetches, or reads IFC files."""
    git_env = {**os.environ, 'GIT_NO_LAZY_FETCH': '1', 'GIT_TERMINAL_PROMPT': '0'}
    cat = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=repository, env=git_env,
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    cache = {}
    count = 0
    try:
        for head, inputs in groups:
            raw = subprocess.check_output(['git', 'ls-tree', '-rz', '--full-tree', head], cwd=repository, env=git_env)
            tree = {r.split(b'\t', 1)[1].decode(): r.split(b'\t', 1)[0].decode().split()
                    for r in raw.split(b'\0') if r}
            require(set(inputs) == set(tree), 'immutable Git/source path inventory')
            for path, expected in inputs.items():
                cursor, visited = path, set()
                while tree[cursor][0] == '120000':
                    require(cursor not in visited and len(visited) < 32, 'repository symlink cycle/budget')
                    visited.add(cursor)
                    target = subprocess.check_output(['git', 'cat-file', 'blob', tree[cursor][2]], cwd=repository, env=git_env).decode()
                    cursor = posixpath.normpath(posixpath.join(posixpath.dirname(cursor), target))
                    require(cursor in tree, 'symlink outside immutable source tree')
                oid = tree[cursor][2]
                if oid not in cache:
                    cat.stdin.write((oid + '\n').encode()); cat.stdin.flush()
                    header = cat.stdout.readline().decode().split()
                    require(len(header) == 3 and header[1] == 'blob', 'Git blob unavailable')
                    remaining, digest = int(header[2]), hashlib.sha256()
                    while remaining:
                        chunk = cat.stdout.read(min(remaining, 1024**2))
                        require(chunk, 'Git blob truncated'); digest.update(chunk); remaining -= len(chunk)
                    require(cat.stdout.read(1) == b'\n', 'Git blob delimiter')
                    cache[oid] = digest.hexdigest()
                require(cache[oid] == expected, 'Git/source SHA differs: ' + path)
                count += 1
    finally:
        cat.stdin.close(); cat.stdout.close()
        try:
            cat.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cat.kill(); cat.wait()
            raise ValueError('REFUSE: owned Git reader cleanup timeout')
    return count


def replay(directory, repository):
    records, manifest = read_archive(directory)
    data = lambda name: parse(records[name])
    provenance = data('hosted/provenance.json')
    report = data('hosted/report.json')
    require(data('producer/run-terminal.json')['headSha'] == CONTROLLER
            and provenance['harness']['head'] == CONTROLLER, 'controller pin')
    require(report['plannedControls'] == 2 and report['retries'] == 0
            and [r['arm'] for r in report['rows']] == ['base', 'candidate'], 'two ordered controls')
    require(provenance['fixture']['size'] == BYTES and provenance['fixture']['sha256'] == FIXTURE_SHA, 'fixture pin')
    require(report['initialFrozenInputs'] == report['finalFrozenInputs'] == 'complete', 'source closure')
    for name in ['producer/independent-audit.json', 'root-replay/independent-audit.json']:
        audit = data(name)
        require(audit['status'] == 'QUALIFIED_NARROW_ALLOCATION_ONLY'
                and audit['checks'] == audit['passed'] == 40585 and not audit['failures'], 'retained audit/root replay')
    derived = {}
    for row, head in zip(report['rows'], [BASE, CAND]):
        role = row['arm']; allocation = row['allocation']; milestones = allocation['milestones']
        require(row['revision'] == provenance['builds'][role]['revision'] == head, 'subject pin')
        require(allocation['canonicalMetadataSource'] == {'bytes': BYTES, 'kind': 'SharedArrayBuffer', 'sourceId': 1}
                and allocation['owner']['isResident'] is True and allocation['owner']['borrowedViewBytes'] == 1
                and allocation['owner']['entityCount'] == 4411807, 'actual canonical resident source')
        require(allocation['restorationExact'] and allocation['error'] is None and allocation['frozen'], 'observer restoration/error')
        calls = allocation['calls']; require(len(calls) == 1, 'actual copy count')
        call = calls[0]
        require(call['sourceId'] == 1 and call['outputId'] != 1 and call['inputKind'] == 'SharedArrayBuffer'
                and call['outputKind'] == 'ArrayBuffer' and call['inputByteOffset'] == call['outputByteOffset'] == 0
                and call['inputViewBytes'] == call['inputBufferBytes'] == call['outputBytes'] == call['outputBufferBytes'] == BYTES,
                'actual native copy ancestry/layout')
        early = milestones['sourceAcquired'] <= call['pageMs'] < milestones['parallelStart']
        late = milestones['geometryComplete'] <= call['pageMs'] <= milestones['cacheStart']
        require(early is (role == 'base') and late is (role == 'candidate'), 'independently derived native copy stage')
        require(row['fullAppearanceIdentity']['status'] == 'unavailable'
                and 'flat/instance scene owner census mismatch' in row['fullAppearanceIdentity']['reason'], 'strict owner refusal retained')
        require(row['readiness']['model']['geometryLoadState'] == 'opening'
                and row['readiness']['model']['metadataLoadState'] == 'idle'
                and row['readiness']['model']['interactiveReady'] is False, 'legacy lifecycle fields retained')
        require(row['exit'] == {'code': 0, 'signal': None} and row['teardown'] == 'complete'
                and row['ownedCleanup']['status'] == row['logFlush']['status'] == 'complete'
                and not row['ownedCleanup']['remaining'] and not row['backendErrors']
                and report['serverCleanup'][role]['status'] == 'complete', 'browser/process/log/server cleanup')
        rss = data('hosted/' + role + '.json.rss.json')
        require(len(rss) == row['sampledRss']['samples'] and max(s['bytes'] for s in rss) == row['sampledRss']['peak'] <= 5 * 1024**3, 'RSS guard/recompute')
        png = records['hosted/' + role + '.json.png']
        require(png[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', png[16:24]) == (1280, 900)
                and (directory / (role + '.png')).read_bytes() == png, 'unmodified screenshot/envelope')
        derived[role] = {'sourcePreparationCopies': int(early), 'postGeometryCacheCopies': int(late), 'bytes': BYTES}
    git_count = source_replay(repository, [(CONTROLLER, provenance['harness']['sourceInputs'])]
                              + [(head, provenance['builds'][role]['sourceInputs']) for role, head in [('base', BASE), ('candidate', CAND)]])
    return {'status': 'REPLAYED_NARROW_ALLOCATION_ONLY', 'records': len(records), 'originalBytes': manifest['originalBytes'],
            'archiveSHA256': manifest['archiveSHA256'], 'immutableGitSourceSHAs': git_count, 'derivedCopies': derived,
            'strictRefusalsPreserved': True, 'WASMengineByteIdentity': provenance['builds']['base']['wasmSha256'] == provenance['builds']['candidate']['wasmSha256'],
            'scope': 'No normal timing, speed, physical-memory, full scene/interactive/fidelity, federation or Edge fix verdict.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--repository', type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        print(json.dumps(replay(args.directory, args.repository), indent=2))
    except (ValueError, KeyError, TypeError, OSError, lzma.LZMAError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
