#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Prepare a pinned, patched SDK snapshot beneath the CMake binary directory.

Never writes SMLIB_SOURCE. Existing copies are verified, never overwritten.
No network, patch fuzz, in-place repair, or fallback to unpatched source.
"""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inventory(files):
    return [[name, sha(data)] for name, data in sorted(files.items())]


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def ensure(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def stage(files, destination, patch, pins, metadata):
    ensure(sha(patch.read_bytes()) == pins['patchSha256'], 'patch hash mismatch')
    ensure(sha(files[pins['path']]) == pins['inputSha256'], 'patched file input hash mismatch')
    ensure(all(not pathlib.PurePosixPath(n).is_absolute() and '..' not in pathlib.PurePosixPath(n).parts
               for n in files), 'unsafe snapshot path')
    ensure(all(not p.is_symlink() for p in destination.parents), 'snapshot parent symlink refused')
    expected = dict(inventory(files)); expected[pins['path']] = pins['outputSha256']
    receipt = dict(metadata, patch=pins, outputFiles=expected)
    receipt_bytes = encoded(receipt)
    if destination.exists() or destination.is_symlink():
        ensure(destination.is_dir() and not destination.is_symlink(), 'snapshot destination not an owned directory')
        actual = {}
        for path in destination.rglob('*'):
            ensure(not path.is_symlink(), 'snapshot contains a symlink')
            if path.is_file():
                actual[path.relative_to(destination).as_posix()] = sha(path.read_bytes())
        ensure(actual == dict(expected, **{'provenance.json': sha(receipt_bytes)}),
               'existing snapshot changed: use a fresh build directory, do not overwrite evidence')
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Only the private temporary directory belongs to this invocation. Failed
    # patching cannot leave a completed snapshot or remove a foreign directory.
    with tempfile.TemporaryDirectory(prefix='.sdk-prepare-', dir=destination.parent) as folder:
        temporary = pathlib.Path(folder)
        for name, data in files.items():
            target = temporary / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        subprocess.run(['git', 'apply', '--no-index', '--check', str(patch.resolve())], cwd=temporary, check=True)
        subprocess.run(['git', 'apply', '--no-index', str(patch.resolve())], cwd=temporary, check=True)
        actual = {p.relative_to(temporary).as_posix(): sha(p.read_bytes())
                  for p in temporary.rglob('*') if p.is_file()}
        ensure(actual == expected, 'patched snapshot differs from exact output inventory')
        (temporary / 'provenance.json').write_bytes(receipt_bytes)
        # mkdir claims the destination atomically, rather than replacing it.
        destination.mkdir()
        for child in temporary.iterdir():
            child.rename(destination / child.name)


def prepare(source, build):
    here = pathlib.Path(__file__).resolve().parent
    pins_path = here / 'patches/imprint-status-v1.json'
    pins = json.loads(pins_path.read_text())
    source = source.resolve(strict=True); build = build.resolve()
    ensure(source != build and source not in build.parents and build not in source.parents,
           'build and immutable SDK must be disjoint trees')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args])
    ensure(git('rev-parse', 'HEAD').decode().strip() == pins['upstreamRevision'], 'SDK revision mismatch')
    subprocess.run(['git', '-C', str(source), 'diff', '--exit-code', 'HEAD', '--', *pins['selection']], check=True,
                   stdout=subprocess.DEVNULL)
    ensure(not git('ls-files', '--others', '--', *pins['selection']).strip(), 'untracked/ignored SDK files present')
    files = {}
    for row in git('ls-tree', '-rz', 'HEAD', '--', *pins['selection']).split(b'\0'):
        if not row:
            continue
        meta, name = row.split(b'\t', 1); mode, kind, _ = meta.split(); name = name.decode()
        ensure(kind == b'blob' and mode in (b'100644', b'100755'), 'unsupported SDK file mode')
        path = source / name
        ensure(not path.is_symlink() and all(not p.is_symlink() for p in path.parents), 'SDK symlink refused')
        files[name] = path.read_bytes()
    ensure(len(files) == pins['fileCount'] and
           sha(json.dumps(inventory(files), separators=(',', ':')).encode()) == pins['inputInventorySha256'],
           'complete SDK input inventory hash mismatch')
    destination = build / 'ifclite-sdk' / pins['id']
    stage(files, destination, here / 'patches/imprint-status-v1.patch', pins,
          {'schema': 1, 'upstreamRevision': pins['upstreamRevision'], 'upstreamInventorySha256': pins['inputInventorySha256'],
           'preparerSha256': sha(pathlib.Path(__file__).read_bytes()), 'pinsSha256': sha(pins_path.read_bytes()),
           'license': 'Upstream source retains its original license; see LICENSE and THIRD_PARTY_NOTICES.md.'})
    print(destination)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=pathlib.Path)
    parser.add_argument('--build', required=True, type=pathlib.Path)
    args = parser.parse_args()
    prepare(args.source, args.build)
