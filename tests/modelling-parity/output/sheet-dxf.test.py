# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
import importlib.util
import io
import unittest
from pathlib import Path

import ezdxf

spec = importlib.util.spec_from_file_location('sheet', Path(__file__).with_name('sheet-dxf.py'))
sheet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sheet)


def fixture(dimension_text=True, empty=False):
    doc = ezdxf.new('R12')
    for name in ['IFC-CUT', 'IFC-FILL', 'IFC-DIMENSIONS']:
        doc.layers.new(name)
    model = doc.modelspace()
    if not empty:
        for x in [-.1, 4.9]:
            model.add_polyline2d([(x, 0), (x+.2, 0), (x+.2, 3), (x, 3)], close=True, dxfattribs={'layer': 'IFC-FILL'})
        model.add_line((-.1, 1.5), (5.1, 1.5), dxfattribs={'layer': 'IFC-DIMENSIONS'})
        if dimension_text:
            model.add_text('5.20 m', dxfattribs={'layer': 'IFC-DIMENSIONS', 'height': .15})
    stream = io.StringIO()
    doc.write(stream)
    return '999\nunits: metres\n' + stream.getvalue()


class OracleTests(unittest.TestCase):
    def test_9296_valid_section(self):
        self.assertTrue(all(c['ok'] for c in sheet.judge(fixture())['checks']))

    def test_9296_empty_dxf_rejected(self):
        self.assertFalse(all(c['ok'] for c in sheet.judge(fixture(empty=True))['checks']))

    def test_9296_missing_dimension_text_rejected(self):
        result = sheet.judge(fixture(dimension_text=False))
        self.assertFalse(next(c['ok'] for c in result['checks'] if c['name'].startswith('5.2 m')))

    def test_9296_missing_layers_rejected(self):
        self.assertFalse(all(c['ok'] for c in sheet.judge(fixture().replace('IFC-FILL', '0'))['checks']))

    def test_9296_wrong_scale_rejected(self):
        self.assertFalse(all(c['ok'] for c in sheet.judge(fixture().replace('4.9', '9.9'))['checks']))


if __name__ == '__main__':
    unittest.main()
