// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for #4206 layer 4: `IfcStructuralCurveMember` edge geometry.
//! The fixture-level integration test (real coordinates from a real IFC
//! file) is `rust/processing/tests/issue_4206_structural_curve_member_geometry.rs`;
//! these synthetic-entity tests cover the guards that test can't isolate:
//! the `structural::accepts` predicate itself, the zero-length degenerate
//! check, and the "edge parallel to up" fallback perpendicular branch.

use super::GeometryRouter;
use ifc_lite_core::{EntityDecoder, IfcType};

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
