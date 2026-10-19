// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::collections::HashMap;

type SourceFace = (Vec<usize>, Vec<Vec<usize>>, bool);
const SOLID: u32 = 900_001;
fn source(points: &[[f64; 3]], faces: &[SourceFace]) -> String {
    let mut source = String::new();
    for (index, point) in points.iter().enumerate() {
        source.push_str(&format!(
            "#{}=IFCCARTESIANPOINT(({},{},{}));",
            index + 1,
            point[0],
            point[1],
            point[2]
        ));
    }
    let mut ids = Vec::new();
    for (index, (outer, holes, orientation)) in faces.iter().enumerate() {
        let base = 10_000 + index * 10;
        let mut bounds = Vec::new();
        for (ring_index, ring) in std::iter::once(outer).chain(holes).enumerate() {
            let id = base + ring_index * 2;
            let refs = ring
                .iter()
                .map(|point| format!("#{point}"))
                .collect::<Vec<_>>()
                .join(",");
            source.push_str(&format!("#{id}=IFCPOLYLOOP(({refs}));"));
            let bound = if ring_index == 0 {
                "IFCFACEOUTERBOUND"
            } else {
                "IFCFACEBOUND"
            };
            let sense = if *orientation { ".T." } else { ".F." };
            source.push_str(&format!("#{}={bound}(#{id},{sense});", id + 1));
            bounds.push(format!("#{}", id + 1));
        }
        let face = base + 9;
        source.push_str(&format!("#{face}=IFCFACE(({}));", bounds.join(",")));
        ids.push(format!("#{face}"));
    }
    source.push_str(&format!(
        "#900000=IFCCLOSEDSHELL(({}));#{SOLID}=IFCFACETEDBREP(#900000);",
        ids.join(",")
    ));
    source
}
fn decode_owned(source: String, rtc: Option<(f64, f64, f64)>) -> FacetedBrepPlan {
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(SOLID).unwrap();
    lower(&entity, &mut decoder, rtc).unwrap()
}
fn positions(mesh: &Mesh, triangle: &[u32]) -> [[f64; 3]; 3] {
    [triangle[0], triangle[1], triangle[2]].map(|index| {
        let offset = index as usize * 3;
        [
            f64::from(mesh.positions[offset]),
            f64::from(mesh.positions[offset + 1]),
            f64::from(mesh.positions[offset + 2]),
        ]
    })
}
fn signed_volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let [a, b, c] = positions(mesh, triangle);
            (a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.
        })
        .sum()
}
fn cap_area(mesh: &Mesh, z: f64) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .filter_map(|triangle| {
            let [a, b, c] = positions(mesh, triangle);
            [a, b, c]
                .iter()
                .all(|point| point[2] == z)
                .then_some(((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.)
        })
        .sum()
}
fn assert_closed(mesh: &Mesh) {
    let point = |index: u32| {
        let offset = index as usize * 3;
        [
            mesh.positions[offset].to_bits(),
            mesh.positions[offset + 1].to_bits(),
            mesh.positions[offset + 2].to_bits(),
        ]
    };
    let mut directed = HashMap::new();
    for triangle in mesh.indices.chunks_exact(3) {
        let [a, b, c] = [point(triangle[0]), point(triangle[1]), point(triangle[2])];
        for edge in [(a, b), (b, c), (c, a)] {
            *directed.entry(edge).or_insert(0usize) += 1;
        }
    }
    for (&(a, b), &count) in &directed {
        assert_eq!(count, 1, "each directed edge occurs once");
        assert_eq!(
            directed.get(&(b, a)),
            Some(&1),
            "opposite face must close each edge"
        );
    }
}

#[test]
fn owned_holed_face_shell_replays_a_closed_cavity_with_analytic_volume() {
    let points = [
        [0., 0., 0.],
        [2., 0., 0.],
        [2., 2., 0.],
        [0., 2., 0.],
        [0., 0., 1.],
        [2., 0., 1.],
        [2., 2., 1.],
        [0., 2., 1.],
        [0.5, 0.5, 0.],
        [1.5, 0.5, 0.],
        [1.5, 1.5, 0.],
        [0.5, 1.5, 0.],
        [0.5, 0.5, 1.],
        [1.5, 0.5, 1.],
        [1.5, 1.5, 1.],
        [0.5, 1.5, 1.],
    ];
    let faces = vec![
        (vec![4, 3, 2, 1], vec![vec![9, 10, 11, 12]], true),
        (vec![5, 6, 7, 8], vec![vec![16, 15, 14, 13]], true),
        (vec![1, 2, 6, 5], vec![], true),
        (vec![2, 3, 7, 6], vec![], true),
        (vec![3, 4, 8, 7], vec![], true),
        (vec![4, 1, 5, 8], vec![], true),
        (vec![10, 9, 13, 14], vec![], true),
        (vec![11, 10, 14, 15], vec![], true),
        (vec![12, 11, 15, 16], vec![], true),
        (vec![9, 12, 16, 13], vec![], true),
    ];
    let plan = decode_owned(source(&points, &faces), None);
    for mesh in [plan.clone().evaluate(), plan.evaluate()] {
        assert!((signed_volume(&mesh) - 3.).abs() < 1e-9);
        assert!((cap_area(&mesh, 0.) + 3.).abs() < 1e-9);
        assert!((cap_area(&mesh, 1.) - 3.).abs() < 1e-9);
        assert_closed(&mesh);
        assert!(
            mesh.normals.is_empty(),
            "normal generation stays with the existing caller"
        );
    }
}

#[test]
fn owned_faceted_rtc_and_bound_orientation_preserve_small_survey_face() {
    let points = [
        [8_000_000., 5_000_000., 0.],
        [8_000_000.01, 5_000_000., 0.],
        [8_000_000.01, 5_000_000.01, 0.],
        [8_000_000., 5_000_000.01, 0.],
    ];
    for orientation in [true, false] {
        let plan = decode_owned(
            source(&points, &[(vec![1, 2, 3, 4], vec![], orientation)]),
            Some((8_000_000., 5_000_000., 0.)),
        );
        let mesh = plan.evaluate();
        let sign = if orientation { 1. } else { -1. };
        assert!(mesh.rtc_applied);
        assert_eq!(mesh.indices.len(), 6);
        assert!((cap_area(&mesh, 0.) - sign * 0.0001).abs() < 1e-9);
        assert!(mesh
            .positions
            .iter()
            .all(|value| value.is_finite() && value.abs() < 0.02));
    }
}

#[test]
fn unreadable_hole_refuses_the_face_during_lowering_and_never_fills_it() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((4.,0.,0.));#3=IFCCARTESIANPOINT((4.,4.,0.));#4=IFCCARTESIANPOINT((0.,4.,0.));#5=IFCCARTESIANPOINT((1.,1.,0.));#6=IFCCARTESIANPOINT((3.,3.,0.));#10=IFCPOLYLOOP((#1,#2,#3,#4));#11=IFCFACEOUTERBOUND(#10,.T.);#12=IFCPOLYLOOP((#5,#99,#6));#13=IFCFACEBOUND(#12,.T.);#20=IFCFACE((#11,#13));#900000=IFCCLOSEDSHELL((#20));#900001=IFCFACETEDBREP(#900000);";
    let _ = crate::processors::take_face_refused();
    let plan = decode_owned(source.into(), None);
    assert_eq!(crate::processors::take_face_refused(), [IfcType::IfcFace]);
    assert!(plan.evaluate().is_empty());
    assert!(
        crate::processors::take_face_refused().is_empty(),
        "evaluation must not recount source admission"
    );
}

