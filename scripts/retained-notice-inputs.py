#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Semantic notice inputs; Python 3.11+ stdlib only, no SDK/Cargo/network.

Walk the locked source closure of both shipped WASM roots. Workspace dev-only
edges are excluded using their manifests; optional and target-specific production
edges are included conservatively. External lock entries already omit dev edges.
Workspace versions, formatting and unrelated workflow fields are not evidence.
"""
import json
import re
import sys
import tomllib
from pathlib import Path


def inputs(root):
    def toml(path):
        return tomllib.loads((root / path).read_text())

    workspace = toml('Cargo.toml')['workspace']
    manifests = {}
    for path in root.glob('rust/**/Cargo.toml'):
        data = tomllib.loads(path.read_text())
        if 'package' in data:
            manifests[data['package']['name']] = data
    locked = toml('Cargo.lock')['package']

    def resolve(dep):
        parts = dep.split(' ', 2)
        matches = [p for p in locked if p['name'] == parts[0]
                   and (len(parts) == 1 or p['version'] == parts[1])
                   and (len(parts) < 3 or p.get('source') == parts[2].strip('()'))]
        if len(matches) != 1:
            raise ValueError(f'Ambiguous/missing locked dependency: {dep}')
        return matches[0]

    def production_names(data):
        names = set()
        for table in [data, *data.get('target', {}).values()]:
            for kind in ['dependencies', 'build-dependencies']:
                for alias, spec in table.get(kind, {}).items():
                    if isinstance(spec, dict) and spec.get('workspace'):
                        spec = workspace['dependencies'][alias]
                    names.add(spec.get('package', alias) if isinstance(spec, dict) else alias)
        return names

    closures = {}
    for name in ['ifc-lite-wasm', 'ifc-lite-diff-wasm']:
        seen = set()
        external = []
        pending = [resolve(name)]
        while pending:
            pkg = pending.pop()
            key = (pkg['name'], pkg['version'], pkg.get('source'))
            if key in seen:
                continue
            seen.add(key)
            allowed = None
            if pkg.get('source'):
                external.append({k: pkg.get(k) for k in ['name', 'version', 'source', 'checksum']})
            else:
                # A new local dependency outside this inventory's Rust tree is
                # a scope change needing review, never silently ignored.
                allowed = production_names(manifests[pkg['name']])
            for dep in pkg.get('dependencies', []):
                if allowed is None or dep.split(' ')[0] in allowed:
                    pending.append(resolve(dep))
        closures[name] = sorted(external, key=lambda p: (p['name'], p['version'], p['source']))

    workflow = (root / '.github/workflows/geometry-platform.yml').read_text()
    def required(pattern, text):
        match = re.search(pattern, text)
        if not match:
            raise ValueError(f'Missing inventory pin: {pattern}')
        return match.group(1)
    return {
        'cargoClosures': closures,
        'smlibRevision': required(r'set\(IFCLITE_SMLIB_REVISION\s+([a-f0-9]{40})\)',
                                 (root / 'native/smlib-adapter/CMakeLists.txt').read_text()),
        'emsdkRef': required(r'repository:\s*emscripten-core/emsdk\s+ref:\s*([a-f0-9]{40})', workflow),
        'emscriptenVersion': required(r'emsdk/emsdk install\s+([\d.]+)', workflow),
        'rustChannel': toml('rust-toolchain.toml')['toolchain']['channel'],
        'supplemental': json.loads((root / 'licenses/retained/supplemental.json').read_text()),
    }


if __name__ == '__main__':
    print(json.dumps(inputs(Path(sys.argv[1]))))
