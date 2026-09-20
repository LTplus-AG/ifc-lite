# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Generate the #4206 structural edge-curve interoperability fixture.

The fixture is authored by this project and serialized through IfcOpenShell
0.8.3.post2's IFC4 exporter. That exact version reproduces the catalogued
fixture hash; other builds may serialize different bytes. Run with an output
path as the first argument.
"""

from pathlib import Path
import sys
import uuid

import ifcopenshell
import ifcopenshell.guid


def stable_guid(name: str) -> str:
    value = uuid.uuid5(uuid.NAMESPACE_URL, f"ifc-lite:#4206:{name}")
    return ifcopenshell.guid.compress(value.hex)


def main() -> None:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        "tests/models/ifcopenshell/generated_structural_edge_curve.ifc"
    )
    output.parent.mkdir(parents=True, exist_ok=True)

    model = ifcopenshell.file(schema="IFC4")
    origin = model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    z_axis = model.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    x_axis = model.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
    world = model.create_entity(
        "IfcAxis2Placement3D", Location=origin, Axis=z_axis, RefDirection=x_axis
    )
    context = model.create_entity(
        "IfcGeometricRepresentationContext",
        ContextIdentifier=None,
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1.0e-6,
        WorldCoordinateSystem=world,
        TrueNorth=None,
    )

    def cartesian(x: float, y: float, z: float = 0.0):
        return model.create_entity("IfcCartesianPoint", Coordinates=(x, y, z))

    def vertex(point):
        return model.create_entity("IfcVertexPoint", VertexGeometry=point)

    def member(name: str, item):
        representation = model.create_entity(
            "IfcTopologyRepresentation",
            ContextOfItems=context,
            RepresentationIdentifier="Reference",
            RepresentationType="Edge",
            Items=(item,),
        )
        shape = model.create_entity(
            "IfcProductDefinitionShape", Name=None, Description=None,
            Representations=(representation,),
        )
        return model.create_entity(
            "IfcStructuralCurveMember",
            GlobalId=stable_guid(name),
            OwnerHistory=None,
            Name=name,
            Description=None,
            ObjectType=None,
            ObjectPlacement=None,
            Representation=shape,
            PredefinedType="RIGID_JOINED_MEMBER",
            Axis=z_axis,
        )

    start = cartesian(0.0, 0.0)
    bend = cartesian(5.0, 5.0)
    end = cartesian(10.0, 0.0)
    polyline = model.create_entity("IfcPolyline", Points=(start, bend, end))
    polyline_edge = model.create_entity(
        "IfcEdgeCurve",
        EdgeStart=vertex(start),
        EdgeEnd=vertex(end),
        EdgeGeometry=polyline,
        SameSense=True,
    )
    reversed_edge = model.create_entity(
        "IfcOrientedEdge", EdgeElement=polyline_edge, Orientation=False
    )
    member("Generated reversed polyline", reversed_edge)

    circle_start = cartesian(10.0, 0.0)
    circle_end = cartesian(-10.0, 0.0)
    circle = model.create_entity("IfcCircle", Position=world, Radius=10.0)
    reverse_circle = model.create_entity(
        "IfcEdgeCurve",
        EdgeStart=vertex(circle_start),
        EdgeEnd=vertex(circle_end),
        EdgeGeometry=circle,
        SameSense=False,
    )
    member("Generated reverse-sense circle", reverse_circle)

    model.header.file_description.description = (
        "ViewDefinition [StructuralAnalysisView]",
        "Authored by ifc-lite for #4206; generated via IfcOpenShell exporter API",
    )
    model.header.file_name.name = output.name
    model.header.file_name.time_stamp = "2026-09-19T00:00:00"
    model.header.file_name.author = ("ifc-lite contributors",)
    model.header.file_name.organization = ("LTplus AG",)
    model.header.file_name.preprocessor_version = f"IfcOpenShell {ifcopenshell.version}"
    model.header.file_name.originating_system = "ifc-lite #4206 fixture generator"
    model.header.file_name.authorization = "MPL-2.0"
    model.write(str(output))


if __name__ == "__main__":
    main()
