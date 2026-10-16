// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7687 (B6c): curves and B-splines under advanced faces and profiles.
//!
//! Every test goes through the public router on a small hand-written file and
//! asserts a geometric invariant of the authored shape (a radius, a plane, a
//! bounding box), so none of them restates the implementation.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Process entity #1 through the public router. `Err` and an empty mesh both
/// mean "refused"; the tests that need geometry unwrap it.
fn process(data: &str) -> Option<Mesh> {
    let content = wrap(data);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(1).expect("decode");
    router.process_representation_item(&entity, &mut decoder).ok()
}

fn vertices(mesh: &Mesh) -> impl Iterator<Item = [f64; 3]> + '_ {
    mesh.positions
        .chunks_exact(3)
        .map(|p| [f64::from(p[0]), f64::from(p[1]), f64::from(p[2])])
}

fn meshed(data: &str) -> Mesh {
    let mesh = process(data).expect("the item meshes");
    assert!(!mesh.positions.is_empty(), "the item must produce vertices");
    assert!(mesh.positions.iter().all(|c| c.is_finite()), "non-finite vertex");
    mesh
}

fn refused(data: &str) -> bool {
    process(data).is_none_or(|mesh| mesh.positions.is_empty())
}

/// An `IfcAdvancedBrep` (#1) with one face on surface #10. The face's single
/// bound is an empty edge loop, so a surface of revolution sweeps a full turn.
const ONE_FACE: &str = "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n\
    #3=IFCADVANCEDFACE((#4),#10,.T.);\n#4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCEDGELOOP(());\n";

/// A surface of revolution about the world Z axis whose profile is curve #15.
/// `position` is the `IfcSweptSurface.Position` attribute as written.
fn revolved(position: &str, axis: &str, profile_curve: &str) -> String {
    format!(
        "{ONE_FACE}#10=IFCSURFACEOFREVOLUTION(#13,{position},#11);\n#11=IFCAXIS1PLACEMENT(#12,#14);\n\
         #12=IFCCARTESIANPOINT((0.,0.,0.));\n#14=IFCDIRECTION({axis});\n\
         #13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#15);\n{profile_curve}"
    )
}

/// A clamped cubic B-spline profile from (1,0,0) to (1,0,1), bulging to x=2.
const BSPLINE_PROFILE: &str = "#15=IFCBSPLINECURVEWITHKNOTS(3,(#16,#17,#18,#19),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.);\n\
    #16=IFCCARTESIANPOINT((1.,0.,0.));\n#17=IFCCARTESIANPOINT((2.,0.,0.3));\n\
    #18=IFCCARTESIANPOINT((2.,0.,0.7));\n#19=IFCCARTESIANPOINT((1.,0.,1.));\n";

/// PROC-S2: sampling a clamped B-spline at its end parameter returned the
/// origin, so the revolved profile gained a vertex on the axis and the
/// surface a spike to it. Every point of this profile is at radius >= 1.
#[test]
fn revolved_bspline_profile_has_no_origin_vertex_proc_s2_7687() {
    let mesh = meshed(&revolved("$", "(0.,0.,1.)", BSPLINE_PROFILE));
    let min_radius = vertices(&mesh).map(|[x, y, _]| x.hypot(y)).fold(f64::INFINITY, f64::min);
    assert!(min_radius > 0.99, "a vertex sits {min_radius} from the axis; the profile never comes closer than 1");
    let top = vertices(&mesh).map(|[_, _, z]| z).fold(f64::NEG_INFINITY, f64::max);
    assert!((top - 1.0).abs() < 1e-4, "the profile's last control point (z=1) must be reached, top z={top}");
}

