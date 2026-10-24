#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Offline #7955 matcher regression tests from captured Rust panic output."""
import json
from pathlib import Path
import re
import unittest

from mutate import classify

SAMPLES = json.loads(Path(__file__).with_name('mutation-failure-samples.json').read_text())['failures']


class MatcherTests(unittest.TestCase):
    def assert_status(self, sample, expected, output=None, **run_overrides):
        run = {'exit':sample['exit'], 'timed_out':sample['timed_out'], **run_overrides}
        status, checks = classify(sample, run, sample['output_excerpt'] if output is None else output)
        self.assertEqual(status, expected, (sample['name'], checks))
        return checks

    def test_all_seventeen_captured_assertions_are_killed(self):
        self.assertEqual(len(SAMPLES), 17)
        for sample in SAMPLES:
            with self.subTest(mutation=sample['name']):
                self.assert_status(sample, 'killed')

    def test_older_rust_header_without_numeric_thread_id(self):
        for sample in SAMPLES:
            output = re.sub(r"(') \([0-9]+\) panicked", r'\1 panicked', sample['output_excerpt'])
            with self.subTest(mutation=sample['name']):
                self.assert_status(sample, 'killed', output)

    def test_wrong_assertion_is_unqualified_even_with_expected_text_elsewhere(self):
        for sample in SAMPLES:
            lines = sample['output_excerpt'].splitlines(keepends=True)
            intended_message = lines[1]
            lines[1] = 'unexpected index out of bounds\n'
            # The intended marker in ordinary output must not qualify this panic.
            output = intended_message + ''.join(lines) + intended_message
            with self.subTest(mutation=sample['name']):
                checks = self.assert_status(sample, 'unqualified_failure', output)
                self.assertTrue(checks['named_panic'])
                self.assertFalse(checks['intended_assertion'])

    def test_wrong_test_name_and_extra_panic_are_unqualified(self):
        sample = SAMPLES[0]
        wrong = sample['output_excerpt'].replace("thread '"+sample['test']+"'", "thread 'unrelated_test'")
        self.assert_status(sample, 'unqualified_failure', wrong)
        self.assert_status(sample, 'unqualified_failure', sample['output_excerpt']+wrong)

    def test_exit_code_and_timeout_remain_required(self):
        for code in [0, 1, 102, -15]:
            with self.subTest(exit_code=code):
                self.assert_status(SAMPLES[0], 'unqualified_failure', exit=code)
        self.assert_status(SAMPLES[0], 'unqualified_failure', timed_out=True)

    def test_exactly_one_failed_test_and_no_ignored_tests_required(self):
        sample = SAMPLES[0]
        for before, after in [('1 failed;', '2 failed;'), ('0 ignored;', '1 ignored;'),
                              ('0 passed;', '1 passed;'), ('FAILED.', 'ok.')]:
            with self.subTest(summary=after):
                self.assert_status(sample, 'unqualified_failure', sample['output_excerpt'].replace(before, after))

    def test_missing_panic_or_summary_cannot_qualify(self):
        sample = SAMPLES[0]
        lines = sample['output_excerpt'].splitlines(keepends=True)
        self.assert_status(sample, 'unqualified_failure', ''.join(lines[1:]))
        self.assert_status(sample, 'unqualified_failure', ''.join(lines[:-1]))


if __name__ == '__main__':
    unittest.main(verbosity=2)
