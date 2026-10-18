# SPDX-License-Identifier: MPL-2.0
"""Comparison policy invariants, independent of numerical constructors."""
import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
spec=importlib.util.spec_from_file_location("scene_runner",Path(__file__).with_name("run.py"))
runner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
class DifferenceTests(unittest.TestCase):
    def test_vertex_uv_pairing_and_occurrence_multiplicity_are_not_sorted_away(self):
        left={"positions":["f32:00000000","f32:3f800000"],"uvs":["f32:00000000","f32:3f800000"]}
        right={**left,"uvs":list(reversed(left["uvs"]))}
        self.assertEqual(runner.first_difference(left,right)["path"],"$.uvs[0]")
        self.assertEqual(runner.first_difference([left,left],[left])["base_length"],2)
    def test_absence_and_signed_zero_are_not_normalized(self):
        self.assertIsNotNone(runner.first_difference({"texture":None},{"texture":{}}))
        self.assertIsNotNone(runner.first_difference("f32:00000000","f32:80000000"))
        self.assertIsNone(runner.first_difference({"color":[1,2]},{"color":[1,2]}))
    def test_capability_loss_cannot_pass_even_when_record_payloads_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for name,capability in [("base",True),("candidate",False)]:
                folder=root/name;folder.mkdir()
                (folder/"records.jsonl").write_text('{"channel":"scene.mesh","key":"0","value":[]}\n')
                (folder/"manifest.json").write_text(json.dumps({"input_sha256":"same actual input","mode":"full",
                    "scene_sha256":"same records","witnesses":{},"capabilities":{"texture":capability}}))
            result=runner.compare(root/"base",root/"candidate")
            self.assertFalse(result["equal"])
            self.assertEqual(result["capability_difference"]["path"],"$.texture")
if __name__=="__main__":unittest.main()
