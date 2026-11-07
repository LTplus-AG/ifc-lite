// SPDX-License-Identifier: MPL-2.0
//! Exact storage precision. The gated retained-vs-exact comparison uses exact
//! BEFORE its world f32 rounding (#7955 ruling 2, [`exact_unrounded`]); rounding
//! retained into exact's storage frame remains for report-only band rows.
use super::metrics::{transform, Metrics};
use ifc_lite_processing::{MeshFrame, ProcessingResult};
use ifc_lite_retained_native::ShapeOnlyProduct;

// #7955 ruling 2. The native default stores absolute world/RTC f32 positions (one
// ulp is ~15 µm at 200 m). Rounding retained into that grid cannot cancel the
// noise: the engines' pre-rounding vertices differ, so each lands on a different
// grid point (ISSUE_068 #1327254: 1.7e-4 volume from rounding alone). Exact runs a
// second time, in this harness only, in its per-element local frame: kernel output
// placed in f64 and stored relative to the element's own centre, leaving one f32
// ulp of the element's half-extent (~0.1 µm at 2 m). Production output is untouched.
pub const COMPARISON_PRECISION: &str =
    "retained f64 world vs exact before world f32 storage (exact per-element local frame: f64 origin + element-small f32); source checks f64";

/// Exact's meshes for the gated retained comparison only. The frame policy is a
/// process-global hook, restored before returning; the harness calls it between
/// model runs and the retained engine runs in its own worker process.
pub fn exact_unrounded(bytes: &[u8]) -> ProcessingResult {
    ifc_lite_geometry::local_frame_set_enabled_override(Some(true));
    let result = ifc_lite_processing::process_geometry(bytes);
    ifc_lite_geometry::local_frame_set_enabled_override(None);
    result
}

pub fn round_world(frame: MeshFrame, origin: [f64; 3], world: [f64; 3]) -> [f64; 3] {
    let (x, y, z) = frame.rtc_offset();
    let local = frame.rotate_into_frame([world[0] - x, world[1] - y, world[2] - z]);
    let stored = std::array::from_fn(|i| (local[i] - origin[i]) as f32 as f64 + origin[i]);
    frame.to_world(stored)
}

/// Report-only (`tests/m3_native.rs`); the gate compares before rounding.
#[allow(dead_code)]
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
    let mut measured = if shape.parts.iter().any(|p| p.layer.is_some()) {
        Metrics::assembly()
    } else { Metrics::default() };
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
