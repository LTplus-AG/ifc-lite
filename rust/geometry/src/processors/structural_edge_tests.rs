// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn face_normal(mesh: &Mesh, triangle: usize) -> Vector3<f64> {
    let vertex = |index: u32| {
        let base = index as usize * 3;
        Vector3::new(
            mesh.positions[base] as f64,
            mesh.positions[base + 1] as f64,
            mesh.positions[base + 2] as f64,
        )
    };
    let base = triangle * 3;
    let a = vertex(mesh.indices[base]);
    let b = vertex(mesh.indices[base + 1]);
    let c = vertex(mesh.indices[base + 2]);
    (b - a).cross(&(c - a)).normalize()
}

#[test]
fn obtuse_bend_parallel_transports_one_surface_normal() {
    let mesh = ribbon_mesh(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 0.25, 0.0),
    ]);

    assert_eq!(mesh.indices.len(), 12);
    for triangle in 0..4 {
        assert!(
            face_normal(&mesh, triangle).z > 1.0 - 1e-6,
            "triangle {triangle} twisted across the obtuse bend"
        );
    }
    for normal in mesh.normals.chunks_exact(3) {
        assert!(normal[2] > 1.0 - 1e-6, "normal flipped: {normal:?}");
    }
}

#[test]
fn closed_ribbon_reuses_the_first_pair_at_the_seam() {
    let mesh = ribbon_mesh(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(1.0, 1.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
        Point3::new(0.0, 0.0, 0.0),
    ]);

    assert_eq!(
        mesh.positions.len(),
        8 * 3,
        "the closing point must share pair 0/1"
    );
    assert_eq!(mesh.indices.len(), 4 * 6);
    assert_eq!(&mesh.indices[18..], &[6, 7, 1, 6, 1, 0]);
    for triangle in 0..8 {
        assert!(face_normal(&mesh, triangle).z > 1.0 - 1e-6);
    }
}

#[test]
fn subnormal_span_keeps_one_frame_per_span_without_panicking() {
    let mesh = ribbon_mesh(&[Point3::new(0.0, 0.0, 0.0), Point3::new(1e-200, 0.0, 0.0)]);

    assert_eq!(mesh.positions.len(), 4 * 3);
    assert_eq!(mesh.indices.len(), 6);
    assert!(mesh.positions.iter().all(|coordinate| coordinate.is_finite()));
    assert!(mesh.normals.iter().all(|coordinate| coordinate.is_finite()));
}

#[test]
fn closed_edge_curve_sense_survives_oriented_edge_resolution() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCVERTEXPOINT(#1);\
        #3=IFCCARTESIANPOINT((2.,0.,0.));#4=IFCCARTESIANPOINT((0.,1.,1.));\
        #5=IFCPOLYLINE((#1,#3,#4,#1));#6=IFCEDGECURVE(#2,#2,#5,.F.);\
        #7=IFCORIENTEDEDGE(*,*,#6,.F.);";
    let mut decoder = EntityDecoder::new(source);

    let direct = decoder.decode_by_id(6).unwrap();
    let direct_points = resolve_edge_points(
        &direct,
        &mut decoder,
        crate::TessellationQuality::Medium,
        0,
        &mut HashSet::new(),
    )
    .unwrap();
    assert_eq!(direct_points[1], Point3::new(0.0, 1.0, 1.0));

    let oriented = decoder.decode_by_id(7).unwrap();
    let oriented_points = resolve_edge_points(
        &oriented,
        &mut decoder,
        crate::TessellationQuality::Medium,
        0,
        &mut HashSet::new(),
    )
    .unwrap();
    assert_eq!(oriented_points[1], Point3::new(2.0, 0.0, 0.0));
}
