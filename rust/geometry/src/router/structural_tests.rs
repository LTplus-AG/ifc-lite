// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for #4206 structural reference geometry. Fixture-level tests in
//! `rust/processing/tests/issue_4206_structural_*_geometry.rs` cover exported
//! files; these synthetic entities isolate routing guards, face winding and
//! holes, plus edge degeneracy and perpendicular fallback behavior.

use super::{GeometryProcessor, GeometryRouter};
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

fn member(edge_start: &str, edge_end: &str, rep_type: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT({edge_start});#2=IFCVERTEXPOINT(#1);\
         #3=IFCCARTESIANPOINT({edge_end});#4=IFCVERTEXPOINT(#3);\
         #5=IFCEDGE(#2,#4);\
         #6=IFCTOPOLOGYREPRESENTATION($,'Reference','{rep_type}',(#5));\
         #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));\
         #8=IFCSTRUCTURALCURVEMEMBER('0000000000000000000000',$,'Member',$,$,$,#7,.RIGID_JOINED_MEMBER.,$);"
    )
}

pub(super) fn surface_member(same_sense: bool, with_hole: bool) -> String {
    let inner = if with_hole {
        "#7=IFCCARTESIANPOINT((4.,4.,0.));#8=IFCCARTESIANPOINT((6.,4.,0.));\
         #9=IFCCARTESIANPOINT((6.,6.,0.));#10=IFCCARTESIANPOINT((4.,6.,0.));\
         #11=IFCPOLYLOOP((#7,#8,#9,#10));#12=IFCFACEBOUND(#11,.T.);"
    } else {
        ""
    };
    let bounds = if with_hole { "(#6,#12)" } else { "(#6)" };
    let sense = if same_sense { ".T." } else { ".F." };
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((10.,0.,0.));\
         #3=IFCCARTESIANPOINT((10.,10.,0.));#4=IFCCARTESIANPOINT((0.,10.,0.));\
         #5=IFCPOLYLOOP((#1,#2,#3,#4));#6=IFCFACEOUTERBOUND(#5,.T.);{inner}\
         #13=IFCAXIS2PLACEMENT3D(#1,$,$);#14=IFCPLANE(#13);\
         #15=IFCFACESURFACE({bounds},#14,{sense});\
         #16=IFCTOPOLOGYREPRESENTATION($,'Reference','Face',(#15));\
         #17=IFCPRODUCTDEFINITIONSHAPE($,$,(#16));\
         #18=IFCSTRUCTURALSURFACEMEMBER('0000000000000000000000',$,'Surface',$,$,$,#17,.SHELL.,0.2);"
    )
}

fn bspline_surface_member_with_hole() -> String {
    surface_member(true, true).replace(
        "#14=IFCPLANE(#13);",
        "#14=IFCBSPLINESURFACEWITHKNOTS(1,1,((#1,#2),(#4,#3)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);",
    )
}

fn advanced_surface_member() -> String {
    surface_member(true, false).replace(
        "#15=IFCFACESURFACE((#6),#14,.T.);",
        "#15=IFCADVANCEDFACE((#6),#14,.T.,.F.);",
    )
}

