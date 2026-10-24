#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 independent reverse patch, actual native controls; no CI-only logic."""
import pathlib
import subprocess
import sys


def main():
    build = pathlib.Path(sys.argv[1]).resolve()
    def compile_target(target):
        subprocess.run(['cmake', '--build', str(build), '--target', target, '--parallel', '2'], check=True)
    def run(target, mode, operation, mutant=False):
        result = subprocess.run([str(build / target), mode, operation], capture_output=True, text=True, timeout=120)
        output = result.stdout + result.stderr
        print(output, end='', flush=True)
        if mutant:
            marker = 'imprint FAIL: first imprint failure stops relationships and Boolean publication'
            if result.returncode != 1 or marker not in output:
                raise RuntimeError('reverse mutation was not killed by the status/publication witness')
        elif result.returncode != 0 or f'imprint PASS: {mode} {operation}' not in output:
            raise RuntimeError('actual native control failed')
    control = 'ifclite_smlib_imprint_tests'
    mutant = 'ifclite_smlib_imprint_mutant'
    compile_target(control)
    for operation in ['union', 'intersection', 'difference', 'classify']:
        run(control, 'healthy', operation)
        run(control, 'failure', operation)
    compile_target(mutant)
    for operation in ['union', 'intersection', 'difference', 'classify']:
        run(mutant, 'healthy', operation)
        run(mutant, 'failure', operation, mutant=True)
        run(control, 'failure', operation)
        run(control, 'healthy', operation)
    print('OBSERVED: imprint status-loss reverse mutation killed in all four operation modes')


if __name__ == '__main__':
    main()
