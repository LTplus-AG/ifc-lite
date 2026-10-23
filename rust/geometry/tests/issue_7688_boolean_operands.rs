// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7688 (B6d): boolean operands the router used to drop or over-cut, and the
//! `IfcFacetedBrepWithVoids` item the registry did not route.
//!
//! Every case meshes a 2 x 2 x 2 host (x, y in [-1, 1], z in [0, 2]; volume 8)
//! through the public router and asserts the enclosed VOLUME, so a dropped
//! host (0), an un-applied cut (8), an unbounded over-cut (4) and the
//! intended result are four different numbers.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::{BoolFailureReason, GeometryRouter, Mesh};

/// The host: a 2 x 2 rectangle extruded 2 along +Z, plus the shared placement
/// and plane entities the cutters below reference.
///
/// - `#4` is the identity placement, `#11` sits at z = 1 (axis +Z).
/// - `#12` is the plane z = 1, normal +Z. With `AgreementFlag = .F.` the
///   half-space material is ABOVE it, so a DIFFERENCE keeps z in [0, 1].
const HOST: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
#2=IFCDIRECTION((0.,0.,1.));\n\
#3=IFCDIRECTION((1.,0.,0.));\n\
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n\
#5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);\n\
#6=IFCEXTRUDEDAREASOLID(#5,#4,#2,2.);\n\
#10=IFCCARTESIANPOINT((0.,0.,1.));\n\
#11=IFCAXIS2PLACEMENT3D(#10,#2,#3);\n\
#12=IFCPLANE(#11);\n";

/// The quarter-footprint boundary x, y in [0, 2] of Position `#4`. Above the
/// z = 1 plane it overlaps the host in x, y in [0, 1]: volume 1 removed.
const QUARTER_POLYLINE: &str = "#30=IFCCARTESIANPOINT((0.,0.));\n\
#31=IFCCARTESIANPOINT((2.,0.));\n\
#32=IFCCARTESIANPOINT((2.,2.));\n\
#33=IFCCARTESIANPOINT((0.,2.));\n\
#34=IFCPOLYLINE((#30,#31,#32,#33,#30));\n";

/// The same boundary as an `IfcIndexedPolyCurve`, the IFC4 exporters' form.
const QUARTER_INDEXED: &str =
    "#35=IFCCARTESIANPOINTLIST2D(((0.,0.),(2.,0.),(2.,2.),(0.,2.),(0.,0.)),$);\n\
#34=IFCINDEXEDPOLYCURVE(#35,$,.F.);\n";

struct Meshed {
    result: ifc_lite_geometry::Result<Mesh>,
    failures: Vec<BoolFailureReason>,
}

impl Meshed {
    fn volume(&self) -> f64 {
        let mesh = self.result.as_ref().expect("the boolean item must mesh, not error");
        mesh_volume(mesh)
    }

    fn assert_volume(&self, expected: f64, what: &str) {
        let volume = self.volume();
        assert!(
            (volume - expected).abs() < 1e-3,
            "{what}: volume {volume}, expected {expected}; failures {:?}",
            self.failures
        );
    }

    fn recorded(&self, wanted: impl Fn(&BoolFailureReason) -> bool) -> bool {
        self.failures.iter().any(wanted)
    }
}

/// Mesh representation item `#id` of `data` through a fresh router.
fn mesh_item(data: &str, id: u32) -> Meshed {
    let mut decoder = EntityDecoder::new(data);
    let entity = decoder.decode_by_id(id).expect("the item decodes");
    let router = GeometryRouter::new();
    let result = router.process_representation_item(&entity, &mut decoder);
    let failures = router
        .take_csg_failures()
        .into_values()
        .flatten()
        .map(|f| f.reason)
        .collect();
    Meshed { result, failures }
}

fn unsupported(reason: &BoolFailureReason) -> bool {
    matches!(reason, BoolFailureReason::UnsupportedOperand(_))
}

