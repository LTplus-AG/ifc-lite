# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Generate the #4206 structural edge-curve interoperability fixture.

The fixture is authored by this project and serialized through IfcOpenShell
0.8.3.post2's IFC4 exporter. That exact version reproduces the catalogued
fixture hash; other builds may serialize different bytes. Run with an output
path as the first argument.

`--coverage <IFC2X3|IFC4|IFC4X3>` instead writes the structural coverage
fixture for that schema (tests/structural-coverage): every concrete
structural-analysis entity the schema defines, once, with known values, so
the entity types no real exported file carries still have a fixture. For
IFC4, IfcSurfaceReinforcementArea goes to a sibling `_reinforcement` file.
It does not touch the default output above.
"""

from pathlib import Path
import sys
import uuid

import ifcopenshell
import ifcopenshell.guid


def stable_guid(name: str) -> str:
    value = uuid.uuid5(uuid.NAMESPACE_URL, f"ifc-lite:#4206:{name}")
    return ifcopenshell.guid.compress(value.hex)


def write(model, output: Path, purpose: str, time_stamp: str, system: str) -> None:
    """Write `model` with the fixed, reproducible header every fixture here carries."""
    model.header.file_description.description = (
        "ViewDefinition [StructuralAnalysisView]",
        f"Authored by ifc-lite {purpose}; generated via IfcOpenShell exporter API",
    )
    model.header.file_name.name = output.name
    model.header.file_name.time_stamp = time_stamp
    model.header.file_name.author = ("ifc-lite contributors",)
    model.header.file_name.organization = ("LTplus AG",)
    model.header.file_name.preprocessor_version = f"IfcOpenShell {ifcopenshell.version}"
    model.header.file_name.originating_system = system
    model.header.file_name.authorization = "MPL-2.0"
    model.write(str(output))


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

    write(model, output, "for #4206", "2026-09-19T00:00:00", "ifc-lite #4206 fixture generator")


COVERAGE_SCHEMAS = {"IFC2X3": "IFC2X3", "IFC4": "IFC4", "IFC4X3": "IFC4X3_ADD2"}


def coverage(schema: str, output: Path, reinforcement: bool = False) -> None:
    """One record of every structural-analysis entity `schema` defines.

    With `reinforcement`, only the IfcSurfaceReinforcementArea instead: it has no
    IFC2X3 form and is not an IfcRoot, so the converter refuses any IFC4 file that
    holds it, and it must not take every other IFC4 entity's convert result with
    it. IFC4X3 has no convert level, so there it stays in the main file.
    """
    model = ifcopenshell.file(schema=COVERAGE_SCHEMAS[schema])
    declared = ifcopenshell.ifcopenshell_wrapper.schema_by_name(model.schema_identifier)

    def has(name: str) -> bool:
        try:
            declared.declaration_by_name(name)
            return True
        except Exception:
            return False

    v2 = schema == "IFC2X3"
    e = model.create_entity

    def guid(name: str) -> str:
        # The reinforcement file is a separate model, so its project needs its own GlobalId.
        return stable_guid(f"structural-coverage:{schema}:{'reinforcement:' if reinforcement else ''}{name}")

    def stiffness(kind: str, value: float):
        # IFC2X3 types stiffness as a plain measure, IFC4 as a select with an IfcBoolean branch.
        return value if v2 else e(kind, value)

    person = e("IfcPerson", None, "Coverage", None, None, None, None, None, None)
    org = e("IfcOrganization", None, "ifc-lite contributors", None, None, None)
    app = e("IfcApplication", org, "1", "ifc-lite structural coverage generator", "ifc-lite")
    owner = e("IfcOwnerHistory", e("IfcPersonAndOrganization", person, org, None), app, None, "NOCHANGE", None, None, None, 1758240000)
    origin = e("IfcCartesianPoint", (0.0, 0.0, 0.0))
    world = e("IfcAxis2Placement3D", origin, None, None)
    context = e("IfcGeometricRepresentationContext", None, "Model", 3, 1.0e-6, world, None)
    units = e("IfcUnitAssignment", (
        e("IfcSIUnit", None, "LENGTHUNIT", None, "METRE"),
        e("IfcSIUnit", None, "FORCEUNIT", None, "NEWTON"),
        e("IfcSIUnit", None, "PLANEANGLEUNIT", None, "RADIAN"),
        e("IfcSIUnit", None, "THERMODYNAMICTEMPERATUREUNIT", None, "DEGREE_CELSIUS"),
    ))
    project = e("IfcProject", guid("project"), owner, "Structural coverage", None, None, None, None, (context,), units)

    def save():
        output.parent.mkdir(parents=True, exist_ok=True)
        write(model, output, "for the structural coverage harness", "2026-11-10T00:00:00", "ifc-lite structural coverage fixture generator")

    def reinforcement_area():
        e("IfcSurfaceReinforcementArea", "Coverage reinforcement", (0.0005, 0.0005), (0.0004, 0.0004), 0.25)

    if reinforcement:
        reinforcement_area()
        save()
        return
    if schema == "IFC4X3":
        reinforcement_area()

    def place():
        # IFC2X3 allows one product per placement (PlacesObject SET [1:1]).
        return e("IfcLocalPlacement", None, world)

    direction = e("IfcDirection", (0.0, 0.0, 1.0))

    def root(name: str, *rest, tag: str = ""):
        return e(name, guid(name + tag), owner, f"Coverage {name}{tag}", None, None, *rest)

    def rep():
        return e("IfcShapeRepresentation", context, "Reference", "Point", (origin,))

    def aspect():
        """(shape, aspect): IFC2X3 binds a shape to one product and a representation to one use (WR11)."""
        shape = e("IfcProductDefinitionShape", None, None, (rep(),))
        return shape, e("IfcShapeAspect", (rep(),), "Coverage aspect", None, True, shape)

    def action_tail(predefined=None):
        # Curve and surface actions carry ProjectedOrTrue (and in IFC4 a PredefinedType); point actions carry neither.
        # IFC2X3: DestabilizingLoad, CausedBy[, ProjectedOrTrue]; IFC4: DestabilizingLoad[, ProjectedOrTrue, PredefinedType].
        if v2:
            return (False, None) + (("TRUE_LENGTH",) if predefined else ())
        return (False,) + (("TRUE_LENGTH", predefined) if predefined else ())

    # Loads and support conditions, with values a reader must return.
    single_force = e("IfcStructuralLoadSingleForce", "Coverage force", 0.0, 0.0, -1000.0, 0.0, 0.0, 0.0)
    warping_force = e("IfcStructuralLoadSingleForceWarping", "Coverage warping force", 0.0, 0.0, -500.0, 0.0, 0.0, 0.0, 12.5)
    linear_force = e("IfcStructuralLoadLinearForce", "Coverage line force", 0.0, 0.0, -250.0, 0.0, 0.0, 0.0)
    planar_force = e("IfcStructuralLoadPlanarForce", "Coverage area force", 0.0, 0.0, -2000.0)
    displacement = e("IfcStructuralLoadSingleDisplacement", "Coverage displacement", 0.0, 0.0, -0.002, 0.0, 0.0, 0.0)
    distortion = e("IfcStructuralLoadSingleDisplacementDistortion", "Coverage distortion", 0.0, 0.0, -0.001, 0.0, 0.0, 0.0, 0.0005)
    temperature = e("IfcStructuralLoadTemperature", "Coverage temperature", 30.0, 5.0, -5.0)
    configuration = None
    if has("IfcStructuralLoadConfiguration"):
        configuration = e("IfcStructuralLoadConfiguration", "Coverage configuration", (linear_force, linear_force), ((0.0,), (4.0,)))
    node = e("IfcBoundaryNodeCondition", "Coverage node support",
             *(stiffness("IfcLinearStiffnessMeasure", 1.0e9) for _ in range(3)), *(stiffness("IfcRotationalStiffnessMeasure", 0.0) for _ in range(3)))
    node_warping = e("IfcBoundaryNodeConditionWarping", "Coverage warping support",
                     *(stiffness("IfcLinearStiffnessMeasure", 1.0e9) for _ in range(3)), *(stiffness("IfcRotationalStiffnessMeasure", 0.0) for _ in range(3)),
                     stiffness("IfcWarpingMomentMeasure", 3.5))
    edge = e("IfcBoundaryEdgeCondition", "Coverage edge support",
             *(stiffness("IfcModulusOfLinearSubgradeReactionMeasure", 2.0e7) for _ in range(3)),
             *(stiffness("IfcModulusOfRotationalSubgradeReactionMeasure", 0.0) for _ in range(3)))
    face = e("IfcBoundaryFaceCondition", "Coverage face support",
             *(stiffness("IfcModulusOfSubgradeReactionMeasure", 5.0e6) for _ in range(3)))
    failure = e("IfcFailureConnectionCondition", "Coverage failure", 1.0e5, 1.0e5, 1.0e5, 2.0e5, 2.0e5, 2.0e5)
    slippage = e("IfcSlippageConnectionCondition", "Coverage slippage", 0.001, 0.001, 0.0)

    # Members and connections.
    curve = root("IfcStructuralCurveMember", place(), None, "RIGID_JOINED_MEMBER", *(() if v2 else (direction,)))
    root("IfcStructuralCurveMemberVarying", place(), None, "RIGID_JOINED_MEMBER", *(() if v2 else (direction,)))
    surface = root("IfcStructuralSurfaceMember", place(), None, "SHELL", 0.2)
    if v2:
        shape, varying = aspect()
        root("IfcStructuralSurfaceMemberVarying", place(), shape, "SHELL", 0.2, (0.25, 0.3), varying)
    else:
        root("IfcStructuralSurfaceMemberVarying", place(), None, "SHELL", 0.2)
    point_conn = root("IfcStructuralPointConnection", place(), None, node_warping, *(() if v2 else (None,)))
    curve_conn = root("IfcStructuralCurveConnection", place(), None, edge, *(() if v2 else (direction,)))
    surface_conn = root("IfcStructuralSurfaceConnection", place(), None, face)

    # Activities: actions and reactions of every kind the schema has.
    activities = [
        root("IfcStructuralPointAction", place(), None, single_force, "GLOBAL_COORDS", *action_tail()),
        # Linear and planar actions are constant by WHERE rule (ConstPredefinedType).
        root("IfcStructuralLinearAction", place(), None, linear_force, "GLOBAL_COORDS", *action_tail("CONST")),
        root("IfcStructuralPlanarAction", place(), None, planar_force, "GLOBAL_COORDS", *action_tail("CONST")),
    ]
    if v2:
        for name, load in [("IfcStructuralLinearActionVarying", linear_force), ("IfcStructuralPlanarActionVarying", planar_force)]:
            shape, varying = aspect()
            activities.append(root(name, place(), shape, load, "GLOBAL_COORDS", False, None, "TRUE_LENGTH", varying, (load, load)))
    else:
        activities.append(root("IfcStructuralCurveAction", place(), None, configuration, "GLOBAL_COORDS", *action_tail("LINEAR")))
        activities.append(root("IfcStructuralSurfaceAction", place(), None, temperature, "GLOBAL_COORDS", *action_tail("CONST")))
    reactions = [root("IfcStructuralPointReaction", place(), None, displacement, "GLOBAL_COORDS")]
    if not v2:
        reactions.append(root("IfcStructuralCurveReaction", place(), None, linear_force, "GLOBAL_COORDS", "CONST"))
        reactions.append(root("IfcStructuralSurfaceReaction", place(), None, planar_force, "GLOBAL_COORDS", "CONST"))
    activities.append(root("IfcStructuralPointAction", place(), None, warping_force, "GLOBAL_COORDS", *action_tail(), tag=" warping"))
    activities.append(root("IfcStructuralPointAction", place(), None, distortion, "GLOBAL_COORDS", *action_tail(), tag=" distortion"))

    # Relationships.
    def rel(name: str, *rest):
        return e(name, guid(f"{name}:{len(model.by_type(name))}"), owner, None, None, *rest)

    rel("IfcRelConnectsStructuralMember", curve, point_conn, node, failure, 5.0, None)
    rel("IfcRelConnectsStructuralMember", surface, curve_conn, edge, slippage, None, None)
    rel("IfcRelConnectsStructuralMember", surface, surface_conn, face, None, None, None)
    rel("IfcRelConnectsWithEccentricity", curve, point_conn, None, None, None, None,
        e("IfcConnectionPointEccentricity", origin, None, 0.1, 0.0, -0.05))
    def host(activity):
        kind = activity.is_a()
        return point_conn if "Point" in kind else surface if "Surface" in kind or "Planar" in kind else curve

    # IFC2X3 requires every activity to be attached to an item (AssignedToStructuralItem).
    for activity in activities + reactions:
        rel("IfcRelConnectsStructuralActivity", host(activity), activity)
    if has("IfcRelConnectsStructuralElement"):
        beam = e("IfcBeam", guid("beam"), owner, "Coverage physical beam", None, None, place(), None, None)
        rel("IfcRelConnectsStructuralElement", beam, curve)

    # Groups and the analysis model.
    group = root("IfcStructuralLoadGroup", "LOAD_GROUP", "PERMANENT_G", "DEAD_LOAD_G", 1.35, None)
    groups = [group]
    if has("IfcStructuralLoadCase"):
        groups.append(root("IfcStructuralLoadCase", "LOAD_CASE", "VARIABLE_Q", "LIVE_LOAD_Q", 1.5, None, (0.0, 0.0, -1.0)))
    result = root("IfcStructuralResultGroup", "FIRST_ORDER_THEORY", group, True)
    rel("IfcRelAssignsToGroup", activities, None, group)
    rel("IfcRelAssignsToGroup", reactions, None, result)
    model_rest = ("LOADING_3D", None, groups, (result,)) + (() if v2 else (None,))
    analysis = root("IfcStructuralAnalysisModel", *model_rest)
    rel("IfcRelAssignsToGroup", [curve, surface, point_conn, curve_conn, surface_conn], None, analysis)
    if has("IfcRelDeclares"):
        rel("IfcRelDeclares", project, (analysis,))

    save()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--coverage":
        schema = sys.argv[2].upper() if len(sys.argv) > 2 else ""
        if schema not in COVERAGE_SCHEMAS:
            sys.exit(f"usage: {sys.argv[0]} --coverage <{'|'.join(COVERAGE_SCHEMAS)}> [output.ifc]")
        default = f"tests/models/ifcopenshell/generated_structural_coverage_{schema.lower()}.ifc"
        output = Path(sys.argv[3] if len(sys.argv) > 3 else default)
        coverage(schema, output)
        if schema == "IFC4":  # the one schema with both a convert level and IfcSurfaceReinforcementArea
            coverage(schema, output.with_name(f"{output.stem}_reinforcement.ifc"), reinforcement=True)
    else:
        main()
