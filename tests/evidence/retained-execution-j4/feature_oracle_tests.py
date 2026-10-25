# SPDX-License-Identifier: MPL-2.0
"""#7955 M5: synthetic classifier controls, never SDK execution evidence."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('feature_oracle', Path(__file__).with_name('feature-oracle.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
verify = module.verify_test_output
ROW = {'test': 'unit::case', 'expectedFailure': {
    'file': 'rust/test.rs', 'line': 42,
    'fragments': ['PREREGISTERED', 'left: 1', 'right: 0'],
}}
RED = """running 1 test
thread 'unit::case' (1234) panicked at rust/test.rs:42:5:
assertion `left == right` failed: PREREGISTERED
  left: 1
 right: 0
note: run with RUST_BACKTRACE=1
test unit::case ... FAILED
test result: FAILED. 0 passed; 1 failed; 0 ignored;
"""
GREEN = 'running 1 test\ntest unit::case ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;\n'


class IntendedCauseTests(unittest.TestCase):
    def test_only_the_preregistered_assertion_qualifies(self):
        verify(GREEN, 0, ROW)
        verify(RED, 101, ROW, True)
        controls = [
            RED.replace('rust/test.rs:42', 'rust/setup.rs:42'),
            RED.replace('rust/test.rs:42', 'rust/test.rs:43'),
            RED.replace("thread 'unit::case'", "thread 'other::case'"),
            RED.replace('PREREGISTERED', 'SDK worker spawn failed'),
            RED.replace('left: 1', 'left: 2'),
            RED.replace('running 1 test', 'running 0 tests'),
            RED.replace('0 passed; 1 failed;', '0 passed; 0 failed;'),
            RED.replace('test unit::case ... FAILED', 'test other::case ... FAILED'),
            'SKIP actual SDK unavailable\n' + RED,
            RED.replace('assertion `left == right` failed: PREREGISTERED\n  left: 1\n right: 0',
                        'unrelated panic\nnote: run PREREGISTERED left: 1 right: 0'),
            RED + RED,
            RED + "thread 'other::case' panicked at rust/setup.rs:1:1:\nsetup failed\n",
            'error[E0308]: compilation failed\n',
        ]
        for output in controls:
            with self.subTest(output=output):
                with self.assertRaises(RuntimeError):
                    verify(output, 101, ROW, True)
        with self.assertRaises(RuntimeError):
            verify(RED, 0, ROW, True)

    def test_numerical_counterfactual_is_also_preregistered(self):
        row = {'test': 'unit::case', 'expectedFailure': {
            'file': 'rust/test.rs', 'line': 42, 'fragments': ['VOLUME expected=20'],
            'measurement': {'pattern': r'actual=(?P<actual>[^ ]+) VOLUME expected=20',
                            'value': 24., 'tolerance': 1e-7},
        }}
        output = RED.replace('PREREGISTERED', 'actual=24 VOLUME expected=20')
        verify(output, 101, row, True)
        for value in ['8', 'NaN', 'Infinity', '24.000001']:
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    verify(output.replace('actual=24 ', f'actual={value} '), 101, row, True)


if __name__ == '__main__':
    unittest.main()
