#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955 shared native/Worker source-packet semantic mutations; no source-text test."""
import pathlib
import subprocess


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    path = root / 'rust/geometry/src/document/retained_source.rs'
    original = path.read_text()
    cases = [
        ('self.request.same_admission(&other.request) && ', '',
         'j5_source_contract_equal_numbers_never_replace_request_allocation',
         'equal numeric identities cannot replace captured source request token'),
        ('if seen[..self.roles.len()].iter().any(|seen| !seen)', 'if false',
         'j5_source_contract_requires_complete_final_triangle_coverage',
         'partial or foreign triangle correspondence refused'),
    ]
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--', str(path)], cwd=root, check=True)
    for before, _, _, _ in cases:
        if original.count(before) != 1:
            raise RuntimeError('source packet mutation anchor drift')

    def run(test, marker=None):
        result = subprocess.run(['cargo', 'test', '--locked', '-p', 'ifc-lite-geometry', '--lib', test, '--', '--nocapture'],
                                cwd=root, capture_output=True, text=True, timeout=1800)
        output = result.stdout + result.stderr
        print(output, end='', flush=True)
        if marker is None:
            if result.returncode != 0 or '1 passed' not in output:
                raise RuntimeError('source packet control not green')
        elif result.returncode != 101 or '1 failed' not in output or marker not in output or 'could not compile' in output:
            raise RuntimeError('source packet mutation requires compiled intended semantic RED')

    for before, after, test, marker in cases:
        run(test)
        try:
            path.write_text(original.replace(before, after))
            run(test, marker)
        finally:
            path.write_text(original)
            run(test)
        print(f'OBSERVED shared source packet mutation: {test}', flush=True)


if __name__ == '__main__':
    main()
