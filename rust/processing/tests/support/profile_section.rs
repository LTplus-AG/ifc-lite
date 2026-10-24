// SPDX-License-Identifier: MPL-2.0
//! Test-only closed triangle/section intersection for #7955 / #3641.
//! Work in exact rationals of the supplied binary floats, not rounded decimal
//! reconstructions. Opposite traversals of a shared edge must agree exactly.
use num_rational::BigRational;
use num_traits::ToPrimitive;

type Point = [BigRational; 3];

pub fn triangle_section(triangle: [[f64; 3]; 3], y: f64, z: f64) -> Vec<f64> {
    let rational = |v| BigRational::from_float(v).expect("finite section input");
    let points = triangle.map(|p| p.map(rational));
    let (y, z) = (rational(y), rational(z));
    let mut hits = Vec::new();
    for (a, b) in [(0, 1), (1, 2), (2, 0)] {
        hits.extend(plane_edge(&points[a], &points[b], 2, &z));
    }
    // A plane intersects a convex triangle in a point, segment, or the whole
    // triangle. All pairs of edge hits stay in that intersection; their line
    // intersections have the same extrema as its boundary. Duplicates are
    // harmless because this oracle measures extrema, not crossing parity.
    let mut section = Vec::new();
    for (i, p) in hits.iter().enumerate() {
        if p[1] == y {
            section.push(p[0].to_f64().expect("finite section coordinate"));
        }
        for q in &hits[i+1..] {
            for hit in plane_edge(p, q, 1, &y) {
                section.push(hit[0].to_f64().expect("finite section coordinate"));
            }
        }
    }
    section
}

fn plane_edge(p: &Point, q: &Point, axis: usize, value: &BigRational) -> Vec<Point> {
    if &p[axis] == value && &q[axis] == value {
        return vec![p.clone(), q.clone()];
    }
    if &p[axis] == value { return vec![p.clone()]; }
    if &q[axis] == value { return vec![q.clone()]; }
    if (p[axis] < *value && *value < q[axis]) || (q[axis] < *value && *value < p[axis]) {
        let t = (value - &p[axis]) / (&q[axis] - &p[axis]);
        return vec![std::array::from_fn(|i| &p[i] + &t * (&q[i] - &p[i]))];
    }
    Vec::new()
}

/// The original source-derived expectations and tolerances, shared with the
/// missing-face/wrong-section controls. Intersection never sees these values.
pub fn assert_profile_section(section_x: &[f64]) {
    assert!(!section_x.is_empty(), "REGION_SDK_SECTION");
    let min = section_x.iter().copied().fold(f64::INFINITY,f64::min);
    let max = section_x.iter().copied().fold(f64::NEG_INFINITY,f64::max);
    assert!((min-(0.265+1.2816e-8)).abs() <= 1e-7, "REGION_SDK_SECTION: {min}");
    assert!((max-(3.63+1.2816e-8)).abs() <= 1e-7, "REGION_SDK_SECTION: {max}");
}
