# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#6600: exercise native Python boundary using a stated graded-path invariant."""
import math
from pathlib import Path

import pytest
import ifclite_geom

MODEL = b"""ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((10000.,0.,1000.));
#12=IFCPOLYLINE((#10,#11));#20=IFCALIGNMENT('a',$,'Road',$,$,$,$,#12);
ENDSEC;END-ISO-10303-21;"""


def test_6600_graded_mm_axis_identity_endpoints_and_python_integer_keys():
    report = ifclite_geom.alignment_axes(MODEL, spacing_m=3)
    assert not report["diagnostics"]
    axis = report["axes"][20]
    assert axis["GlobalId"] == "a" and axis["Name"] == "Road"
    assert axis["geometric_horizontal_length_m"] == 10
    assert [s["geometric_horizontal_distance_m"] for s in axis["samples"]] == [0, 3, 6, 9, 10]
    assert axis["samples"][-1]["point"] == [10, 0, 1]
    for sample in axis["samples"]:
        assert math.isclose(sum(v*v for v in sample["tangent"]), 1, abs_tol=1e-12)


def test_6600_bounds_and_invalid_parameters():
    report = ifclite_geom.alignment_axes(MODEL, spacing_m=1e-300, max_samples_per_axis=3)
    assert len(report["axes"][20]["samples"]) == 3
    assert any(d["code"] == "axis_sample_limit" for d in report["diagnostics"])
    for value in [0, -1, float("nan"), float("inf")]:
        with pytest.raises(ValueError):
            ifclite_geom.alignment_axes(MODEL, spacing_m=value)
    with pytest.raises(ValueError):
        ifclite_geom.alignment_axes(b"\xff")


def test_6600_real_infrastructure_multiple_axes():
    fixture = Path(__file__).resolve().parents[3] / "tests/models/issues/844_terrain_and_alignment.ifc"
    if not fixture.exists():
        pytest.skip("run pnpm fixtures for infrastructure model844")
    report = ifclite_geom.alignment_axes(fixture.read_bytes(), max_samples_per_axis=50)
    assert set(report["axes"]) == {39, 59, 114, 134, 161}
    for axis in report["axes"].values():
        assert axis["samples"][0]["geometric_horizontal_distance_m"] == 0
        assert axis["samples"][-1]["geometric_horizontal_distance_m"] == axis["geometric_horizontal_length_m"]
        assert len(axis["samples"]) <= 50
