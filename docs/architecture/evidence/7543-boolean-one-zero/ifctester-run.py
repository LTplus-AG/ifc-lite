# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# #7543: IfcTester's verdicts on <dir>/<case>.ifc against <dir>/<case>.ids.
#
#   python -I ifctester-run.py <dir> <case> [<case> ...]
#
# Needs IfcOpenShell and IfcTester (pip install ifcopenshell ifctester). The
# outputs here were made with ifcopenshell 0.8.4 and ifctester 0.8.3. The IDS
# is opened with validate=True, so it is checked against the IDS 1.0 XSD.
# Prints "  <spec>: <status>, applicable <n>, failed <n>" per specification,
# the same form run-files.mjs prints, so the two outputs can be diffed.
import os
import sys

import ifcopenshell
from ifctester import ids as idsmod

folder = sys.argv[1]
for case in sys.argv[2:]:
    print(f"=== ifctester {os.path.basename(os.path.normpath(folder))}/{case}")
    try:
        doc = idsmod.open(os.path.join(folder, case + ".ids"), validate=True)
        doc.validate(ifcopenshell.open(os.path.join(folder, case + ".ifc")))
    except Exception as e:  # report and go on to the next case
        print(f"  raised {type(e).__name__}: {e}")
        continue
    for s in doc.specifications:
        status = "pass" if s.status else "fail"
        print(f"  {s.name}: {status}, applicable {len(s.applicable_entities)}, failed {len(s.failed_entities)}")
