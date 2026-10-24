#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Small real Git copy/patch fixtures; no SDK compilation or source-text tests."""
import importlib.util
import pathlib
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('prepare_sdk', pathlib.Path(__file__).parents[1] / 'prepare_sdk.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class Preparation(unittest.TestCase):
    def test_copy_patch_and_reentry_preserve_original(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            src = root / 'upstream'; src.mkdir()
            original = b'original\n'; repaired = b'repaired\n'
            (src / 'input.cpp').write_bytes(original)
            (src / 'LICENSE').write_bytes(b'upstream license\n')
            patch = root / 'change.patch'
            patch.write_text('diff --git a/input.cpp b/input.cpp\n--- a/input.cpp\n+++ b/input.cpp\n@@ -1 +1 @@\n-original\n+repaired\n')
            files = {'input.cpp': original, 'LICENSE': (src / 'LICENSE').read_bytes()}
            pins = {'path': 'input.cpp', 'inputSha256': prepare.sha(original),
                    'outputSha256': prepare.sha(repaired), 'patchSha256': prepare.sha(patch.read_bytes())}
            dst = root / 'build' / 'sdk'
            prepare.stage(files, dst, patch, pins, {'fixture': True})
            self.assertEqual((src / 'input.cpp').read_bytes(), original)
            self.assertEqual((dst / 'input.cpp').read_bytes(), repaired)
            self.assertEqual((dst / 'LICENSE').read_bytes(), (src / 'LICENSE').read_bytes())
            before = (dst / 'provenance.json').read_bytes()
            prepare.stage(files, dst, patch, pins, {'fixture': True})
            self.assertEqual((dst / 'provenance.json').read_bytes(), before)
            (dst / 'input.cpp').write_bytes(b'foreign edit\n')
            with self.assertRaises(RuntimeError):
                prepare.stage(files, dst, patch, pins, {'fixture': True})
            self.assertEqual((dst / 'input.cpp').read_bytes(), b'foreign edit\n')

    def test_output_pin_failure_does_not_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); patch = root / 'change.patch'
            patch.write_text('--- a/input.cpp\n+++ b/input.cpp\n@@ -1 +1 @@\n-original\n+repaired\n')
            pins = {'path': 'input.cpp', 'inputSha256': prepare.sha(b'original\n'),
                    'outputSha256': prepare.sha(b'wrong output'), 'patchSha256': prepare.sha(patch.read_bytes())}
            with self.assertRaises(RuntimeError):
                prepare.stage({'input.cpp': b'original\n'}, root / 'sdk', patch, pins, {})
            self.assertFalse((root / 'sdk').exists())
            self.assertEqual(list(root.glob('.sdk-prepare-*')), [])

    def test_input_mismatch_does_not_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); patch = root / 'change.patch'; patch.write_bytes(b'')
            pins = {'path': 'input.cpp', 'inputSha256': prepare.sha(b'expected'),
                    'outputSha256': prepare.sha(b'repaired'), 'patchSha256': prepare.sha(b'')}
            with self.assertRaises(RuntimeError):
                prepare.stage({'input.cpp': b'foreign input'}, root / 'sdk', patch, pins, {})
            self.assertFalse((root / 'sdk').exists())

    def test_bad_pins_leave_no_completed_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); patch = root / 'change.patch'; patch.write_bytes(b'bad patch')
            pins = {'path': 'input.cpp', 'inputSha256': prepare.sha(b'original'),
                    'outputSha256': prepare.sha(b'repaired'), 'patchSha256': prepare.sha(b'not this patch')}
            dst = root / 'sdk'
            with self.assertRaises(RuntimeError):
                prepare.stage({'input.cpp': b'original'}, dst, patch, pins, {})
            self.assertFalse(dst.exists())


if __name__ == '__main__':
    unittest.main()
