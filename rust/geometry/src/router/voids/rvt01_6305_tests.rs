// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Physical source invariants for the #6940 regression on rvt01 host #6305.
//! The 700 x 1400 mm window crosses all 274 mm of the layered wall, including
//! its 12 mm outer render. Its 11 mm reveal remains a separate authored depth.

use super::*;
use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};

type Triangle = [Point3<f64>; 3];

fn triangle_area(t: Triangle) -> f64 {
    (t[1] - t[0]).cross(&(t[2] - t[0])).norm() * 0.5
}

/// Clip a triangle to the strictly interior window box. Testing the whole
/// polygon catches a membrane even when all its vertices lie on the jambs.
fn area_inside_window(t: Triangle) -> f64 {
    let mut polygon = t.to_vec();
    for (axis, lo, hi) in [(0, 4.5001, 5.1999), (1, -0.1369, 0.1369), (2, 1.3001, 2.6999)] {
        for (bound, sign) in [(lo, 1.0), (hi, -1.0)] {
            let mut clipped = Vec::new();
            for i in 0..polygon.len() {
                let a = polygon[i];
                let b = polygon[(i + 1) % polygon.len()];
                let da = (a[axis] - bound) * sign;
                let db = (b[axis] - bound) * sign;
                if da >= 0.0 { clipped.push(a); }
                if (da >= 0.0) != (db >= 0.0) {
                    clipped.push(a + (b - a) * (da / (da - db)));
                }
            }
            polygon = clipped;
        }
    }
    (1..polygon.len().saturating_sub(1))
        .map(|i| triangle_area([polygon[0], polygon[i], polygon[i + 1]]))
        .sum()
}

fn face_area(triangles: &[Triangle], axis: usize, coordinate: f64, sign: f64) -> f64 {
    triangles.iter().filter(|t| {
        t.iter().all(|p| (p[axis] - coordinate).abs() < 2e-5)
            && (t[1] - t[0]).cross(&(t[2] - t[0]))[axis] * sign > 0.0
    }).map(|&t| triangle_area(t)).sum()
}

/// Whether the manifold gate rejects the cut of `ids`, so the box-cut
/// fallback's pin applies rather than the default bar.
fn gate_rejects(ids: &[u32]) -> bool {
    cfg!(feature = "csg_manifold_gate") && ids != [45545]
}

/// Areas the window's four jamb/head/sill faces must have, in the order
/// `x = 4.5`, `x = 5.2`, `z = 1.3`, `z = 2.7`, plus the 11 mm reveal floor.
/// The default bar: the opening cuts all 274 mm of the wall.
///
/// #7980 (#3440): under `csg_manifold_gate` the exact cut of host #6305 with
/// two or three of its openings is REJECTED, and the bar is REPLACED by the
/// measured fallback, the #098 reveal-wall pattern. The host is three authored
/// items whose shared interface faces are emitted on both sides, so the UN-cut
/// mesh already carries 6 undirected edges used four times (2 fwd + 2 rev),
/// and the cut adds more along the opening rim. The gate reads every over-used
/// edge as a defect and the router falls back to the #635 AABB box-cut, which
/// removes the material but emits no jamb faces. What survives is only the
/// 262 mm core item's own end faces (0.262 x 1.4 = 0.3668, 0.262 x 0.7 =
/// 0.1834) where an earlier opening of the subset was cut. Exempting balanced
/// over-use in the gate was measured and rejected: it is the
/// doubled-coincident-shell blind spot the gate exists to catch. Since the cut
/// runs in the frame of the site placement, #45545 alone passes the gate
/// (it read `NonManifoldRejected { over_used: 16 }` before) and meets the
/// default bar, and with all three openings the reveal floor keeps its full
/// 0.116 m2 (it halved before). `csg_topology_gate` alone accepts the cut and
/// keeps the default bar. A different number here means the gate or the
/// fallback moved and the gated result needs re-measuring, not re-pinning;
/// when the fallback is fixed, the gated arm should go.
fn expected_window(ids: &[u32]) -> ([f64; 4], f64) {
    if !gate_rejects(ids) {
        return ([0.3836, 0.3836, 0.1918, 0.1918], 0.116);
    }
    match ids {
        [6347, 45545] | [6347, 6378, 45545] => ([0.3668, 0.3668, 0.1834, 0.1834], 0.116),
        _ => unreachable!("no gated measurement for {ids:?}"),
    }
}

