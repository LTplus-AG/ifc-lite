# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""#9357: read the roof aggregate and independently union its plane solids."""
import ifcopenshell.geom
import ifcopenshell.util.shape


def roof_planes(roof):
    assert roof.Representation is None, 'Roof geometry belongs to aggregated slabs'
    parts = [part for rel in roof.IsDecomposedBy if rel.is_a('IfcRelAggregates')
             for part in rel.RelatedObjects]
    assert parts, 'No aggregated roof planes'
    items = []
    for part in parts:
        assert part.is_a('IfcSlab') and part.PredefinedType == 'ROOF'
        assert part.ObjectPlacement.PlacementRelTo == roof.ObjectPlacement
        position = part.ObjectPlacement.RelativePlacement
        assert all(abs(c) < 1e-12 for c in position.Location.Coordinates)
        assert position.Axis is None and position.RefDirection is None
        body, = [rep for rep in part.Representation.Representations if rep.RepresentationIdentifier == 'Body']
        item, = body.Items
        items.append(item)
    return parts, items


def union_volume(model, settings, items):
    solid = items[0]
    for item in items[1:]:
        solid = model.create_entity('IfcBooleanResult', 'UNION', solid, item)
    shape = ifcopenshell.geom.create_shape(settings, solid)
    geometry = getattr(shape, 'geometry', shape)
    return abs(ifcopenshell.util.shape.get_volume(geometry))
