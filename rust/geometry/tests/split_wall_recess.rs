// SPDX-License-Identifier: MPL-2.0

//! Split-wall recess regressions for #10512 and #10528.

mod voids_common;
#[path = "voids_common/split_wall.rs"]
mod split_wall;

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::kernel::mesh_volume::mesh_volume;
use ifc_lite_geometry::mesh_check::{Degenerate, EdgeLedger, VertexKey};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use split_wall::{analytic_volume, wall, Recess};
use voids_common::production::{build_void_index_like_production, process_host_like_production};

fn fixture_host(content: &str, expect_rtc: bool) -> (Mesh, GeometryRouter) {
    let voids = build_void_index_like_production(content);
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    let entity = decoder.decode_by_id(100).unwrap();
    let mut router = GeometryRouter::with_scale(1.0);
    let rtc = router
        .detect_rtc_offset_for_file(content.as_bytes(), &mut decoder)
        .expect("the fixture has a usable placement")
        .offset();
    assert_eq!(rtc != (0.0, 0.0, 0.0), expect_rtc, "unexpected RTC for the fixture");
    router.set_rtc_offset(rtc);
    // Measure in the production RTC frame so folding a far world origin
    // back into f32 positions does not reintroduce quantization.
    let mesh = router
        .process_element_with_voids(&entity, &mut decoder, &voids)
        .expect("the wall meshes");
    (mesh, router)
}

#[cfg(feature = "csg_manifold_gate")]
#[test]
fn split_recess_from_a_kilometre_away() {
    let mut failures = Vec::new();
    for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
        for turn in [0.0, 90.0] {
            for step in 0..6 {
                let offset = 2.0 + 0.137 * f64::from(step);
                let content = wall([1000.0, 800.0], turn, offset, recess);
                let (mesh, router) = fixture_host(&content, true);

                let ledger =
                    EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
                let open = ledger.unbalanced().count();
                let delta = mesh_volume(&mesh) - analytic_volume();
                let cut_failures = router.take_csg_failures();
                if open != 0 || delta.abs() > 0.0005 || !cut_failures.is_empty() {
                    failures.push(format!(
                        "{recess:?} turn={turn} y={offset:.3}: {open} open edges, {:+.3} L volume delta, {cut_failures:?}",
                        delta * 1000.0
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn split_recess_keeps_the_core_at_the_flush_interface() {
    // At this placement the host weld moves the exposed cap just far enough
    // to extend the cutter across the full core (#10528).
    for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
        let content = wall([0.0; 2], 0.0, 2.274, recess);
        let voids = build_void_index_like_production(&content);
        let mesh = process_host_like_production(&content, 100, &voids).expect("the wall meshes");
        let delta_litres = (mesh_volume(&mesh) - analytic_volume()) * 1_000.0;
        assert!(
            delta_litres.abs() < 2.0,
            "{recess:?}: {delta_litres:+.3} L from the analytic recess volume"
        );
        let ledger = EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
        assert_eq!(ledger.unbalanced().count(), 0, "{recess:?}");
    }
}


/// The two touching bodies contribute opposite interface faces. The finish
/// must lose both sides of the recessed patch even when its end bisects the
/// opening. The whole-wall rotated case also exercises the oblique cut (#10528).
#[test]
fn recess_at_the_finish_interface_has_no_membrane() {
    let surface_area = |mesh: &Mesh| {
        let points = |index: u32| std::array::from_fn::<_, 3, _>(|axis|
            f64::from(mesh.positions[index as usize * 3 + axis]));
        mesh.indices.chunks_exact(3).map(|triangle| {
            let (a, b, c) = (points(triangle[0]), points(triangle[1]), points(triangle[2]));
            let u = std::array::from_fn::<_, 3, _>(|axis| b[axis] - a[axis]);
            let v = std::array::from_fn::<_, 3, _>(|axis| c[axis] - a[axis]);
            let n = std::array::from_fn::<_, 3, _>(|axis| {
                let (j, k) = ((axis + 1) % 3, (axis + 2) % 3);
                u[j] * v[k] - u[k] * v[j]
            });
            0.5 * n.iter().map(|value| value * value).sum::<f64>().sqrt()
        }).sum::<f64>()
    };
    // A 4 m by 3 m by 0.2 m core and a 12 mm finish. For a finish
    // ending after 1.5 m the recess removes half of its 1 m² footprint.
    for (site, turn, length, volume, areas) in [
        ([0.0; 2], 42.0, 4.0, 2.532, [49.016, 48.992]),
        ([0.0; 2], 0.0, 1.5, 2.448, [34.920, 34.908]),
        ([1000.0, 800.0], 0.0, 1.5, 2.448, [34.920, 34.908]),
    ] {
        for (recess, area) in [Recess::FromInterface, Recess::ToInterfaceAtTop].into_iter().zip(areas) {
            let content = split_wall::wall_with_finish(site, turn, 2.274, recess, length);
            let (mesh, _) = fixture_host(&content, site != [0.0; 2]);
            let ledger = EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
            assert_eq!(ledger.unbalanced().count(), 0, "{site:?} {turn}° {recess:?}");
            let measured_area = surface_area(&mesh);
            // The manifold recovery can union the bodies before cutting.
            // This removes both contact faces over the unrecessed finish.
            let removed_area = if length == 4.0 { 1.0 } else { 0.5 };
            let fused_area = area - 2.0 * (length * 3.0 - removed_area);
            let area_ok = (measured_area - area).abs() <= 0.005
                || (cfg!(feature = "csg_manifold_gate") && (measured_area - fused_area).abs() <= 0.005);
            assert!(area_ok, "{site:?} {turn}° {recess:?}: {measured_area} m² vs {area} m² (fused {fused_area} m²)");
            let measured_volume = mesh_volume(&mesh);
            assert!((measured_volume - volume).abs() <= 0.0006, "{site:?} {turn}° {recess:?}: {measured_volume} m³ vs {volume} m³");
        }
    }
}