/// Fixture sanity: the plain half-space and the polyline-bounded one cut
/// exactly what the volumes above say. If these move, the fixture is wrong,
/// not the fixes below.
#[test]
fn issue_7688_fixture_controls() {
    let host = mesh_item(HOST, 6);
    host.assert_volume(8.0, "uncut host");

    let plain = format!("{HOST}#13=IFCHALFSPACESOLID(#12,.F.);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n");
    mesh_item(&plain, 20).assert_volume(4.0, "plain half-space");

    let bounded = format!("{HOST}{QUARTER_POLYLINE}\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n");
    let meshed = mesh_item(&bounded, 20);
    meshed.assert_volume(7.0, "polyline-bounded half-space");
    assert!(meshed.failures.is_empty(), "{:?}", meshed.failures);
}

/// PROC-S19: `IfcBoxedHalfSpace` is an `IfcHalfSpaceSolid` whose Enclosure is
/// only a computation hint. It used to fall through to the solid-operand
/// table, be filed `UnsupportedOperand`, and leave the host uncut (8).
#[test]
fn issue_7688_proc_s19_a_boxed_half_space_cuts_like_its_supertype() {
    let data = format!("{HOST}#14=IFCBOUNDINGBOX(#1,4.,4.,4.);\n\
        #13=IFCBOXEDHALFSPACE(#12,.F.,#14);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(4.0, "boxed half-space");
    assert!(!meshed.recorded(unsupported), "{:?}", meshed.failures);
}

/// PROC-S17: a half-space whose base surface is not an `IfcPlane`, or whose
/// plane has no usable Position, used to return `Err` through `?` and delete
/// the HOST with it. Like every other unreadable cutter, it now leaves the
/// host uncut (8) and records the dropped step.
#[test]
fn issue_7688_proc_s17_an_unreadable_half_space_keeps_the_host_and_records_it() {
    let cutters = [
        ("cylindrical base surface", "#40=IFCCYLINDRICALSURFACE(#11,1.);\n#13=IFCHALFSPACESOLID(#40,.F.);\n"),
        ("plane without Position", "#40=IFCPLANE($);\n#13=IFCHALFSPACESOLID(#40,.F.);\n"),
        ("dangling base surface", "#13=IFCHALFSPACESOLID(#99,.F.);\n"),
        (
            "bounded, cylindrical base surface",
            "#40=IFCCYLINDRICALSURFACE(#11,1.);\n#13=IFCPOLYGONALBOUNDEDHALFSPACE(#40,.F.,#4,#34);\n",
        ),
    ];
    for (what, cutter) in cutters {
        let data = format!("{HOST}{QUARTER_POLYLINE}{cutter}\
            #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n");
        let meshed = mesh_item(&data, 20);
        meshed.assert_volume(8.0, what);
        assert!(meshed.recorded(unsupported), "{what}: the dropped cut must be on record: {:?}", meshed.failures);
    }
}

/// PROC-S17, batched path: a chain of two bounded half-spaces goes through
/// `try_union_polygonal_chain` first, where the unreadable cutter's `?` used
/// to abort the whole item. It now defers to the sequential walk, which
/// applies the good cutter (7) and records the bad one.
#[test]
fn issue_7688_proc_s17_an_unreadable_cutter_in_a_bounded_chain_keeps_the_good_cut() {
    let data = format!("{HOST}{QUARTER_POLYLINE}\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #40=IFCCYLINDRICALSURFACE(#11,1.);\n\
        #41=IFCPOLYGONALBOUNDEDHALFSPACE(#40,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n\
        #21=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#20,#41);\n");
    let meshed = mesh_item(&data, 21);
    meshed.assert_volume(7.0, "chain with one unreadable cutter");
    let records = meshed.failures.iter().filter(|f| unsupported(f)).count();
    assert_eq!(records, 1, "one dropped cutter, one record: {:?}", meshed.failures);
}

/// PROC-S18: an `IfcIndexedPolyCurve` boundary used to be refused by the
/// IfcPolyline-only reader, so the step fell back to the UNBOUNDED plane clip
/// and removed the whole upper half (4) instead of the quarter (7).
#[test]
fn issue_7688_proc_s18_an_indexed_poly_curve_boundary_bounds_the_cut() {
    let data = format!("{HOST}{QUARTER_INDEXED}\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(7.0, "indexed-poly-curve-bounded half-space");
    assert!(
        !meshed.recorded(|f| matches!(f, BoolFailureReason::PolygonalBoundedHalfSpaceFallback)),
        "{:?}",
        meshed.failures
    );
}

/// An axis-aligned box `[lo, hi]` as an `IfcClosedShell` of six outward-wound
/// polyloop faces, numbered from `first` (the shell itself is `#first`).
fn box_shell(first: u32, lo: [f64; 3], hi: [f64; 3]) -> String {
    let corner = |i: usize| {
        [
            if i & 1 == 0 { lo[0] } else { hi[0] },
            if i & 2 == 0 { lo[1] } else { hi[1] },
            if i & 4 == 0 { lo[2] } else { hi[2] },
        ]
    };
    // Outward winding (right-hand rule) for each face, as corner indices.
    let faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]];
    let mut out = String::new();
    let point = |i: usize| first + 1 + i as u32;
    for i in 0..8 {
        let [x, y, z] = corner(i);
        out += &format!("#{}=IFCCARTESIANPOINT(({x:?},{y:?},{z:?}));\n", point(i));
    }
    let mut face_ids = Vec::new();
    for (k, f) in faces.iter().enumerate() {
        let base = first + 10 + 3 * k as u32;
        let refs: Vec<String> = f.iter().map(|&i| format!("#{}", point(i))).collect();
        out += &format!("#{}=IFCPOLYLOOP(({}));\n", base, refs.join(","));
        out += &format!("#{}=IFCFACEOUTERBOUND(#{},.T.);\n", base + 1, base);
        out += &format!("#{}=IFCFACE((#{}));\n", base + 2, base + 1);
        face_ids.push(format!("#{}", base + 2));
    }
    out += &format!("#{first}=IFCCLOSEDSHELL(({}));\n", face_ids.join(","));
    out
}

