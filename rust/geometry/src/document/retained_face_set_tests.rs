// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::document::{GeometryDocument, RetainedRecipe};

fn sheet() -> RetainedFaceSet {
    RetainedFaceSet {
        source_id: 7,
        positions: vec![1000., 2000., 5., 1100., 2000., 5., 1100., 2100., 5., 1000., 2100., 5.],
        triangles: vec![0, 1, 2, 0, 2, 3],
        rows: vec![0, 0],
        row_count: 1,
        source_corners: Vec::new(),
        source_slots: Vec::new(),
        length_unit_scale: 0.001,
    }
}

#[test]
fn issue_8291_source_completion_keeps_authored_triangles_in_metres() {
    let mut document = GeometryDocument::new();
    let handle = document.add_retained_face_set(sheet()).unwrap();
    assert!(matches!(document.retained_recipe(handle).unwrap(), RetainedRecipe::FaceSet(_)));
    let request = document.prepare_retained(handle, 3).unwrap();
    let completion = request.source_exact_completion().unwrap();
    let mesh = &completion.tessellation;
    assert_eq!(mesh.indices, [0, 1, 2, 0, 2, 3]);
    assert_eq!(mesh.revision_local_faces, [0, 0]);
    assert_eq!(mesh.source_face_count, 1);
    assert_eq!(mesh.positions[3..6], [100. * 0.001, 0., 0.]);
    assert_eq!(mesh.flat_corner_normals[..3], [0., 0., 1.]);
    // Evaluation metres back to raw file units, through the sealed frame.
    let frame = nalgebra::Matrix4::from_column_slice(&completion.source_from_evaluation);
    let origin = frame.transform_point(&nalgebra::Point3::origin());
    assert_eq!((origin.x, origin.y, origin.z), (1000., 2000., 5.));
    document.validate_retained_completion(&completion, 3).unwrap();
}

#[test]
fn issue_8291_face_set_requests_are_format_3_source_family() {
    let mut document = GeometryDocument::new();
    let handle = document.add_retained_face_set(sheet()).unwrap();
    let request = document.prepare_retained(handle, 3).unwrap();
    assert_eq!(request.payload().format, 3);
    assert_eq!(request.payload().qualification, RegionQualification::SourceFaceSet);
}

#[test]
fn issue_8291_malformed_sets_refuse_at_lowering() {
    let cases: [(&str, fn(&mut RetainedFaceSet)); 6] = [
        ("corner past the point list", |f| f.triangles[5] = 4),
        ("row past the row count", |f| f.rows[1] = 1),
        ("rows and triangles disagree", |f| { f.rows.pop(); }),
        ("no triangles", |f| { f.triangles.clear(); f.rows.clear(); }),
        ("non-finite coordinate", |f| f.positions[4] = f64::NAN),
        ("invalid units", |f| f.length_unit_scale = 0.),
    ];
    for (label, mutate) in cases {
        let mut source = sheet();
        mutate(&mut source);
        assert!(matches!(source.lower(), Err(RetainedRefusal::InvalidSource(_))), "{label}");
    }
}

fn tetrahedron() -> RetainedFaceSet {
    RetainedFaceSet {
        positions: vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.],
        triangles: vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
        rows: vec![0, 1, 2, 3],
        row_count: 4,
        ..sheet()
    }
}

#[test]
fn issue_8291_only_a_closed_bounded_shell_admits_a_solid() {
    assert!(tetrahedron().admits_solid());
    assert!(!sheet().admits_solid(), "open sheet");
    let mut open = tetrahedron();
    open.triangles.truncate(9);
    open.rows.truncate(3);
    assert!(!open.admits_solid(), "a missing face leaves boundary edges");
    let mut duplicated = tetrahedron();
    duplicated.positions.extend_from_slice(&[1., 0., 0.]);
    duplicated.triangles[4] = 4;
    assert!(duplicated.admits_solid(), "a repeated point still closes by coordinate");
    let mut large = tetrahedron();
    for _ in 0..3000 {
        large.triangles.extend_from_slice(&[0, 2, 1, 0, 1, 2, 0, 2, 1]);
        large.rows.extend_from_slice(&[0, 0, 0]);
    }
    assert!(!large.admits_solid(), "past the adapter's triangle limit");
}