/// Assertion message for a face area, naming the gated fallback when the
/// expectation is a pin rather than the real bar.
fn area_message(ids: &[u32], what: &str, area: f64, expected: f64) -> String {
    let pinned = if gate_rejects(ids) {
        " (known csg_manifold_gate fallback, #7980: a different number means the gate \
         or the fallback moved and must be re-measured, not re-pinned)"
    } else {
        ""
    };
    format!("{ids:?}: {what} area={area}, expected {expected}{pinned}")
}

struct UnionOverride;
impl Drop for UnionOverride {
    fn drop(&mut self) { set_enabled_override(None); }
}

#[test]
fn issue_6940_rvt01_6305_window_cuts_outer_render() {
    let Some(content) = ifc_lite_testkit::fixture_text("various/rvt01.ifc") else { return; };
    set_enabled_override(Some(true));
    let _reset = UnionOverride;
    for ids in [vec![45545], vec![6347, 45545], vec![6347, 6378, 45545]] {
        let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
        let mut router = GeometryRouter::with_units(&content, &mut decoder);
        // Match the loader's nonzero site RTC choice before producing f32 mesh.
        let mut scanner = EntityScanner::new(&content);
        let site_id = loop {
            let (id, name, _, _) = scanner.next_entity().expect("fixture site");
            if name == "IFCSITE" { break id; }
        };
        let site = decoder.decode_by_id(site_id).unwrap();
        let site_placement = router.resolve_scaled_placement(&site, &mut decoder).unwrap();
        let rtc = (site_placement[12], site_placement[13], site_placement[14]);
        router.set_rtc_offset(rtc);
        let host = decoder.decode_by_id(6305).unwrap();
        let placement = router.resolve_scaled_placement(&host, &mut decoder).unwrap();
        let inverse = Matrix4::from_column_slice(&placement).try_inverse().unwrap();
        let mut voids = rustc_hash::FxHashMap::default();
        voids.insert(6305, ids.clone());
        let mesh = router.process_element_with_voids(&host, &mut decoder, &voids).unwrap();
        #[cfg(feature = "csg_manifold_gate")]
        let failures = router.take_csg_failures();
        let points: Vec<_> = mesh.positions.chunks_exact(3).map(|p| {
            inverse.transform_point(&Point3::new(
                p[0] as f64 + mesh.origin[0] + rtc.0,
                p[1] as f64 + mesh.origin[1] + rtc.1,
                p[2] as f64 + mesh.origin[2] + rtc.2,
            ))
        }).collect();
        let triangles: Vec<Triangle> = mesh.indices.chunks_exact(3)
            .map(|t| [points[t[0] as usize], points[t[1] as usize], points[t[2] as usize]])
            .collect();
        let interior: f64 = triangles.iter().copied().map(area_inside_window).sum();
        assert!(interior < 1e-8, "window {ids:?} contains {interior} m² of spurious surface");
        #[cfg(feature = "csg_manifold_gate")]
        {
            let rejected = failures.get(&6305).is_some_and(|f| f.iter().any(|f| matches!(
                f.reason,
                crate::diagnostics::BoolFailureReason::NonManifoldRejected { .. }
            )));
            assert_eq!(
                rejected,
                gate_rejects(&ids),
                "{ids:?}: the manifold gate's verdict moved ({failures:?}); the pins below \
                 assume the old one: re-measure (#7980)"
            );
        }
        let (window, reveal_floor) = expected_window(&ids);
        // Exterior, reveal floor and both sides of the material interfaces.
        for (t, sign, expected) in [
            (0.0, -1.0, 19.784), (0.011, -1.0, reveal_floor),
            (0.012, -1.0, 19.900), (0.012, 1.0, 19.900),
            (0.262, -1.0, 19.900), (0.262, 1.0, 19.900),
            (0.274, 1.0, 19.900),
        ] {
            let area = face_area(&triangles, 1, t - 0.137, sign);
            assert!((area - expected).abs() < 2e-4,
                "{}", area_message(&ids, &format!("layer t={t} sign={sign}"), area, expected));
        }
        for ((axis, coordinate, sign), expected) in [
            (0, 4.5, 1.0), (0, 5.2, -1.0),
            (2, 1.3, 1.0), (2, 2.7, -1.0),
        ].into_iter().zip(window) {
            let area = face_area(&triangles, axis, coordinate, sign);
            assert!((area - expected).abs() < 2e-4,
                "{}", area_message(&ids, &format!("window face axis={axis} at {coordinate}"), area, expected));
        }
    }
}