fn edge_loop_surface_member() -> String {
    "#1=IFCCARTESIANPOINT((5000000.,5000000.,0.));
     #2=IFCCARTESIANPOINT((5000000.125,5000000.,0.));
     #3=IFCCARTESIANPOINT((5000000.125,5000000.125,0.));
     #4=IFCCARTESIANPOINT((5000000.,5000000.125,0.));
     #5=IFCVERTEXPOINT(#1);#6=IFCVERTEXPOINT(#2);
     #7=IFCVERTEXPOINT(#3);#8=IFCVERTEXPOINT(#4);
     #9=IFCDIRECTION((0.,0.,1.));#10=IFCDIRECTION((1.,0.,0.));
     #11=IFCAXIS2PLACEMENT3D(#1,#9,#10);#12=IFCPLANE(#11);
     #13=IFCLINE(#1,#20);#14=IFCLINE(#2,#21);
     #15=IFCLINE(#3,#22);#16=IFCLINE(#4,#23);
     #20=IFCVECTOR(#24,1.);#21=IFCVECTOR(#25,1.);
     #22=IFCVECTOR(#26,1.);#23=IFCVECTOR(#27,1.);
     #24=IFCDIRECTION((1.,0.,0.));#25=IFCDIRECTION((0.,1.,0.));
     #26=IFCDIRECTION((-1.,0.,0.));#27=IFCDIRECTION((0.,-1.,0.));
     #30=IFCEDGECURVE(#5,#6,#13,.T.);#31=IFCEDGECURVE(#6,#7,#14,.T.);
     #32=IFCEDGECURVE(#7,#8,#15,.T.);#33=IFCEDGECURVE(#8,#5,#16,.T.);
     #40=IFCORIENTEDEDGE(*,*,#30,.T.);#41=IFCORIENTEDEDGE(*,*,#31,.T.);
     #42=IFCORIENTEDEDGE(*,*,#32,.T.);#43=IFCORIENTEDEDGE(*,*,#33,.T.);
     #50=IFCEDGELOOP((#40,#41,#42,#43));#51=IFCFACEOUTERBOUND(#50,.T.);
     #52=IFCFACESURFACE((#51),#12,.T.);
     #53=IFCTOPOLOGYREPRESENTATION($,'Reference','Face',(#52));
     #54=IFCPRODUCTDEFINITIONSHAPE($,$,(#53));
     #55=IFCSTRUCTURALSURFACEMEMBER('0000000000000000000000',$,'Surface',$,$,$,#54,.SHELL.,0.2);"
        .to_string()
}

fn signed_xy_area(mesh: &crate::Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let point = |index: u32| {
                let base = index as usize * 3;
                [mesh.positions[base] as f64, mesh.positions[base + 1] as f64]
            };
            let [a, b, c] = [point(triangle[0]), point(triangle[1]), point(triangle[2])];
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0
        })
        .sum()
}

fn curved_member(orientation: bool) -> String {
    let oriented = if orientation {
        "#9=IFCORIENTEDEDGE(*,*,#8,.T.);"
    } else {
        "#9=IFCORIENTEDEDGE(*,*,#8,.F.);"
    };
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCVERTEXPOINT(#1);\
         #3=IFCCARTESIANPOINT((10.,0.,0.));#4=IFCVERTEXPOINT(#3);\
         #5=IFCCARTESIANPOINT((5.,5.,0.));\
         #6=IFCPOLYLINE((#1,#5,#3));\
         #8=IFCEDGECURVE(#2,#4,#6,.T.);{oriented}\
         #10=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#9));\
         #11=IFCPRODUCTDEFINITIONSHAPE($,$,(#10));\
         #12=IFCSTRUCTURALCURVEMEMBER('0000000000000000000000',$,'Curved member',$,$,$,#11,.RIGID_JOINED_MEMBER.,$);"
    )
}

fn midpoints(mesh: &crate::Mesh) -> ([f64; 3], [f64; 3]) {
    let p = |i: usize| {
        let b = i * 3;
        [
            mesh.positions[b] as f64 + mesh.origin[0],
            mesh.positions[b + 1] as f64 + mesh.origin[1],
            mesh.positions[b + 2] as f64 + mesh.origin[2],
        ]
    };
    let mid =
        |a: [f64; 3], b: [f64; 3]| [(a[0] + b[0]) / 2., (a[1] + b[1]) / 2., (a[2] + b[2]) / 2.];
    (mid(p(0), p(1)), mid(p(2), p(3)))
}

