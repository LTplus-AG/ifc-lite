# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Behavioral APFS clone tests on owned synthetic evidence only."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from clone_duplicates import plan, apply, sha, set_xattrs, xattrs


class RetentionContract(unittest.TestCase):
    def test_exact_preservation_independent_inodes_and_cow_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            payload=b'0123456789abcdef'*8192
            paths=[]
            for name in ('a','b','c'):
                p=root/name/'semantic-v2.json';p.parent.mkdir();p.write_bytes(payload if name!='c' else payload+b'unique');paths.append(p)
            set_xattrs(paths[0], {b'user.source-only': b'source'})
            set_xattrs(paths[1], {b'user.target-only': b'target\x00bytes'})
            before={str(p):{'sha':sha(p),'inode':p.stat().st_ino,'mtime':p.stat().st_mtime_ns} for p in paths}
            plan(root,['a','b','c'],root/'plan.json')
            manifest=json.loads((root/'plan.json').read_text())
            self.assertEqual(manifest['estimatedDuplicateLogicalBytes'],len(payload))
            apply(root/'plan.json',root/'applied.jsonl')
            self.assertEqual(len({p.stat().st_ino for p in paths}),3)
            self.assertEqual(xattrs(paths[0]), {b'user.source-only': b'source'})
            self.assertEqual(xattrs(paths[1]), {b'user.target-only': b'target\x00bytes'})
            for p in paths:
                self.assertEqual(sha(p),before[str(p)]['sha'])
                self.assertEqual(p.stat().st_mtime_ns,before[str(p)]['mtime'])
                self.assertEqual(p.stat().st_nlink,1)
            self.assertEqual(paths[2].stat().st_ino,before[str(paths[2])]['inode'])
            with paths[1].open('r+b') as stream:stream.write(b'changed')
            self.assertEqual(sha(paths[0]),before[str(paths[0])]['sha'])
            self.assertEqual(paths[2].read_bytes(),payload+b'unique')

    def test_stale_plan_stops_before_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            for name in ('a','b'):
                p=root/name/'data-model.bin';p.parent.mkdir();p.write_bytes(b'identical')
            plan(root,['a','b'],root/'plan.json')
            before=(root/'a/data-model.bin').stat().st_ino
            (root/'b/data-model.bin').write_bytes(b'changed')
            with self.assertRaises(ValueError):apply(root/'plan.json',root/'applied.jsonl')
            self.assertEqual((root/'a/data-model.bin').stat().st_ino,before)
            self.assertFalse((root/'applied.jsonl').exists())

    def test_symlinks_hardlinks_and_overlapping_scopes_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();(root/'a').mkdir();(root/'a/data-model.bin').write_bytes(b'x')
            with self.assertRaises(ValueError):plan(root,['a','a'],root/'bad.json')
            (root/'b').mkdir();(root/'b/data-model.bin').symlink_to(root/'a/data-model.bin')
            with self.assertRaises(ValueError):plan(root,['b'],root/'bad.json')
            (root/'b/data-model.bin').unlink()
            os.link(root/'a/data-model.bin',root/'b/data-model.bin')
            with self.assertRaises(ValueError):plan(root,['a','b'],root/'bad.json')


if __name__=='__main__':unittest.main()