/// PROC-S6: `IfcFacetedBrepWithVoids` had no processor, so a hollow IFC2x3
/// faceted solid rendered nothing (the router refused the type). Its Outer
/// shell is attribute 0, exactly as on `IfcFacetedBrep`, and it now meshes
/// like one. The Voids are inner shells and stay unrendered, as
/// `IfcAdvancedBrepWithVoids` already does; the mesh encloses the Outer
/// volume.
#[test]
fn issue_7688_proc_s6_a_faceted_brep_with_voids_meshes_its_outer_shell() {
    let outer = box_shell(100, [-1.0, -1.0, 0.0], [1.0, 1.0, 2.0]);
    let inner = box_shell(200, [-0.5, -0.5, 0.5], [0.5, 0.5, 1.5]);
    let data = format!("{outer}{inner}#90=IFCFACETEDBREP(#100);\n#91=IFCFACETEDBREPWITHVOIDS(#100,(#200));\n");
    let plain = mesh_item(&data, 90);
    plain.assert_volume(8.0, "faceted brep control");
    let hollow = mesh_item(&data, 91);
    hollow.assert_volume(8.0, "faceted brep with voids");

    // And as a boolean operand: a hollow cutter is no longer `UnsupportedOperand`.
    // The cutter's Outer is the unit box x, y in [0, 2], z in [1, 3]: it
    // removes x, y in [0, 1], z in [1, 2] from the host, volume 1.
    let cutter = box_shell(300, [0.0, 0.0, 1.0], [2.0, 2.0, 3.0]);
    // The void lies wholly outside the host, so 7 is the IFC answer even
    // though the Voids are not rendered.
    let void = box_shell(400, [0.5, 0.5, 2.2], [1.5, 1.5, 2.8]);
    let cut = format!("{HOST}{cutter}{void}#91=IFCFACETEDBREPWITHVOIDS(#300,(#400));\n\
        #20=IFCBOOLEANRESULT(.DIFFERENCE.,#6,#91);\n");
    let meshed = mesh_item(&cut, 20);
    meshed.assert_volume(7.0, "host minus a faceted-brep-with-voids cutter");
    assert!(!meshed.recorded(unsupported), "{:?}", meshed.failures);
}