fn assert_normals_match_ribbon_winding(mesh: &crate::Mesh) {
    let p = |i: usize| {
        let b = i * 3;
        nalgebra::Vector3::new(
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        )
    };
    let face = (p(1) - p(0)).cross(&(p(3) - p(0))).normalize();
    for (i, values) in mesh.normals.chunks_exact(3).enumerate() {
        let normal = nalgebra::Vector3::new(values[0] as f64, values[1] as f64, values[2] as f64);
        assert!(
            normal.iter().all(|v| v.is_finite()),
            "normal {i} is not finite: {normal:?}"
        );
        assert!(
            (normal.norm() - 1.0).abs() < 1e-6,
            "normal {i} is not unit length: {normal:?}"
        );
        assert!(
            normal.dot(&face) > 1.0 - 1e-6,
            "normal {i} disagrees with triangle winding: normal={normal:?}, face={face:?}"
        );
    }
}

#[test]
fn accepts_structural_curve_member_edge_representation() {
    let source = member("(0.,0.,0.)", "(10.,0.,0.)", "Edge");
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(8).unwrap();
    assert!(super::structural::accepts(&entity, "Edge"));
}

#[test]
fn rejects_vertex_representation_type() {
    // The fixture behind this feature also carries 'Vertex'-typed
    // IfcTopologyRepresentations, but those belong to
    // IfcStructuralPointConnection, not a curve member, and are out of
    // scope for this processor.
    let source = member("(0.,0.,0.)", "(10.,0.,0.)", "Vertex");
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(8).unwrap();
    assert!(!super::structural::accepts(&entity, "Vertex"));
}

#[test]
fn rejects_non_structural_element_type() {
    // Gated on element type, not just rep_type: an ordinary element with an
    // (unrelated, hypothetical) 'Edge'-typed representation must not match.
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCVERTEXPOINT(#1);\
        #3=IFCCARTESIANPOINT((10.,0.,0.));#4=IFCVERTEXPOINT(#3);#5=IFCEDGE(#2,#4);\
        #6=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#5));\
        #7=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));\
        #8=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Proxy',$,$,$,#7,$);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(8).unwrap();
    assert_eq!(entity.ifc_type, IfcType::IfcBuildingElementProxy);
    assert!(!super::structural::accepts(&entity, "Edge"));
    assert!(!super::structural::accepts(&entity, "Face"));
}

#[test]
fn accepts_structural_surface_face_representation_only() {
    let source = surface_member(true, false);
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(18).unwrap();
    assert!(super::structural::accepts(&entity, "Face"));
    assert!(!super::structural::accepts(&entity, "Edge"));

    let curve_source = member("(0.,0.,0.)", "(10.,0.,0.)", "Face");
    let mut curve_decoder = EntityDecoder::new(&curve_source);
    let curve = curve_decoder.decode_by_id(8).unwrap();
    assert!(!super::structural::accepts(&curve, "Face"));
}

#[test]
fn structural_surface_polyloop_preserves_hole_and_same_sense() {
    let source = surface_member(true, true);
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(18).unwrap();
    let mesh = GeometryRouter::new()
        .process_element(&entity, &mut decoder)
        .unwrap();
    assert!(
        !mesh.is_empty(),
        "IfcFaceSurface must route to the standalone face processor"
    );
    assert!(
        (signed_xy_area(&mesh) - 96.0).abs() < 1e-5,
        "10x10 face with a 2x2 hole must retain 96 square units"
    );

    let reversed_source = surface_member(false, true);
    let mut reversed_decoder = EntityDecoder::new(&reversed_source);
    let reversed = reversed_decoder.decode_by_id(18).unwrap();
    let reversed_mesh = GeometryRouter::new()
        .process_element(&reversed, &mut reversed_decoder)
        .unwrap();
    assert!(
        (signed_xy_area(&reversed_mesh) + 96.0).abs() < 1e-5,
        "IfcFaceSurface.SameSense=.F. must reverse the emitted winding"
    );
}

#[test]
fn structural_surface_infers_outer_bound_independent_of_set_order() {
    let source = surface_member(true, true)
        .replace("#6=IFCFACEOUTERBOUND", "#6=IFCFACEBOUND")
        .replace("((#6,#12),#14", "((#12,#6),#14");
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(18).unwrap();
    let mesh = GeometryRouter::new()
        .process_element(&entity, &mut decoder)
        .unwrap();

    assert!((signed_xy_area(&mesh) - 96.0).abs() < 1e-5);
}

#[test]
fn structural_surface_routes_planar_advanced_face_subtype() {
    let source = advanced_surface_member();
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(18).unwrap();
    let mesh = GeometryRouter::new()
        .process_element(&entity, &mut decoder)
        .unwrap();

    assert!(
        !mesh.is_empty(),
        "planar IfcAdvancedFace must use the face processor"
    );
    assert!(
        (signed_xy_area(&mesh) - 100.0).abs() < 1e-5,
        "the 10x10 advanced face must retain its complete planar boundary"
    );
}

#[test]
fn structural_surface_rebases_raw_coordinates_before_f32_conversion() {
    let face_surface = surface_member(true, false)
        .replace("(0.,0.,0.)", "(5000000.,5000000.,0.)")
        .replace("(10.,0.,0.)", "(5000000.125,5000000.,0.)")
        .replace("(10.,10.,0.)", "(5000000.125,5000000.125,0.)")
        .replace("(0.,10.,0.)", "(5000000.,5000000.125,0.)");
    let advanced_face = face_surface.replace(
        "#15=IFCFACESURFACE((#6),#14,.T.);",
        "#15=IFCADVANCEDFACE((#6),#14,.T.,.F.);",
    );
    for source in [face_surface, advanced_face] {
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(18).unwrap();
        let mut router = GeometryRouter::new();
        router.set_rtc_offset((5_000_000.0, 5_000_000.0, 0.0));
        let mesh = router.process_element(&entity, &mut decoder).unwrap();

        let (min_x, max_x) = mesh
            .positions
            .chunks_exact(3)
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), point| {
                (min.min(point[0]), max.max(point[0]))
            });
        let (min_y, max_y) = mesh
            .positions
            .chunks_exact(3)
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), point| {
                (min.min(point[1]), max.max(point[1]))
            });
        assert_eq!((min_x, max_x), (0.0, 0.125));
        assert_eq!((min_y, max_y), (0.0, 0.125));
        assert!((signed_xy_area(&mesh) - 0.015625).abs() < 1e-9);
    }
}

