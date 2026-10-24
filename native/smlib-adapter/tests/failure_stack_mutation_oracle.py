#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 diagnostic-only reverse mutations; parent-admitted Linux build only.

Use an exclusively owned mutable checkout/build, never a frozen qualification
checkout. No compiler failure, signal, taint or timeout counts as a semantic kill.
"""
import os
import pathlib
import subprocess
import sys


def main():
    if not os.environ.get('IFC_WORKER_ACTIVE_STATE'):
        raise RuntimeError('Parent heavy admission required')
    root = pathlib.Path(__file__).resolve().parents[3]
    build = pathlib.Path(sys.argv[1]).resolve()
    if 'IFCLITE_LINEAGE_FAILURE_STACK:BOOL=ON' not in (build / 'CMakeCache.txt').read_text():
        raise RuntimeError('Requires the opt-in diagnostic build')
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD'], cwd=root, check=True)
    cases = [
        ('missing', 'face_lineage.hpp', 'first refusal captures a bounded native stack'),
        ('overwrite', 'face_lineage_events.cpp', 'later callbacks preserve the first refusal stack and origin'),
    ]

    def compile_witness():
        subprocess.run(['cmake', '--build', str(build), '--target',
                        'ifclite_smlib_failure_stack_tests', '--parallel', '2'], cwd=root, check=True)

    def witness(marker=None):
        result = subprocess.run([str(build / 'ifclite_smlib_failure_stack_tests')],
                                cwd=root, capture_output=True, text=True, timeout=30)
        output = result.stdout + result.stderr
        print(output, end='', flush=True)
        if marker is None:
            if result.returncode != 0 or 'lineage failure stack witness PASS' not in output:
                raise RuntimeError('Diagnostic control must be green')
        elif result.returncode != 1 or f'failure stack FAIL: {marker}' not in output:
            raise RuntimeError('Mutation lacks its intended semantic kill')

    compile_witness()
    for name, filename, marker in cases:
        witness()
        source = root / 'native/smlib-adapter/src' / filename
        original = source.read_bytes()
        patch = pathlib.Path(__file__).parent / 'fixtures' / f'failure-stack-{name}.oracle.patch'
        try:
            subprocess.run(['git', 'apply', '--reverse', '--check', str(patch)], cwd=root, check=True)
            subprocess.run(['git', 'apply', '--reverse', str(patch)], cwd=root, check=True)
            compile_witness()
            witness(marker)
            print(f'OBSERVED diagnostic mutation: {name}', flush=True)
        finally:
            source.write_bytes(original)
            compile_witness()
        witness()


if __name__ == '__main__':
    main()