/// PROC-S2 through the composite-edge path: a composite curve whose first
/// segment is a B-spline put the origin into the face loop. The face lies in
/// the plane z=5, so every vertex must too.
#[test]
fn composite_edge_with_bspline_segment_stays_in_face_plane_proc_s2_7687() {
    let data = "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4),#10,.T.);\n\
        #4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCEDGELOOP((#61,#62,#63));\n\
        #10=IFCPLANE(#11);\n#11=IFCAXIS2PLACEMENT3D(#12,$,$);\n#12=IFCCARTESIANPOINT((0.,0.,5.));\n\
        #21=IFCCARTESIANPOINT((0.,0.,5.));\n#22=IFCCARTESIANPOINT((4.,0.,5.));\n#23=IFCCARTESIANPOINT((2.,6.,5.));\n\
        #31=IFCVERTEXPOINT(#21);\n#32=IFCVERTEXPOINT(#22);\n#33=IFCVERTEXPOINT(#23);\n\
        #41=IFCPOLYLINE((#21,#22));\n#43=IFCPOLYLINE((#23,#21));\n\
        #42=IFCCOMPOSITECURVE((#44,#45),.F.);\n\
        #44=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#46);\n#45=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#47);\n\
        #46=IFCBSPLINECURVEWITHKNOTS(3,(#22,#24,#25,#26),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.);\n\
        #24=IFCCARTESIANPOINT((5.,1.,5.));\n#25=IFCCARTESIANPOINT((5.,3.,5.));\n#26=IFCCARTESIANPOINT((4.,4.,5.));\n\
        #47=IFCPOLYLINE((#26,#23));\n\
        #51=IFCEDGECURVE(#31,#32,#41,.T.);\n#52=IFCEDGECURVE(#32,#33,#42,.T.);\n#53=IFCEDGECURVE(#33,#31,#43,.T.);\n\
        #61=IFCORIENTEDEDGE(*,*,#51,.T.);\n#62=IFCORIENTEDEDGE(*,*,#52,.T.);\n#63=IFCORIENTEDEDGE(*,*,#53,.T.);\n";
    let mesh = meshed(data);
    for [x, y, z] in vertices(&mesh) {
        assert!((z - 5.0).abs() < 1e-4, "vertex ({x}, {y}, {z}) is off the face plane z=5");
    }
}

/// The swept-disk solid (#1) of radius 0.1 along a radius-5 circle placed by
/// #3 with Axis #5 and RefDirection #6.
fn circle_sweep(axis: &str, ref_direction: &str) -> String {
    format!(
        "#1=IFCSWEPTDISKSOLID(#2,0.1,$,$,$);\n#2=IFCCIRCLE(#3,5.);\n#3=IFCAXIS2PLACEMENT3D(#4,#5,#6);\n\
         #4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCDIRECTION({axis});\n#6=IFCDIRECTION({ref_direction});\n"
    )
}

/// PROC-13: a RefDirection that is not perpendicular to Axis was used as the
/// circle's X axis as written, tilting the circle out of the plane normal to
/// Axis (here by 17 degrees, 1.4 units at radius 5). IFC projects
/// RefDirection onto that plane.
#[test]
fn circle_directrix_lies_in_the_plane_normal_to_axis_proc_13_7687() {
    let mesh = meshed(&circle_sweep("(0.,0.,1.)", "(1.,0.,0.3)"));
    let reach = vertices(&mesh).map(|[_, _, z]| z.abs()).fold(0.0, f64::max);
    assert!(reach < 0.1 + 1e-3, "the tube leaves the plane z=0 by {reach}; its radius is 0.1");
}

/// PROC-13 / XCUT-26: a zero Axis normalised to NaN and the solid was lost.
/// The canonical placement reader falls back to +Z.
#[test]
fn circle_directrix_with_zero_axis_stays_finite_proc_13_7687() {
    let mesh = meshed(&circle_sweep("(0.,0.,0.)", "(1.,0.,0.)"));
    let reach = vertices(&mesh).map(|[_, _, z]| z.abs()).fold(0.0, f64::max);
    assert!(reach < 0.1 + 1e-3, "the zero Axis must fall back to +Z, reach {reach}");
}

/// XCUT-26 (deferred from S6a #7678 to this WP): a RefDirection parallel to
/// Axis made `Z x X` zero, normalised to NaN. The canonical reader picks a
/// perpendicular X, so the circle stays in the plane normal to Axis.
#[test]
fn circle_directrix_with_ref_direction_parallel_to_axis_stays_finite_xcut_26_7687() {
    let mesh = meshed(&circle_sweep("(0.,0.,1.)", "(0.,0.,1.)"));
    let reach = vertices(&mesh).map(|[_, _, z]| z.abs()).fold(0.0, f64::max);
    assert!(reach < 0.1 + 1e-3, "the circle must stay in z=0, reach {reach}");
}

/// Sibling of PROC-13 in `advanced_face/conics.rs`: a profile circle placed
/// by an `IfcAxis2Placement2D` had its RefDirection (attribute 1) read as the
/// 3D Axis, so the circle stood in the YZ plane. Revolved about Y, the
/// circle at (3,0) radius 1 sweeps a torus whose tube spans radius 2..4.
#[test]
fn revolved_circle_with_2d_placement_spans_its_radius_proc_13_7687() {
    let curve = "#15=IFCCIRCLE(#16,1.);\n#16=IFCAXIS2PLACEMENT2D(#17,#18);\n\
                 #17=IFCCARTESIANPOINT((3.,0.));\n#18=IFCDIRECTION((1.,0.));\n";
    let mesh = meshed(&revolved("$", "(0.,1.,0.)", curve));
    let radii = || vertices(&mesh).map(|[x, _, z]| x.hypot(z));
    let (min, max) = (radii().fold(f64::INFINITY, f64::min), radii().fold(0.0, f64::max));
    assert!(min < 2.0 + 1e-3 && max > 4.0 - 1e-3, "torus tube spans radius {min}..{max}, expected 2..4");
}