#[test]
fn structural_edge_loop_surface_rebases_before_f32_conversion() {
    let source = edge_loop_surface_member();
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(55).unwrap();
    let mut router = GeometryRouter::new();
    router.set_rtc_offset((5_000_000.0, 5_000_000.0, 0.0));
    let mesh = router.process_element(&entity, &mut decoder).unwrap();

    assert!(!mesh.is_empty());
    assert!((signed_xy_area(&mesh) - 0.015625).abs() < 1e-9);
    assert!(mesh
        .positions
        .iter()
        .all(|coordinate| coordinate.abs() <= 0.125));
}

#[test]
fn structural_face_rtc_path_drains_curve_cap_diagnostics() {
    let source = edge_loop_surface_member().replace(
        "#13=IFCLINE(#1,#20);",
        "#13=IFCBSPLINECURVEWITHKNOTS(999999,(#1,#2,#3),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.));",
    );
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(55).unwrap();
    let router = GeometryRouter::with_rtc((5_000_000.0, 5_000_000.0, 0.0));
    let _ = router.process_element(&entity, &mut decoder).unwrap();

    let diagnostics = router.take_unsupported_items();
    assert_eq!(
        diagnostics.get("IfcBSplineCurveWithKnots"),
        Some(&1),
        "the direct element-aware RTC path must report its own capped curve"
    );

    let plain_source = surface_member(true, false);
    let mut plain_decoder = EntityDecoder::new(&plain_source);
    let plain = plain_decoder.decode_by_id(18).unwrap();
    let _ = router.process_element(&plain, &mut plain_decoder).unwrap();
    assert!(
        router.take_unsupported_items().is_empty(),
        "the cap flag must not leak to the next item on this worker"
    );
}

