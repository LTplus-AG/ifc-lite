# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#7932: execute the compiled public help against real IFC property rows."""

import doctest
from pathlib import Path

import ifclite_geom


FIXTURE = (Path(__file__).resolve().parents[3]
           / "rust/export/tests/fixtures/c6_data_model_synthetic.ifc")


def test_entity_data_public_help_examples():
    example = doctest.DocTestParser().get_doctest(
        ifclite_geom.entity_data.__doc__,
        {"ifc_bytes": FIXTURE.read_bytes()},
        "ifclite_geom.entity_data", None, 0,
    )
    # Old compiled help has no examples: it must fail rather than pass 0/0.
    assert example.examples, "#7932: public entity_data help needs executable examples"
    result = doctest.DocTestRunner().run(example)
    assert result.attempted > 0, "#7932: public help examples must execute"
    assert result.failed == 0, "#7932: public help examples must match real entity_data output"
