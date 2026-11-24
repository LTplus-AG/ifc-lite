// SPDX-License-Identifier: MPL-2.0

//! Split-wall recess regressions for #10512, #10528 and #11313.

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


#[test]
fn flush_recess_beyond_the_finish_keeps_the_core() {
    // #11313: the finish ends at x=0.5 m, before the recess at x=1–2 m.
    // All 2.4 m³ of core and 0.018 m³ of finish should remain.
    // At 2.137 m the manifold gate rejects the touching cut and hands
    // the authored box to the legacy fallback.
    for (turn, offset) in [(0.0, 2.274), (0.0, 2.137), (42.0, 2.001)] {
        for site in [[0.0; 2], [1000.0, 800.0]] {
            for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
                let content = split_wall::wall_with_finish(site, turn, offset, recess, 0.5);
                let (mesh, _) = fixture_host(&content, site != [0.0; 2]);
                let volume = mesh_volume(&mesh);
                let case = format!("{site:?} {turn}° {offset} m {recess:?}");
                assert!((volume - 2.418).abs() < 0.0006, "{case}: {volume} m³");
                let ledger = EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
                assert_eq!(ledger.unbalanced().count(), 0, "{case}");
            }
        }
    }
}

#[test]
fn overlap_does_not_hide_material_inside_the_recess() {
    use std::process::Command;
    const PROBE: &str = "IFCLITE_PROBE_OVERLAPPING_RECESS";
    if std::env::var_os(PROBE).is_none() {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "overlap_does_not_hide_material_inside_the_recess", "--nocapture"])
            .env("IFC_LITE_PRISM_CUT", "0")
            .env(PROBE, "1")
            .output()
            .unwrap();
        assert!(child.status.success(), "{}", String::from_utf8_lossy(&child.stderr));
        assert!(String::from_utf8_lossy(&child.stdout).contains("1 passed; 0 failed"));
        return;
    }

    // #11313: parity counts both overlapping shells and sees air in the
    // authored recess, even though it is filled up to the outer cap.
    let content = split_wall::wall_with_overlapping_bodies();
    let (mesh, _) = fixture_host(&content, false);
    let cap_hits = |x| voids_common::production::count_ray_hits(&mesh, [x, 2.48, 1.8], [0.0, 1.0, 0.0]);
    assert_eq!(cap_hits(4.4), 0, "the recess must clear the outer face");
    assert!(cap_hits(3.4) > 0, "the wall face beside the recess must remain");
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

/// Expected volume of `wall_with_finish`: 2.4 m³ of core, a 12 mm finish
/// over `length` m, less the finish inside the recess at x in [1, 2].
fn finish_wall_volume(length: f64) -> f64 {
    4.0 * 3.0 * 0.2 + length * 3.0 * 0.012 - (length - 1.0).clamp(0.0, 1.0) * 0.012
}

/// Plan turns within `cos(1°)` of the axes, about both axes and in both senses.
const NEAR_AXIS_TURNS: [f64; 5] = [0.0, 0.5, 1.0, -0.5, 89.5];

fn rotated_flush_recess_failures() -> Vec<String> {
    let mut failures = Vec::new();
    for turn in NEAR_AXIS_TURNS {
        for length in [0.5, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0] {
            for recess in [Recess::FromInterface, Recess::ToInterfaceAtTop] {
                let content = split_wall::wall_with_finish([0.0; 2], turn, 2.274, recess, length);
                let (mesh, _) = fixture_host(&content, false);
                let delta = (mesh_volume(&mesh) - finish_wall_volume(length)) * 1000.0;
                let ledger = EdgeLedger::build(&mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle);
                let open = ledger.unbalanced().count();
                if delta.abs() > 0.6 || open != 0 {
                    failures.push(format!("{turn}° finish {length} m {recess:?}: {delta:+.3} L, {open} open edges"));
                }
            }
        }
    }
    failures
}

/// #11321: a wall turned under 1° kept its flush recess as world bounds,
/// which gain `size · sin θ` (4.4 L of core at 0.5°). It must match the
/// axis-aligned wall on the default route.
#[test]
fn slightly_rotated_flush_recess_keeps_the_core() {
    let failures = rotated_flush_recess_failures();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// #11321: on the exact route the widened bounds no longer started on the
/// finish face, so the recess was extended through the core (about 200 L).
#[test]
fn slightly_rotated_flush_recess_keeps_the_core_on_the_exact_route() {
    use std::process::Command;
    const PROBE: &str = "IFCLITE_PROBE_ROTATED_FLUSH_RECESS";
    if std::env::var_os(PROBE).is_none() {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "slightly_rotated_flush_recess_keeps_the_core_on_the_exact_route", "--nocapture"])
            .env("IFC_LITE_PRISM_CUT", "0")
            .env("IFC_LITE_VOID_2D", "0")
            .env("IFC_LITE_RECT_FAST", "0")
            .env(PROBE, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&child.stdout);
        assert!(child.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&child.stderr));
        assert!(stdout.contains("1 passed; 0 failed"), "{stdout}");
        return;
    }
    let failures = rotated_flush_recess_failures();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// #11321: the same widening on a vertically extruded slot through the wall
/// cut up to 1.4 L too much at 1°. Only the volume is pinned here: the
/// oblique slot leaves open edges on some turns with or without the fix.
#[test]
fn slightly_rotated_vertical_slot_cuts_only_the_slot() {
    for turn in NEAR_AXIS_TURNS.into_iter().chain([0.9]) {
        for length in [0.5, 1.5, 4.0] {
            // The slot spans x in [1, 2] and z in [1, 2] and pokes out of
            // both faces of the wall.
            let content = split_wall::wall_with_finish([0.0; 2], turn, 2.274, Recess::FromInterface, length)
                .replace("#110=IFCCARTESIANPOINT((1.,0.2,2.));", "#110=IFCCARTESIANPOINT((1.,-0.1,1.));")
                .replace("#111=IFCAXIS2PLACEMENT3D(#110,#15,#17);", "#111=IFCAXIS2PLACEMENT3D(#110,#14,#17);")
                .replace("#120=IFCCARTESIANPOINT((0.5,0.5));", "#120=IFCCARTESIANPOINT((0.5,0.206));")
                .replace("#121,1.0,1.0);", "#121,1.0,0.412);")
                .replace("#123=IFCEXTRUDEDAREASOLID(#122,#11,#14,0.012);", "#123=IFCEXTRUDEDAREASOLID(#122,#11,#14,1.0);");
            assert_eq!(content.matches("0.412").count() + content.matches("(#122,#11,#14,1.0)").count(), 2);
            let (mesh, _) = fixture_host(&content, false);
            let delta = (mesh_volume(&mesh) - (finish_wall_volume(length) - 0.2)) * 1000.0;
            assert!(delta.abs() < 0.2, "{turn}° finish {length} m: {delta:+.3} L");
        }
    }
}