fn quads(count: usize) -> String {
    let mut points = Vec::new();
    let mut faces = Vec::new();
    for index in 0..count {
        let x = index as f64 * 2.;
        points.extend([[x, 0., 0.], [x + 1., 0., 0.], [x + 1., 1., 0.], [x, 1., 0.]]);
        let base = index * 4;
        faces.push((vec![base + 1, base + 2, base + 3, base + 4], vec![], true));
    }
    source(&points, &faces)
}

#[test]
fn parallel_face_threshold_preserves_source_order_and_serial_prefix_geometry() {
    let serial = decode_owned(quads(PAR_FACE_THRESHOLD - 1), None).evaluate();
    let parallel = decode_owned(quads(PAR_FACE_THRESHOLD), None).evaluate();
    assert_eq!(parallel.indices.len(), PAR_FACE_THRESHOLD * 6);
    assert_eq!(
        parallel.positions[..serial.positions.len()],
        serial.positions
    );
    assert_eq!(parallel.indices[..serial.indices.len()], serial.indices);
    assert!((cap_area(&parallel, 0.) - PAR_FACE_THRESHOLD as f64).abs() < 1e-9);
    for (index, face) in parallel.positions.chunks_exact(12).enumerate() {
        assert_eq!(
            face[0],
            (index * 2) as f32,
            "parallel merge keeps source face order"
        );
    }
}
