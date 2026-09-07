# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Capacity gates preserve SHA identity and refusal records."""
import json
from pathlib import Path
import tempfile
import unittest
from capacity_guard import check


class CapacityContract(unittest.TestCase):
    def test_allowed_pair_records_identity_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=root/'projection.json';out=root/'permit.json'
            config.write_text(json.dumps({'reserveBytes':0,'models':[{'label':'fixture','fixtureSha256':'f'*64,'pairBudgetBytes':1}]}))
            result=check(config,'fixture',root,out)
            self.assertTrue(result['allowPair']);self.assertEqual(result['fixtureSha256'],'f'*64)
            with self.assertRaises(FileExistsError):check(config,'fixture',root,out)

    def test_insufficient_capacity_preserves_refusal_before_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=root/'projection.json';out=root/'refusal.json'
            config.write_text(json.dumps({'reserveBytes':2**62,'models':[{'label':'fixture','fixtureSha256':'f'*64,'pairBudgetBytes':1}]}))
            with self.assertRaises(RuntimeError):check(config,'fixture',root,out)
            result=json.loads(out.read_text());self.assertFalse(result['allowPair'])
            with self.assertRaises(ValueError):check(config,'missing',root,root/'bad.json')


if __name__=='__main__':unittest.main()