#[test]
fn structural_topology_participates_in_mixed_rtc_sampling() {
    let near_body = "#100=IFCCARTESIANPOINT((0.,0.,0.));#101=IFCPOLYLOOP((#100,#100,#100));\
         #102=IFCFACEOUTERBOUND(#101,.T.);#103=IFCFACE((#102));\
         #104=IFCCLOSEDSHELL((#103));#105=IFCFACETEDBREP(#104);\
         #106=IFCSHAPEREPRESENTATION($,'Body','Brep',(#105));\
         #107=IFCPRODUCTDEFINITIONSHAPE($,$,(#106));\
         #108=IFCBUILDINGELEMENTPROXY('1111111111111111111111',$,'Near',$,$,$,#107,$);";
    let source = format!("{near_body}{}", edge_loop_surface_member());
    let mut decoder = EntityDecoder::new(&source);
    let anchor = GeometryRouter::new().detect_rtc_anchor_for_file(source.as_bytes(), &mut decoder);

    assert_eq!(anchor, Some((5_000_000.0, 5_000_000.0, 0.0)));
}

#[test]
fn rotated_structural_surface_rebases_in_world_frame() {
    let source = format!(
        "{}{}",
        surface_member(true, false)
            .replace("(0.,0.,0.)", "(5000000.,5000000.,0.)")
            .replace("(10.,0.,0.)", "(5000000.125,5000000.,0.)")
            .replace("(10.,10.,0.)", "(5000000.125,5000000.125,0.)")
            .replace("(0.,10.,0.)", "(5000000.,5000000.125,0.)")
            .replace("$,$,#17", "$,#33,#17"),
        "#30=IFCCARTESIANPOINT((0.,0.,0.));#31=IFCDIRECTION((0.,0.,1.));\
         #32=IFCDIRECTION((0.,1.,0.));#34=IFCAXIS2PLACEMENT3D(#30,#31,#32);\
         #33=IFCLOCALPLACEMENT($,#34);"
    );
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(18).unwrap();
    let mut router = GeometryRouter::new();
    router.set_rtc_offset((-5_000_000.0, 5_000_000.0, 0.0));
    let mesh = router.process_element(&entity, &mut decoder).unwrap();

    let (min_x, max_x, min_y, max_y) = mesh.positions.chunks_exact(3).fold(
        (
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
        ),
        |(min_x, max_x, min_y, max_y), point| {
            (
                min_x.min(point[0]),
                max_x.max(point[0]),
                min_y.min(point[1]),
                max_y.max(point[1]),
            )
        },
    );
    assert_eq!((min_x, max_x), (-0.125, 0.0));
    assert_eq!((min_y, max_y), (0.0, 0.125));
    assert!((signed_xy_area(&mesh) - 0.015625).abs() < 1e-9);
    let local_bounds = mesh.local_bounds.expect("local bounds captured");
    assert_eq!(
        &local_bounds[..3],
        &[5_000_000.0, 5_000_000.0, 0.0],
        "RTC rendering must not move the public bounds out of object space"
    );
    // The f32 ULP at 5,000,000 m is 0.5 m, so the 0.125 m face cannot be
    // represented exactly; the published box must still ENCLOSE it rather
    // than collapse to a zero extent (#5026 review). Both maxima round up to
    // the next representable f32 above the minimum.
    for axis in 0..2 {
        assert!(
            local_bounds[axis + 3] > local_bounds[axis],
            "axis {axis} extent collapsed: {local_bounds:?}"
        );
        assert!(
            (local_bounds[axis + 3] as f64) >= 5_000_000.125
                && (local_bounds[axis + 3] as f64) <= 5_000_000.5,
            "axis {axis} maximum must be the enclosing f32: {local_bounds:?}"
        );
    }
    assert_eq!((local_bounds[2], local_bounds[5]), (0.0, 0.0));
}

pub(super) struct RegisteredFace;