/// Sibling of PROC-S17 (same `?` shape, one line above it): a SecondOperand
/// reference that does not resolve used to return `Err` and delete the host.
/// The step is now dropped on record instead: DIFFERENCE and UNION keep the
/// host (8), INTERSECTION with nothing is empty, and nothing errors.
#[test]
fn issue_7688_an_unresolvable_second_operand_keeps_the_host_and_records_it() {
    for (operator, expected) in [("DIFFERENCE", 8.0), ("UNION", 8.0), ("INTERSECTION", 0.0)] {
        let data = format!("{HOST}#20=IFCBOOLEANRESULT(.{operator}.,#6,#99);\n");
        let meshed = mesh_item(&data, 20);
        meshed.assert_volume(expected, operator);
        assert!(
            meshed.recorded(|f| matches!(f, BoolFailureReason::EmptyOperand)),
            "{operator}: the dropped step must be on record: {:?}",
            meshed.failures
        );
    }
}

/// The guard PROC-S18 needs once other bounded curves are read: a boundary
/// that crosses itself (here an `IfcIndexedPolyCurve` bow-tie; in ISSUE_129,
/// composite curves whose arcs and lines do not meet) bounds nothing, and its
/// prism tore the host. It takes the recorded unbounded fallback (4), which is
/// also what main did for every non-polyline boundary.
#[test]
fn issue_7688_proc_s18_a_self_crossing_curve_boundary_takes_the_recorded_fallback() {
    let bow_tie = "#35=IFCCARTESIANPOINTLIST2D(((0.,0.),(2.,2.),(2.,0.),(0.,2.),(0.,0.)),$);\n\
        #34=IFCINDEXEDPOLYCURVE(#35,$,.F.);\n";
    let data = format!("{HOST}{bow_tie}\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(4.0, "self-crossing indexed boundary");
    assert!(
        meshed.recorded(|f| matches!(f, BoolFailureReason::PolygonalBoundedHalfSpaceFallback)),
        "{:?}",
        meshed.failures
    );
}

/// Control: the guard is scoped to the newly read curve types. An IfcPolyline
/// boundary that TOUCHES itself (vertex (1,0) lies on its first edge) was cut
/// bounded on main and still is (8 - 0.75 = 7.25), never the unbounded 4.
#[test]
fn issue_7688_proc_s18_a_self_touching_polyline_boundary_stays_bounded() {
    let pinch = "#30=IFCCARTESIANPOINT((0.,0.));\n\
        #31=IFCCARTESIANPOINT((2.,0.));\n\
        #32=IFCCARTESIANPOINT((2.,2.));\n\
        #33=IFCCARTESIANPOINT((1.,0.));\n\
        #36=IFCCARTESIANPOINT((0.,2.));\n\
        #34=IFCPOLYLINE((#30,#31,#32,#33,#36,#30));\n";
    let data = format!("{HOST}{pinch}\
        #13=IFCPOLYGONALBOUNDEDHALFSPACE(#12,.F.,#4,#34);\n\
        #20=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#6,#13);\n");
    let meshed = mesh_item(&data, 20);
    meshed.assert_volume(7.25, "self-touching polyline boundary");
    assert!(meshed.failures.is_empty(), "{:?}", meshed.failures);
}
