# SPDX-License-Identifier: MPL-2.0
"""#7908 oracle controls: mutate real IFC entities, retaining EXPRESS ids."""

import unittest

import ifcopenshell

from probe_section_export import check_fill_links, check_placement


def fixture():
    model = ifcopenshell.file(schema="IFC4")
    point = model.create_entity("IfcCartesianPoint", Coordinates=(0., 0., 0.))
    axis = model.create_entity("IfcAxis2Placement3D", Location=point)
    parent = model.create_entity("IfcLocalPlacement", RelativePlacement=axis)
    placement = model.create_entity("IfcLocalPlacement", PlacementRelTo=parent, RelativePlacement=axis)
    opening = model.create_entity("IfcOpeningElement", GlobalId=ifcopenshell.guid.new(), ObjectPlacement=placement)
    fill = model.create_entity("IfcFlowSegment", GlobalId=ifcopenshell.guid.new(), ObjectPlacement=placement)
    relation = model.create_entity("IfcRelFillsElement", GlobalId=ifcopenshell.guid.new(),
                                   RelatingOpeningElement=opening, RelatedBuildingElement=fill)
    return model, fill.id(), relation.id(), point.id()


class OracleControls(unittest.TestCase):
    def setUp(self):
        self.source, self.fill, self.relation, self.point = fixture()
        self.output = ifcopenshell.file.from_string(self.source.to_string())

    def check_links(self):
        check_fill_links(self.source, self.output, {e.id() for e in self.output})

    def test_unchanged_roundtrip_passes(self):
        self.check_links()
        check_placement(self.source.by_id(self.fill), self.output.by_id(self.fill))

    def test_missing_fill_relation_is_rejected(self):
        self.output.remove(self.output.by_id(self.relation))
        with self.assertRaisesRegex(AssertionError, "fill links changed"):
            self.check_links()

    def test_removed_endpoint_does_not_require_fill_relation(self):
        self.output.remove(self.output.by_id(self.relation))
        self.output.remove(self.output.by_id(self.fill))
        self.check_links()

    def test_same_placement_id_with_changed_coordinates_is_rejected(self):
        self.output.by_id(self.point).Coordinates = (0., 20., 0.)
        with self.assertRaisesRegex(AssertionError, "placement transform changed"):
            check_placement(self.source.by_id(self.fill), self.output.by_id(self.fill))

    def test_changed_parent_placement_is_rejected(self):
        placement = self.output.by_id(self.fill).ObjectPlacement
        point = self.output.create_entity("IfcCartesianPoint", Coordinates=(0., 20., 0.))
        placement.PlacementRelTo.RelativePlacement = self.output.create_entity("IfcAxis2Placement3D", Location=point)
        with self.assertRaisesRegex(AssertionError, "placement transform changed"):
            check_placement(self.source.by_id(self.fill), self.output.by_id(self.fill))


if __name__ == "__main__":
    unittest.main()