impl GeometryProcessor for RegisteredFace {
    fn process(
        &self,
        _entity: &DecodedEntity,
        _decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        let mut mesh = Mesh::new();
        mesh.positions = vec![
            5_000_000.0,
            5_000_000.0,
            0.0,
            5_000_001.0,
            5_000_000.0,
            0.0,
            5_000_000.0,
            5_000_001.0,
            0.0,
        ];
        mesh.indices = vec![0, 1, 2];
        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFaceSurface, IfcType::IfcAdvancedFace]
    }
}

#[test]
fn structural_face_rtc_path_honors_registered_processor_in_element_frame() {
    let source = format!(
        "{}{}",
        surface_member(true, false)
            .replace("(0.,0.,0.)", "(5000000.,5000000.,0.)")
            .replace("(10.,0.,0.)", "(5000001.,5000000.,0.)")
            .replace("(10.,10.,0.)", "(5000001.,5000001.,0.)")
            .replace("(0.,10.,0.)", "(5000000.,5000001.,0.)")
            .replace("$,$,#17", "$,#33,#17"),
        "#30=IFCCARTESIANPOINT((0.,0.,0.));#31=IFCDIRECTION((0.,0.,1.));\
         #32=IFCDIRECTION((0.,1.,0.));#34=IFCAXIS2PLACEMENT3D(#30,#31,#32);\
         #33=IFCLOCALPLACEMENT($,#34);"
    );
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(18).unwrap();
    let mut router = GeometryRouter::with_rtc((-5_000_000.0, 5_000_000.0, 0.0));
    router.register(Box::new(RegisteredFace));
    let mesh = router.process_element(&entity, &mut decoder).unwrap();

    assert_eq!(
        mesh.positions,
        vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0, 0.0]
    );
    assert_eq!(mesh.indices, vec![0, 1, 2]);
    assert_eq!(
        mesh.local_bounds,
        Some([5_000_000.0, 5_000_000.0, 0.0, 5_000_001.0, 5_000_001.0, 0.0,]),
        "local bounds stay in the original pre-RTC object frame"
    );
}

#[test]
fn structural_surface_rejects_non_planar_faces_until_bounds_are_clipped() {
    let source = bspline_surface_member_with_hole();
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(18).unwrap();
    let mesh = GeometryRouter::new()
        .process_element(&entity, &mut decoder)
        .unwrap();

    assert!(
        mesh.is_empty(),
        "an unclipped B-spline domain must not fill or extend past IfcFaceSurface bounds"
    );
}

#[test]
fn straight_edge_meshes_to_a_ribbon_with_correct_endpoints() {
    let source = member("(0.,0.,0.)", "(10.,0.,0.)", "Edge");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(8).unwrap();

    let mesh = router.process_element(&entity, &mut decoder).unwrap();
    assert!(
        !mesh.is_empty(),
        "structural curve member must mesh to a ribbon"
    );
    assert_eq!(mesh.positions.len(), 4 * 3, "expected 4 ribbon vertices");
    assert_eq!(mesh.indices.len(), 6, "expected 2 triangles");

    let (start, end) = midpoints(&mesh);
    for axis in 0..3 {
        assert!(
            (start[axis] - [0., 0., 0.][axis]).abs() < 1e-6,
            "start: {start:?}"
        );
        assert!(
            (end[axis] - [10., 0., 0.][axis]).abs() < 1e-6,
            "end: {end:?}"
        );
    }
}