/// PROC-S24: `IfcSweptSurface.Position` places the profile and the axis; it
/// was ignored. Lifted to z=10, the unit-high profile sweeps z in [10, 11].
#[test]
fn surface_of_revolution_honours_position_proc_s24_7687() {
    let curve = "#15=IFCPOLYLINE((#16,#17));\n#16=IFCCARTESIANPOINT((1.,0.,0.));\n\
                 #17=IFCCARTESIANPOINT((1.,0.,1.));\n\
                 #20=IFCAXIS2PLACEMENT3D(#21,$,$);\n#21=IFCCARTESIANPOINT((0.,0.,10.));\n";
    let mesh = meshed(&revolved("#20", "(0.,0.,1.)", curve));
    for [x, y, z] in vertices(&mesh) {
        assert!((10.0 - 1e-4..=11.0 + 1e-4).contains(&z), "vertex ({x}, {y}, {z}) is outside z 10..11");
    }
}

/// PROC-S21: a profile polyline whose middle point does not resolve was
/// swept as the two-point profile that remains, a different surface.
#[test]
fn revolved_profile_with_unresolved_point_is_refused_proc_s21_7687() {
    let curve = "#15=IFCPOLYLINE((#16,#99,#17));\n#16=IFCCARTESIANPOINT((1.,0.,0.));\n\
                 #17=IFCCARTESIANPOINT((1.,0.,1.));\n";
    assert!(refused(&revolved("$", "(0.,0.,1.)", curve)));
}

/// A planar face at z=0 over the square (0,0)-(4,4) whose four edges are
/// `edges[i]`, each an `IfcEdgeCurve` written in full by the caller.
fn square_face(loop_refs: &str, extra: &str) -> String {
    format!(
        "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4),#10,.T.);\n\
         #4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCEDGELOOP(({loop_refs}));\n\
         #10=IFCPLANE(#11);\n#11=IFCAXIS2PLACEMENT3D(#12,$,$);\n#12=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #21=IFCCARTESIANPOINT((0.,0.,0.));\n#22=IFCCARTESIANPOINT((4.,0.,0.));\n\
         #23=IFCCARTESIANPOINT((4.,4.,0.));\n#24=IFCCARTESIANPOINT((0.,4.,0.));\n\
         #31=IFCVERTEXPOINT(#21);\n#32=IFCVERTEXPOINT(#22);\n#33=IFCVERTEXPOINT(#23);\n#34=IFCVERTEXPOINT(#24);\n\
         #42=IFCPOLYLINE((#22,#23));\n#43=IFCPOLYLINE((#23,#24));\n#44=IFCPOLYLINE((#24,#21));\n\
         #52=IFCEDGECURVE(#32,#33,#42,.T.);\n#53=IFCEDGECURVE(#33,#34,#43,.T.);\n#54=IFCEDGECURVE(#34,#31,#44,.T.);\n\
         #62=IFCORIENTEDEDGE(*,*,#52,.T.);\n#63=IFCORIENTEDEDGE(*,*,#53,.T.);\n#64=IFCORIENTEDEDGE(*,*,#54,.T.);\n\
         {extra}"
    )
}

/// The first edge (0,0)->(4,0) of [`square_face`], over curve #41.
const FIRST_EDGE: &str = "#51=IFCEDGECURVE(#31,#32,#41,.T.);\n#61=IFCORIENTEDEDGE(*,*,#51,.T.);\n";

/// The control case: the square meshes, so the refusals below are caused by
/// the one unresolved reference each introduces and nothing else.
#[test]
fn square_face_control_meshes_7687() {
    let extra = format!("{FIRST_EDGE}#41=IFCPOLYLINE((#21,#22));\n");
    meshed(&square_face("#61,#62,#63,#64", &extra));
}

/// PROC-S21: an edge-loop entry that does not resolve was skipped, so the
/// square meshed as the triangle of its other three corners.
#[test]
fn edge_loop_with_unresolved_edge_is_refused_proc_s21_7687() {
    assert!(refused(&square_face("#99,#62,#63,#64", "")));
}

/// PROC-S21: a polyline edge whose middle point does not resolve was
/// sampled without it.
#[test]
fn polyline_edge_with_unresolved_point_is_refused_proc_s21_7687() {
    let extra = format!("{FIRST_EDGE}#41=IFCPOLYLINE((#21,#99,#22));\n");
    assert!(refused(&square_face("#61,#62,#63,#64", &extra)));
}

