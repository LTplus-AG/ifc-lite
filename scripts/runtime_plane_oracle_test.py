# SPDX-License-Identifier: MPL-2.0
"""#7955: exercise the oracle with executable libtest-output fixtures, no Cargo."""
import contextlib
import importlib.util
import io
import pathlib
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'runtime_plane_oracle', pathlib.Path(__file__).with_name('runtime-plane-oracle.py'))
ORACLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORACLE)
NAME = 'native_plane_fault_packets_retire_only_captured_owner'
MARKER = 'plane fault must reject malformed certificate: plane'


def transcript(name=NAME, marker=MARKER, panic_name=NAME):
    return (f'running 1 test\ntest {name} ... FAILED\n'
            'test result: FAILED. 0 passed; 1 failed; 0 ignored; '
            '0 measured; 4 filtered out; finished in 0.22s\n'
            f"thread '{panic_name}' (123) panicked at tests/plane_faults.rs:103:9:\n"
            f'{marker}\nnote: run with `RUST_BACKTRACE=1` environment variable\n')


class WitnessTests(unittest.TestCase):
    def witness(self, output, code=101, killed=True):
        with tempfile.TemporaryDirectory() as directory:
            binary = pathlib.Path(directory) / 'libtest-fixture'
            binary.write_text('#!/usr/bin/env python3\nimport sys\n'
                              f'assert sys.argv[1:] == ["--exact", {NAME!r}, "--nocapture"]\n'
                              f'print({output!r}, end="")\nsys.exit({code})\n')
            binary.chmod(0o755)
            with contextlib.redirect_stdout(io.StringIO()):
                ORACLE.witness(str(binary), NAME, killed)

    def test_accepts_exact_plane_assertion(self):
        self.witness(transcript())

    def test_rejects_other_failures(self):
        for output, code in [
            (transcript(marker='case alias'), 101),
            (transcript(marker='plane owner must retire: plane'), 101),
            (transcript(marker=MARKER + ' extra'), 101),
            (transcript(panic_name='unrelated_test'), 101),
            (transcript(name='unrelated_test'), 101),
            (transcript(marker='unrelated panic') + MARKER + '\n', 101),
            ('error[E0308]: mismatched types\n' + MARKER, 101),
            (transcript(), 1),
            ('running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored\n', 0),
            (f'running 1 test\ntest {NAME} ... ignored\n'
             'test result: ok. 0 passed; 0 failed; 1 ignored\n', 0),
        ]:
            with self.subTest(output=output, code=code):
                with self.assertRaises(RuntimeError):
                    self.witness(output, code)

    def test_control_requires_one_named_pass(self):
        output = (f'running 1 test\ntest {NAME} ... ok\n'
                  'test result: ok. 1 passed; 0 failed; 0 ignored; '
                  '0 measured; 4 filtered out; finished in 0.01s\n')
        self.witness(output, 0, False)
        for invalid in [output.replace(NAME, 'unrelated_test'),
                        output.replace('1 passed', '0 passed'),
                        output.replace('0 ignored', '1 ignored')]:
            with self.subTest(output=invalid):
                with self.assertRaises(RuntimeError):
                    self.witness(invalid, 0, False)


if __name__ == '__main__':
    unittest.main()
