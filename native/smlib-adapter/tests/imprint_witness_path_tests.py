#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""#7955/R2 real filesystem fixtures for witness publication; no SDK execution."""
import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('witness', pathlib.Path(__file__).with_name('prepare_imprint_witness.py'))
witness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(witness)
PRODUCTS = {'control.cpp': b'control fixture\n', 'reverse.cpp': b'reverse fixture\n',
            'provenance.json': b'{"fixture":true}\n'}


class WitnessPaths(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.foreign = self.root / 'foreign'; self.foreign.mkdir()
        self.sentinel = self.foreign / 'sentinel'
        self.sentinel.write_bytes(b'preserve foreign evidence\n')
        self.output = self.root / 'build' / 'witness'

    def refuse(self):
        before = {p.name: p.read_bytes() for p in self.foreign.iterdir() if p.is_file()}
        with self.assertRaises(RuntimeError):
            witness.publish_products(self.output, PRODUCTS)
        self.assertEqual({p.name: p.read_bytes() for p in self.foreign.iterdir() if p.is_file()}, before)
        self.assertEqual(self.sentinel.read_bytes(), b'preserve foreign evidence\n')

    def test_healthy_and_regular_reentry(self):
        witness.publish_products(self.output, PRODUCTS)
        before = {name: (self.output / name).stat() for name in PRODUCTS}
        witness.publish_products(self.output, PRODUCTS)
        for name, expected in PRODUCTS.items():
            path = self.output / name
            self.assertEqual(path.read_bytes(), expected)
            self.assertEqual(path.stat().st_ino, before[name].st_ino)
            self.assertEqual(path.stat().st_mtime_ns, before[name].st_mtime_ns)

    def test_linked_output_directory(self):
        self.output.parent.mkdir()
        self.output.symlink_to(self.foreign, target_is_directory=True)
        self.refuse()
        self.assertEqual(sorted(p.name for p in self.foreign.iterdir()), ['sentinel'])

    def test_linked_parent_directory(self):
        self.output.parent.symlink_to(self.foreign, target_is_directory=True)
        self.refuse()
        self.assertFalse((self.foreign / 'witness').exists())

    def test_dangling_output_and_parent(self):
        for parent in (False, True):
            with self.subTest(parent=parent):
                link = self.output.parent if parent else self.output
                link.parent.mkdir(exist_ok=True)
                missing = self.foreign / 'missing'
                link.symlink_to(missing, target_is_directory=True)
                self.refuse()
                self.assertFalse(missing.exists())
                link.unlink()
                if not parent:
                    self.output.parent.rmdir()

    def test_dangling_and_existing_product_links(self):
        self.output.mkdir(parents=True)
        for name in PRODUCTS:
            for dangling in (True, False):
                with self.subTest(name=name, dangling=dangling):
                    target = self.foreign / name
                    if not dangling:
                        target.write_bytes(PRODUCTS[name])  # Even equal bytes do not authorize a link.
                    link = self.output / name; link.symlink_to(target)
                    self.refuse()
                    self.assertEqual(sorted(p.name for p in self.output.iterdir()), [name])
                    link.unlink()
                    if not dangling:
                        target.unlink()

    def test_product_directory(self):
        self.output.mkdir(parents=True)
        (self.output / 'provenance.json').mkdir()
        self.refuse()
        self.assertFalse((self.output / 'control.cpp').exists())

    def test_changed_regular_product(self):
        witness.publish_products(self.output, PRODUCTS)
        changed = self.output / 'control.cpp'; changed.write_bytes(b'foreign change\n')
        self.refuse()
        self.assertEqual(changed.read_bytes(), b'foreign change\n')

    def test_link_inserted_at_exclusive_creation(self):
        real_open = os.open
        target = self.foreign / 'late-target'
        inserted = False

        def insert_link(name, flags, *args, **kwargs):
            nonlocal inserted
            if name == 'control.cpp' and flags & os.O_CREAT and not inserted:
                inserted = True
                (self.output / 'control.cpp').symlink_to(target)
            return real_open(name, flags, *args, **kwargs)

        # Keep capability detection truthful for the delegating instrumentation.
        with mock.patch.object(witness.os, 'open', insert_link), mock.patch.object(
                witness.os, 'supports_dir_fd', os.supports_dir_fd | {insert_link}):
            self.refuse()
        self.assertTrue(inserted)
        self.assertFalse(target.exists())
        self.assertTrue((self.output / 'control.cpp').is_symlink())

    def test_fifo_product(self):
        self.output.mkdir(parents=True)
        os.mkfifo(self.output / 'reverse.cpp')
        self.refuse()
        self.assertFalse((self.output / 'control.cpp').exists())

    def test_hardlinked_product(self):
        self.output.mkdir(parents=True)
        target = self.foreign / 'control.cpp'; target.write_bytes(PRODUCTS['control.cpp'])
        os.link(target, self.output / 'control.cpp')
        self.refuse()
        self.assertEqual(target.stat().st_nlink, 2)


if __name__ == '__main__':
    unittest.main()
