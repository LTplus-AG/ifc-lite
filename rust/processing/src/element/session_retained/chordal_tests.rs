// SPDX-License-Identifier: MPL-2.0
//! dental_clinic #2510's mullion profile (composite curve #162646): two
//! concentric arcs 50 mm apart, joined by two lines, extruded 3 m.
use super::*;

const CENTRE: [f64; 2] = [4.53857932089166, -0.6535333285020071];
const X_AXIS: [f64; 2] = [-0.9583864791051044, 0.2854739159161845];
const INNER: (f64, f64, f64) = (4.607699375978148, 16.58717889379865, 0.4004577362866802);
const OUTER: (f64, f64, f64) = (4.657699375978148, 3.562221243239142e-13, 16.58717889379865);
const DEPTH: f64 = 3.;

fn point(radius: f64, degrees: f64) -> [f64; 2] {
    let (sin, cos) = degrees.to_radians().sin_cos();
    [CENTRE[0] + radius * (cos * X_AXIS[0] - sin * X_AXIS[1]), CENTRE[1] + radius * (cos * X_AXIS[1] + sin * X_AXIS[0])]
}
fn segment(bytes: &mut Vec<u8>, kind: u32, values: [f64; 12]) {
    bytes.extend(kind.to_le_bytes());
    bytes.extend(0u32.to_le_bytes());
    values.iter().for_each(|v| bytes.extend(v.to_le_bytes()));
}
fn arc(bytes: &mut Vec<u8>, (radius, from, to): (f64, f64, f64)) {
    segment(bytes, 3, [CENTRE[0], CENTRE[1], 0., 0., 0., 1., X_AXIS[0], X_AXIS[1], 0., radius, from.to_radians(), (to - from).to_radians()]);
}
fn line(bytes: &mut Vec<u8>, a: [f64; 2], b: [f64; 2]) {
    segment(bytes, 1, [a[0], a[1], 0., b[0], b[1], 0., 0., 0., 0., 0., 0., 0.]);
}
/// The wire-format-1 request the lowering sends for this profile.
fn mullion() -> Vec<u8> {
    let mut bytes = Vec::new();
    [1u32, 1, 4, 0].iter().for_each(|v| bytes.extend(v.to_le_bytes()));
    [0., 0., 1., DEPTH].iter().for_each(|v: &f64| bytes.extend(v.to_le_bytes()));
    [0u32, 4].iter().for_each(|v| bytes.extend(v.to_le_bytes()));
    line(&mut bytes, point(OUTER.0, OUTER.2), point(INNER.0, INNER.1));
    arc(&mut bytes, INNER);
    line(&mut bytes, point(INNER.0, INNER.2), point(OUTER.0, OUTER.1));
    arc(&mut bytes, OUTER);
    bytes
}
/// A closed prism over the profile with `inner`/`outer` chords per arc:
/// fan caps and quad sides, as any consistent tessellation would close it.
fn prism(inner: usize, outer: usize) -> (Vec<f64>, Vec<u32>) {
    let mut ring = Vec::new();
    for (arc, count) in [(INNER, inner), (OUTER, outer)] {
        ring.extend((0..=count).map(|i| point(arc.0, arc.1 + (arc.2 - arc.1) * i as f64 / count as f64)));
    }
    let n = ring.len() as u32;
    let positions = [0., DEPTH].iter().flat_map(|&z| ring.iter().flat_map(move |p| [p[0], p[1], z])).collect();
    let mut indices = Vec::new();
    for i in 1..n - 1 {
        indices.extend([0, i + 1, i, n, n + i, n + i + 1]);
    }
    for i in 0..n {
        let j = (i + 1) % n;
        indices.extend([i, j, n + j, i, n + j, n + i]);
    }
    (positions, indices)
}

#[test]
fn sweep_volume_is_the_exact_profile_area_times_depth() {
    let (volume, curved) = sweep_volume(1, &mullion()).unwrap();
    // Independent Green's-theorem area of #162646 (7955-corpus-violations.md).
    assert!((volume / DEPTH / 0.0662540 - 1.).abs() < 1e-6, "{volume}");
    assert!(curved);
    let mut linear = Vec::new();
    [1u32, 1, 3, 0].iter().for_each(|v| linear.extend(v.to_le_bytes()));
    [0., 0., 1., 2.].iter().for_each(|v: &f64| linear.extend(v.to_le_bytes()));
    [0u32, 3].iter().for_each(|v| linear.extend(v.to_le_bytes()));
    line(&mut linear, [0., 0.], [1., 0.]);
    line(&mut linear, [1., 0.], [0., 1.]);
    line(&mut linear, [0., 1.], [0., 0.]);
    assert_eq!(sweep_volume(1, &linear), Some((1., false)));
    assert_eq!(sweep_volume(2, &linear), None, "never interprets another format");
    assert_eq!(sweep_volume(1, &linear[..linear.len() - 1]), None, "truncated payload");
    println!("witness: mullion sweep {volume} m3, area {}", volume / DEPTH);
}

#[test]
fn issue_7955_mismatched_arc_counts_breach_the_curved_volume_tolerance() {
    let bytes = mullion();
    let exact = sweep_volume(1, &bytes).unwrap().0;
    // The real SDK's counts at chord 1 mm / 5 degrees: 8 inner, 16 outer.
    let (positions, indices) = prism(8, 16);
    let mesh = mesh_volume(&positions, &indices).unwrap();
    assert!((mesh / exact - 1. - 0.00682).abs() < 5e-5, "published +0.682%: {}", mesh / exact - 1.);
    assert!(!within_curved_volume(1, &bytes, &positions, &indices));
    // Consistent counts cancel the concave gain against the convex loss.
    for (inner, outer) in [(8, 8), (16, 16), (64, 64)] {
        let (positions, indices) = prism(inner, outer);
        assert!(within_curved_volume(1, &bytes, &positions, &indices), "{inner}/{outer}");
    }
    assert!(!within_curved_volume(1, &bytes, &positions, &[]), "no mesh volume, no admission");
    println!("witness: 8/16 mesh {mesh} vs exact {exact}, relative {}", mesh / exact - 1.);
}
