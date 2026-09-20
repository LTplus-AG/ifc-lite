# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Generate the #4206 structural surface-member geometry fixture.

The model is authored by this project and serialized through IfcOpenShell's
IFC4 exporter. Run with an output path as the first argument.
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
        "tests/models/ifcopenshell/generated_structural_surface_member.ifc"
    )
    output.parent.mkdir(parents=True, exist_ok=True)

    model = ifcopenshell.file(schema="IFC4")

    def point(x: float, y: float, z: float = 0.0):
        return model.create_entity("IfcCartesianPoint", Coordinates=(x, y, z))

    origin = point(0.0, 0.0, 0.0)
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
    millimetre = model.create_entity(
        "IfcSIUnit", UnitType="LENGTHUNIT", Prefix="MILLI", Name="METRE"
    )
    units = model.create_entity("IfcUnitAssignment", Units=(millimetre,))
    model.create_entity(
        "IfcProject",
        GlobalId=stable_guid("project"),
        OwnerHistory=None,
        Name="Structural surface fixture",
        Description=None,
        ObjectType=None,
        LongName=None,
        Phase=None,
        RepresentationContexts=(context,),
        UnitsInContext=units,
    )

    placement_origin = point(1000.0, 2000.0, 3000.0)
    placement_axis = model.create_entity(
        "IfcAxis2Placement3D",
        Location=placement_origin,
        Axis=z_axis,
        RefDirection=x_axis,
    )
    placement = model.create_entity(
        "IfcLocalPlacement", PlacementRelTo=None, RelativePlacement=placement_axis
    )

    outer_points = (
        point(0.0, 0.0), point(4000.0, 0.0),
        point(4000.0, 3000.0), point(0.0, 3000.0),
    )
    inner_points = (
        point(1500.0, 1000.0), point(2500.0, 1000.0),
        point(2500.0, 2000.0), point(1500.0, 2000.0),
    )
    outer_loop = model.create_entity("IfcPolyLoop", Polygon=outer_points)
    inner_loop = model.create_entity("IfcPolyLoop", Polygon=inner_points)
    outer_bound = model.create_entity(
        "IfcFaceOuterBound", Bound=outer_loop, Orientation=True
    )
    inner_bound = model.create_entity(
        "IfcFaceBound", Bound=inner_loop, Orientation=True
    )
    plane = model.create_entity("IfcPlane", Position=world)
    face = model.create_entity(
        "IfcFaceSurface",
        Bounds=(outer_bound, inner_bound),
        FaceSurface=plane,
        SameSense=True,
    )
    representation = model.create_entity(
        "IfcTopologyRepresentation",
        ContextOfItems=context,
        RepresentationIdentifier="Reference",
        RepresentationType="Face",
        Items=(face,),
    )
    shape = model.create_entity(
        "IfcProductDefinitionShape",
        Name=None,
        Description=None,
        Representations=(representation,),
    )
    model.create_entity(
        "IfcStructuralSurfaceMember",
        GlobalId=stable_guid("surface-member"),
        OwnerHistory=None,
        Name="Generated surface member with opening",
        Description=None,
        ObjectType=None,
        ObjectPlacement=placement,
        Representation=shape,
        PredefinedType="SHELL",
        Thickness=200.0,
    )

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
