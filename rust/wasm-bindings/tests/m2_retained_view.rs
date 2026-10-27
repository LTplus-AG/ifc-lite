// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-browser")]
#[path = "../src/retained_view.rs"]
mod retained_view;

// Include the real JS mesh constructor with native access to its backing data.
// Its JS typed-array getters require wasm; no geometry implementation is mocked.
#[allow(dead_code)]
mod mesh_boundary {
    include!("../src/zero_copy/mesh.rs");
    pub fn buffers(mesh: &MeshDataJs) -> (&[f32], &[f32], &[u32], [f64; 3]) {
        (&mesh.positions, &mesh.normals, &mesh.indices, mesh.origin)
    }
}
use ifc_lite_geometry::math::frame::zup_to_yup;
use ifc_lite_processing::{element::retained_runtime::ShapePart, MeshFrame};

fn cube() -> ShapePart {
    // Unit cube with non-binary local offsets, rotated 90° about IFC Z.
    // A whole-metre cube alone would hide the RTC mutation's f32 rounding.
    ShapePart {
        positions: [
            [0., 0., 0.],
            [1., 0., 0.],
            [1., 1., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [1., 0., 1.],
            [1., 1., 1.],
            [0., 1., 1.],
        ]
        .into_iter()
        .flat_map(|p| [p[0] + 0.1, p[1] + 0.2, p[2] + 0.3])
        .collect(),
        indices: vec![
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7,
            6, 3, 0, 4, 3, 4, 7,
        ],
        world_from_object: [
            0.,
            1.,
            0.,
            0.,
            -1.,
            0.,
            0.,
            0.,
            0.,
            0.,
            1.,
            0.,
            2_600_000.125,
            1_200_000.25,
            73.5,
            1.,
        ],
        curved: false,
    }
}

// #7955 M2-A oracle: retaining RTC in the per-part origin pushes survey-scale
// numbers into f32 storage. This must fail behaviorally, without API changes.
#[test]
fn m2_a_retained_view_preserves_local_precision_axes_and_outward_flat_faces() {
    let part = cube();
    let frame = MeshFrame::ModelRtc {
        anchor: (2_600_000., 1_200_000., 70.),
    };
    let (x, y, z) = frame.rtc_offset();
    let rtc = [x, y, z];
    let mesh = retained_view::view_part(&part, rtc);
    assert!(mesh.rtc_applied);
    let js = mesh_boundary::MeshDataJs::new(42, "IfcWall".into(), mesh, [1.; 4]);
    let (positions, normals, indices, origin) = mesh_boundary::buffers(&js);
    assert_eq!(js.vertex_count(), 36);
    assert_eq!(js.triangle_count(), 12);
    assert_eq!(indices, (0..36).collect::<Vec<_>>());
    let m = part.world_from_object;
    for (corner, &index) in part.indices.iter().enumerate() {
        let p = &part.positions[index as usize * 3..][..3];
        let world: [f64; 3] =
            std::array::from_fn(|a| m[a] * p[0] + m[4 + a] * p[1] + m[8 + a] * p[2] + m[12 + a]);
        let expected = zup_to_yup(world);
        let rtc_yup = zup_to_yup(rtc);
        for axis in 0..3 {
            let stored = positions[corner * 3 + axis];
            let restored = f64::from(stored) + origin[axis] + rtc_yup[axis];
            let magnitude = stored.abs();
            let ulp = f64::from(f32::from_bits(magnitude.to_bits() + 1)) - f64::from(magnitude);
            assert!(
                (restored - expected[axis]).abs() <= ulp * 0.5,
                "unbaked vertex {corner} axis {axis}: {restored} vs {}",
                expected[axis]
            );
            // The specified origin must keep storage object-sized. Half-ulp
            // alone would allow a much larger error after the oracle mutation.
            assert!(
                stored.abs() < 2.,
                "survey coordinates leaked into f32: {stored}"
            );
        }
    }
    assert_eq!(origin, zup_to_yup([0.125, 0.25, 3.5]));
    let center = zup_to_yup([-0.7, 0.6, 0.8]);
    for (p, n) in positions.chunks_exact(9).zip(normals.chunks_exact(9)) {
        assert_eq!(&n[..3], &n[3..6]);
        assert_eq!(&n[..3], &n[6..9]);
        let length: f32 = n[..3].iter().map(|v| v * v).sum();
        assert!((length - 1.).abs() < 1e-6);
        let dot: f64 = (0..3)
            .map(|a| {
                ((f64::from(p[a]) + f64::from(p[3 + a]) + f64::from(p[6 + a])) / 3. - center[a])
                    * f64::from(n[a])
            })
            .sum();
        assert!(dot > 0., "face normal must point away from the cube center");
    }
}
