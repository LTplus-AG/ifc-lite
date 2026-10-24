#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Generate test-only intersector TUs; never change prepared production sources."""
import argparse
import hashlib
import json
import pathlib
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
    output.mkdir(parents=True, exist_ok=True)
    products = {'control.cpp': instrument(data, 2), 'reverse.cpp': instrument(original, 1)}
    receipt = {'schema': 1, 'productionInputSha256': sha(data), 'reverseInputSha256': sha(original),
               'generatorSha256': sha(pathlib.Path(__file__).read_bytes()),
               'files': {n: sha(b) for n, b in products.items()},
               'meaning': 'Test-only TUs. Control uses exact production repair; reverse restores original status loss.'}
    products['provenance.json'] = (json.dumps(receipt, indent=2) + '\n').encode()
    for name, data in products.items():
        path = output / name
        if path.exists() and path.read_bytes() != data:
            raise RuntimeError('witness source changed: use a fresh build directory')
        if not path.exists():
            path.write_bytes(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepared', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    args = parser.parse_args()
    generate(args.prepared, args.output)
