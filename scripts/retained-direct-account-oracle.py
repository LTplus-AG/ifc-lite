#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 R2.1: independently compiled actual Worker direct-account mutations."""
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
DECODE = 'ifc_lite_geometry::document::retained_source::SourceCorrespondence::decode'
PREFIX = 'retained_browser_j5_direct_'


def main():
    cases = [
        ('bridge.rs', f'{DECODE}(&request,&mesh.source_handle,&mesh.source_inventory)',
         PREFIX+'construction_charges_captured_account', 'J5_DIRECT construction inventory belongs to captured A'),
        ('dependencies.rs', f'{DECODE}(expected.request(),&handle,&inventory)',
         PREFIX+'affine_charges_captured_account', 'J5_DIRECT both affine inventory copies belong to captured A'),
        ('dependencies.rs', f'{DECODE}(expected.request(),&mesh.source_handle,&mesh.source_inventory)',
         PREFIX+'affine_charges_captured_account', 'J5_DIRECT affine inventory belongs to captured A'),
    ]
    directory = ROOT/'rust/wasm-bindings/src/retained_browser'
    originals = {name: (directory/name).read_bytes() for name, *_ in cases}
    for name, expression, *_ in cases:
        subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', str(directory/name)], cwd=ROOT, check=True)
        if originals[name].count(f'resources.with_scope(|| {expression})'.encode()) != 1:
            raise RuntimeError('direct account mutation anchor drift')

    def witness(test, marker=None):
        subprocess.run(['cargo', 'test', '--locked', '-p', 'ifc-lite-wasm', '--lib', '--features',
                        'retained-browser', '--target', 'wasm32-unknown-unknown', '--no-run'],
                       cwd=ROOT, check=True, timeout=3600)
        result = subprocess.run(['wasm-pack', 'test', '--headless', '--chrome', '--chromedriver',
                                 str(ROOT/'scripts/wasm-test-mime-driver.mjs'), 'rust/wasm-bindings',
                                 '--lib', '--features', 'retained-browser', '--', test],
                                cwd=ROOT, capture_output=True, text=True, timeout=900)
        output = result.stdout+result.stderr
        print(output, end='', flush=True)
        if 'running 1 test' not in output or 'SKIP' in output or 'could not compile' in output:
            raise RuntimeError('actual single compiled Worker witness required')
        if marker is None:
            if result.returncode != 0 or '1 passed; 0 failed' not in output:
                raise RuntimeError('green control required; preserve execution HOLD')
        elif result.returncode == 0 or marker not in output or '0 passed; 1 failed' not in output:
            raise RuntimeError('intended semantic account attribution RED required')

    witness(PREFIX+'inventory_refusal_stops_captured_account')
    for name, expression, test, marker in cases:
        witness(test)
        try:
            before = f'resources.with_scope(|| {expression})'.encode()
            (directory/name).write_bytes(originals[name].replace(before, expression.encode()))
            witness(test, marker)
        finally:
            (directory/name).write_bytes(originals[name])
            witness(test)
        print(f'OBSERVED direct account mutation: {expression}', flush=True)
    witness(PREFIX+'inventory_refusal_stops_captured_account')


if __name__ == '__main__':
    main()
