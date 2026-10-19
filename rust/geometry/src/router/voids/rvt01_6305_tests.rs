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
        // Exterior, reveal floor and both sides of the material interfaces.
        for (t, sign, expected) in [
            (0.0, -1.0, 19.784), (0.011, -1.0, 0.116),
            (0.012, -1.0, 19.900), (0.012, 1.0, 19.900),
            (0.262, -1.0, 19.900), (0.262, 1.0, 19.900),
            (0.274, 1.0, 19.900),
        ] {
            let area = face_area(&triangles, 1, t - 0.137, sign);
            assert!((area - expected).abs() < 2e-4,
                "{ids:?}: layer t={t} sign={sign} area={area}, expected {expected}");
        }
        for (axis, coordinate, sign, expected) in [
            (0, 4.5, 1.0, 0.3836), (0, 5.2, -1.0, 0.3836),
            (2, 1.3, 1.0, 0.1918), (2, 2.7, -1.0, 0.1918),
        ] {
            let area = face_area(&triangles, axis, coordinate, sign);
            assert!((area - expected).abs() < 2e-4,
                "{ids:?}: window face axis={axis} at {coordinate} area={area}, expected {expected}");
        }
    }
}
