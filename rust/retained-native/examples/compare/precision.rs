// SPDX-License-Identifier: MPL-2.0
//! Compare in the exact pipeline's storage precision, without changing the
//! full-f64 geometry used by the independent authored-source checks.
use super::metrics::{transform, Metrics};
use ifc_lite_processing::MeshFrame;
use ifc_lite_retained_native::ShapeOnlyProduct;

pub fn round_world(frame: MeshFrame, origin: [f64; 3], world: [f64; 3]) -> [f64; 3] {
    let (x, y, z) = frame.rtc_offset();
    let local = frame.rotate_into_frame([world[0] - x, world[1] - y, world[2] - z]);
    let stored = std::array::from_fn(|i| (local[i] - origin[i]) as f32 as f64 + origin[i]);
    frame.to_world(stored)
}

pub fn measure(
    shape: &ShapeOnlyProduct,
    frame: MeshFrame,
    origins: &[[f64; 3]],
) -> Result<Metrics, String> {
    let Some(first) = origins.first() else {
        return Err("exact has no storage frame for product".into());
    };
    let common = origins.iter().all(|origin| origin == first);
    if !common && origins.len() != shape.parts.len() {
        return Err("cannot pair distinct exact mesh origins with retained parts".into());
    }
    let mut measured = Metrics::default();
    for (index, part) in shape.parts.iter().enumerate() {
        let origin = if common { *first } else { origins[index] };
        let points: Vec<_> = part
            .positions
            .chunks_exact(3)
            .map(|p| {
                round_world(
                    frame,
                    origin,
                    transform(&part.world_from_object, [p[0], p[1], p[2]]),
                )
            })
            .collect();
        measured.add_mesh(&points, &part.indices)?;
    }
    Ok(measured)
}

#[cfg(test)]
mod tests {
    use super::*;
    // #7955: a small feature at ~100 m must retain exact's f32 rounding,
    // while per-mesh origin restores the much finer object-local precision.
    #[test]
    fn rounding_uses_exact_frame_rotation_rtc_and_mesh_origin() {
        let frame = MeshFrame::from_world_matrix(&[
            0., 1., 0., 0., -1., 0., 0., 0., 0., 0., 1., 0., 2_600_000., 1_200_000., 300., 1.,
        ]);
        let world = frame.to_world([100.000001, 0., 0.]);
        assert_eq!(
            round_world(frame, [0.; 3], world),
            frame.to_world([100., 0., 0.])
        );
        let local = round_world(frame, [100., 0., 0.], world);
        assert!(local.iter().zip(world).all(|(a, b)| (a - b).abs() < 1e-9));
        assert!(round_world(frame, [0.; 3], world)
            .iter()
            .zip(world)
            .any(|(a, b)| (a - b).abs() > 0.5e-6));
    }

    #[test]
    fn georeferenced_fixture_storage_survives_roundtrip_without_changing_exact() {
        let bytes = include_bytes!("../../../geometry/tests/fixtures/issue_098_wall_W.ifc");
        let exact = ifc_lite_processing::process_geometry(bytes);
        assert!(!exact.meshes.is_empty());
        for mesh in &exact.meshes {
            for p in mesh.positions.chunks_exact(3) {
                let world = exact
                    .frame
                    .to_world(std::array::from_fn(|i| mesh.origin[i] + p[i] as f64));
                let rounded = round_world(exact.frame, mesh.origin, world);
                assert!(rounded.iter().zip(world).all(|(a, b)| (a - b).abs() < 1e-8));
            }
        }
    }
}
