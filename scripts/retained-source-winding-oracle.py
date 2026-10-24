#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 J5-R1 reverse oracle; heavy execution belongs to CI/parent admission.

Build separately from execution so compiler errors never qualify as a kill.
Require green controls, the exact assertion kill, and restored green controls.
Only the source guard's error propagation is mutated; no SDK/artifact edits.
"""
import json
import pathlib
import subprocess


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'rust/geometry/src/document/retained_display.rs'
PREFIX = 'document::retained::tests::'
REGRESSION = PREFIX + 'j5_r1_source_winding_rounding_flip_refuses_atomically'
CONTROL = PREFIX + 'j5_r1_valid_analytic_corner_normals_survive_publication'
MARKER = 'J5-R1 source winding must refuse before publication'


def build():
    result = subprocess.run(
        ['cargo', 'test', '--locked', '-p', 'ifc-lite-geometry', '--lib',
         '--no-run', '--message-format=json'], cwd=ROOT, capture_output=True,
        text=True, timeout=1800, check=True)
    executables = set()
    for line in result.stdout.splitlines():
        event = json.loads(line)
        if (event.get('reason') == 'compiler-artifact'
                and event.get('profile', {}).get('test')
                and event.get('target', {}).get('name') == 'ifc_lite_geometry'
                and event.get('executable')):
            executables.add(event['executable'])
    if len(executables) != 1:
        raise RuntimeError('expected exactly one geometry lib test executable')
    return executables.pop()


def witness(binary, test, killed=False):
    result = subprocess.run([binary, '--exact', test, '--nocapture'], cwd=ROOT,
                            capture_output=True, text=True, timeout=60)
    output = result.stdout + result.stderr
    print(output, end='', flush=True)
    if 'running 1 test' not in output:
        raise RuntimeError('oracle test missing or filtered out')
    if killed:
        if (result.returncode != 101 or MARKER not in output
                or f'test {test} ... FAILED' not in output
                or '0 passed; 1 failed; 0 ignored' not in output):
            raise RuntimeError('mutation did not die at the intended source assertion')
    elif result.returncode != 0 or '1 passed; 0 failed; 0 ignored' not in output:
        raise RuntimeError('oracle requires a green control')


def main():
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', str(SOURCE)],
                   cwd=ROOT, check=True)
    original = SOURCE.read_bytes()
    anchor = b'    validate_source_winding(data)?;'
    if original.count(anchor) != 1:
        raise RuntimeError('source validation anchor drifted')
    binary = build()
    witness(binary, CONTROL)
    witness(binary, REGRESSION)
    try:
        SOURCE.write_bytes(original.replace(anchor, b'    let _ = validate_source_winding(data);'))
        binary = build()  # Must compile successfully before any kill is considered.
        witness(binary, CONTROL)
        witness(binary, REGRESSION, killed=True)
        print('OBSERVED: J5-R1 source-validation assertion kill', flush=True)
    finally:
        SOURCE.write_bytes(original)
        binary = build()
        witness(binary, CONTROL)
        witness(binary, REGRESSION)


if __name__ == '__main__':
    main()
