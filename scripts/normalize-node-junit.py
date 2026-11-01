# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""Adapt Node's direct root testcases for Mergify CLI 2026.7.21.1 (#8525).

Only reporting changes: keep test outcomes and existing nested suites intact.
Print file sizes so CI records that the upload input exists and is non-empty.
"""
import glob
from pathlib import Path
import sys
import xml.etree.ElementTree as ET


def normalize(pattern):
    paths = sorted(glob.glob(pattern, recursive=True))
    if not paths:
        raise ValueError(f"No JUnit reports match {pattern}")
    for name in paths:
        path = Path(name)
        size = path.stat().st_size
        print(f"JUnit input: {path} ({size} bytes)", flush=True)
        if not size:
            raise ValueError(f"Empty JUnit report: {path}")
        tree = ET.parse(path)
        root = tree.getroot()
        cases = list(root.findall('testcase'))
        if root.tag == 'testsuites' and cases:
            suite = ET.SubElement(root, 'testsuite', name='node:test')
            for case in cases:
                root.remove(case)
                suite.append(case)
            tree.write(path, encoding='utf-8', xml_declaration=True)
            print(f"Wrapped {len(cases)} root testcases in {path}")


if __name__ == '__main__':
    for pattern in sys.argv[1:]:
        normalize(pattern)