#[test]
fn edge_parallel_to_up_axis_uses_the_fallback_perpendicular() {
    // Direction is +Z, parallel to the ribbon's default "up" — the primary
    // cross(dir, Z) collapses to zero, so the processor must fall back to a
    // different axis rather than emitting a degenerate (zero-width) ribbon.
    let source = member("(0.,0.,0.)", "(0.,0.,10.)", "Edge");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(8).unwrap();

    let mesh = router.process_element(&entity, &mut decoder).unwrap();
    assert!(!mesh.is_empty());
    let (start, end) = midpoints(&mesh);
    assert!(
        (start[2] - 0.).abs() < 1e-6 && (end[2] - 10.).abs() < 1e-6,
        "{start:?} {end:?}"
    );

    // The ribbon must actually have width: the two paired vertices at each
    // end must not be coincident (a zero cross product would collapse them).
    let p = |i: usize| {
        let b = i * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    let (a, b) = (p(0), p(1));
    let width_sq = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2);
    assert!(
        width_sq > 1e-6,
        "ribbon collapsed to a zero-width line: {a:?} vs {b:?}"
    );
    assert_normals_match_ribbon_winding(&mesh);
}

#[test]
fn sloped_edge_normals_match_the_triangle_winding() {
    let source = member("(1.,2.,3.)", "(8.,-4.,13.)", "Edge");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(8).unwrap();

    let mesh = router.process_element(&entity, &mut decoder).unwrap();
    assert!(!mesh.is_empty());
    assert_normals_match_ribbon_winding(&mesh);
}

#[test]
fn zero_length_edge_meshes_empty_instead_of_producing_nan_geometry() {
    let source = member("(5.,5.,5.)", "(5.,5.,5.)", "Edge");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(8).unwrap();

    let mesh = router.process_element(&entity, &mut decoder).unwrap();
    assert!(
        mesh.is_empty(),
        "a zero-length edge has no direction to build a ribbon from"
    );
}

#[test]
fn edge_curve_uses_its_authored_geometry_instead_of_collapsing_to_a_chord() {
    let source = curved_member(true).replace("(#9)", "(#8)");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(12).unwrap();

    let mesh = router.process_element(&entity, &mut decoder).unwrap();
    assert_eq!(
        mesh.indices.len(),
        12,
        "the two authored polyline spans each need a ribbon quad"
    );
    assert_eq!(
        mesh.positions.len(),
        6 * 3,
        "the two spans must share one vertex pair at their bend"
    );
    assert!(
        mesh.positions
            .chunks_exact(3)
            .any(|point| (point[1] - 5.0).abs() < 0.2),
        "the intermediate authored point must survive; a straight endpoint chord would stay at y=0"
    );
}

#[test]
fn oriented_edge_reverses_the_underlying_curve_walk() {
    let source = curved_member(false);
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(12).unwrap();

    let mesh = router.process_element(&entity, &mut decoder).unwrap();
    assert_eq!(mesh.indices.len(), 12);
    let (first, _) = midpoints(&mesh);
    assert!(
        (first[0] - 10.0).abs() < 1e-6,
        "Orientation=.F. must begin at EdgeEnd: {first:?}"
    );
}

#[test]
fn bent_edge_is_one_continuous_indexed_ribbon() {
    let source = curved_member(true).replace("(#9)", "(#8)");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(12).unwrap();

    let mesh = router.process_element(&entity, &mut decoder).unwrap();
    assert_eq!(mesh.positions.len(), 6 * 3);
    assert_eq!(mesh.indices, vec![0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4]);
    let bend = midpoints(&mesh).1;
    assert!(
        (bend[0] - 5.0).abs() < 1e-6 && (bend[1] - 5.0).abs() < 1e-6,
        "the shared indexed join must remain centred on the authored bend: {bend:?}"
    );
}

#[test]
fn oriented_edge_cycle_fails_loudly_instead_of_recursing() {
    let source = "#9=IFCORIENTEDEDGE(*,*,#9,.T.);\
        #10=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#9));\
        #11=IFCPRODUCTDEFINITIONSHAPE($,$,(#10));\
        #12=IFCSTRUCTURALCURVEMEMBER('0000000000000000000000',$,'Cyclic member',$,$,$,#11,.RIGID_JOINED_MEMBER.,$);";
    let mut decoder = EntityDecoder::new(source);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(12).unwrap();

    let error = router.process_element(&entity, &mut decoder).unwrap_err();
    assert!(error.to_string().contains("cycle"), "{error}");
}
