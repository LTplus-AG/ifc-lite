#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Generate test-only intersector TUs; never change prepared production sources."""
import argparse
import hashlib
import json
import pathlib
import os
import stat
import subprocess
import tempfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def instrument(data, cleanups):
    text = data.decode('utf-8')
    def replace(before, after, count=1):
        nonlocal text
        if text.count(before) != count:
            raise RuntimeError('test instrumentation anchor mismatch: ' + before)
        text = text.replace(before, after)
    replace('#include <SmProtoTopology.h>', '#include <SmProtoTopology.h>\n#include "imprint_test_hooks.hpp"')
    replace('eStat = pED->Imprint();', 'eStat = ifclite_test_edge_imprint(pED);')
    replace('delete pED; pED = NULL;', 'delete pED; pED = NULL; ifclite_test_failed_definition_retired();')
    replace('SmStatus SmTopologyIntersector::SetRelationships()\n{',
            'SmStatus SmTopologyIntersector::SetRelationships()\n{\n  ifclite_test_relationships();')
    replace('delete m_pProtoTopoMgr ; m_pProtoTopoMgr = NULL;',
            'delete m_pProtoTopoMgr ; m_pProtoTopoMgr = NULL; ifclite_test_manager_cleaned(m_pProtoTopoMgr == NULL);',
            cleanups)
    return text.encode()


def publish_products(output, products):
    """Anchor every traversal to no-follow directory descriptors, including reentry.

    Fail closed on hosts lacking these primitives. Exclusive creation protects
    missing products; existing regular files are only read and compared.
    """
    if (not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY') or
            os.open not in os.supports_dir_fd or os.mkdir not in os.supports_dir_fd or
            os.stat not in os.supports_dir_fd or os.stat not in os.supports_follow_symlinks):
        raise RuntimeError('witness output requires no-follow directory-descriptor support')
    output = pathlib.Path(output)
    if '..' in output.parts:
        raise RuntimeError('witness output cannot contain parent traversal')
    output = output.absolute()  # Deliberately do not resolve symlinks.
    if any(pathlib.PurePath(n).name != n or n in ('', '.', '..') for n in products):
        raise RuntimeError('invalid witness product name')
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(output.anchor, directory_flags)
    try:
        for component in output.parts[1:]:
            try:
                child = os.open(component, directory_flags, dir_fd=descriptor)
            except FileNotFoundError:
                try:
                    os.mkdir(component, dir_fd=descriptor)
                except FileExistsError:
                    pass  # A concurrent creation is validated by no-follow open.
                child = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child

        def verify(name, expected):
            try:
                info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                return False
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise RuntimeError('witness product is linked or not a regular file: ' + name)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            with os.fdopen(fd, 'rb') as existing:
                actual = os.fstat(existing.fileno())
                if (not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or
                        (actual.st_dev, actual.st_ino) != (info.st_dev, info.st_ino)):
                    raise RuntimeError('witness product changed during verification: ' + name)
                if existing.read() != expected:
                    raise RuntimeError('witness source changed: use a fresh build directory')
            return True

        # Reject every linked/changed product before creating any missing one.
        for name, data in products.items():
            verify(name, data)
        for name, data in products.items():
            if verify(name, data):
                continue
            # O_EXCL rejects a newly inserted symlink (even dangling). Parent
            # descriptors cannot be redirected by replacing directory names.
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o644, dir_fd=descriptor)
            with os.fdopen(fd, 'wb') as product:
                product.write(data)
    except OSError as error:
        raise RuntimeError('unsafe or unavailable witness output path: ' + str(output)) from error
    finally:
        os.close(descriptor)


def generate(prepared, output):
    adapter = pathlib.Path(__file__).resolve().parents[1]
    pins = json.loads((adapter / 'patches/imprint-status-v1.json').read_text())
    patch = adapter / 'patches/imprint-status-v1.patch'
    data = (prepared / pins['path']).read_bytes()
    if sha(data) != pins['outputSha256'] or sha(patch.read_bytes()) != pins['patchSha256']:
        raise RuntimeError('witness requires exact prepared production SDK')
    with tempfile.TemporaryDirectory(prefix='ifclite-imprint-reverse-') as folder:
        temporary = pathlib.Path(folder); target = temporary / pins['path']
        target.parent.mkdir(parents=True); target.write_bytes(data)
        subprocess.run(['git', 'apply', '--no-index', '--reverse', str(patch)], cwd=temporary, check=True)
        original = target.read_bytes()
    if sha(original) != pins['inputSha256']:
        raise RuntimeError('reverse mutation did not restore exact original SDK file')
    products = {'control.cpp': instrument(data, 2), 'reverse.cpp': instrument(original, 1)}
    receipt = {'schema': 1, 'productionInputSha256': sha(data), 'reverseInputSha256': sha(original),
               'generatorSha256': sha(pathlib.Path(__file__).read_bytes()),
               'files': {n: sha(b) for n, b in products.items()},
               'meaning': 'Test-only TUs. Control uses exact production repair; reverse restores original status loss.'}
    products['provenance.json'] = (json.dumps(receipt, indent=2) + '\n').encode()
    publish_products(output, products)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    generate(args.prepared, args.output)