/// PROC-S21: a B-spline edge whose control point does not resolve was
/// evaluated with the remaining points shifted against the knot vector.
#[test]
fn bspline_edge_with_unresolved_control_point_is_refused_proc_s21_7687() {
    let extra = format!(
        "{FIRST_EDGE}#41=IFCBSPLINECURVEWITHKNOTS(2,(#21,#99,#25,#22),.UNSPECIFIED.,.F.,.F.,(3,1,3),(0.,0.5,1.),.UNSPECIFIED.);\n\
         #25=IFCCARTESIANPOINT((3.,-1.,0.));\n"
    );
    assert!(refused(&square_face("#61,#62,#63,#64", &extra)));
}

/// PROC-S21: a control-point grid entry that is not a point reference was
/// skipped, leaving a ragged row misaligned with the knots.
#[test]
fn bspline_surface_with_non_reference_grid_entry_is_refused_proc_s21_7687() {
    let data = "#1=IFCBSPLINESURFACEWITHKNOTS(1,1,((#2,#3),(#4,$)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\n\
        #2=IFCCARTESIANPOINT((0.,0.,0.));\n#3=IFCCARTESIANPOINT((0.,1.,0.));\n#4=IFCCARTESIANPOINT((1.,0.,0.));\n";
    assert!(refused(data));
}

/// The control case for the surface: the full 2x2 grid meshes.
#[test]
fn bspline_surface_control_meshes_7687() {
    let data = "#1=IFCBSPLINESURFACEWITHKNOTS(1,1,((#2,#3),(#4,#5)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\n\
        #2=IFCCARTESIANPOINT((0.,0.,0.));\n#3=IFCCARTESIANPOINT((0.,1.,0.));\n#4=IFCCARTESIANPOINT((1.,0.,0.));\n\
        #5=IFCCARTESIANPOINT((1.,1.,0.));\n";
    meshed(data);
}

/// A planar `IfcAdvancedFace` (#1 is its brep) over the square (0,0)-(10,10)
/// with one hole, the poly-loop #10 over the points `hole`.
fn holed_face(hole: &str) -> String {
    format!(
        "#1=IFCADVANCEDBREP(#2);\n#2=IFCCLOSEDSHELL((#3));\n#3=IFCADVANCEDFACE((#4,#9),#20,.T.);\n\
         #4=IFCFACEOUTERBOUND(#5,.T.);\n#5=IFCPOLYLOOP((#11,#12,#13,#14));\n\
         #11=IFCCARTESIANPOINT((0.,0.,0.));\n#12=IFCCARTESIANPOINT((10.,0.,0.));\n\
         #13=IFCCARTESIANPOINT((10.,10.,0.));\n#14=IFCCARTESIANPOINT((0.,10.,0.));\n\
         #9=IFCFACEBOUND(#10,.T.);\n#10=IFCPOLYLOOP((#15,#16,#17));\n{hole}\
         #20=IFCPLANE(#21);\n#21=IFCAXIS2PLACEMENT3D(#11,$,$);\n"
    )
}

/// D14 control: the readable hole is cut, so the face has 7 vertices.
#[test]
fn holed_face_control_cuts_the_hole_d14_7687() {
    let hole = "#15=IFCCARTESIANPOINT((4.,4.,0.));\n#16=IFCCARTESIANPOINT((6.,4.,0.));\n\
                #17=IFCCARTESIANPOINT((5.,6.,0.));\n";
    assert_eq!(meshed(&holed_face(hole)).positions.len(), 7 * 3);
}

/// D14 (under D3): a hole whose point does not decode (`1.52.3`) was read as
/// an empty loop and skipped, so the face rendered FILLED over its opening.
/// An unreadable loop must refuse the face instead.
#[test]
fn unreadable_hole_refuses_the_face_d14_7687() {
    let hole = "#15=IFCCARTESIANPOINT((4.,4.,0.));\n#16=IFCCARTESIANPOINT((1.52.3,4.,0.));\n\
                #17=IFCCARTESIANPOINT((5.,6.,0.));\n";
    assert!(refused(&holed_face(hole)), "a face with an unreadable hole must not render filled");
}

/// D14 through an edge loop: a hole loop entry that does not resolve.
#[test]
fn unresolved_hole_edge_loop_refuses_the_face_d14_7687() {
    let data = holed_face("").replace(
        "#10=IFCPOLYLOOP((#15,#16,#17));\n",
        "#10=IFCEDGELOOP((#99));\n",
    );
    assert!(refused(&data), "a face with an unreadable hole must not render filled");
}
