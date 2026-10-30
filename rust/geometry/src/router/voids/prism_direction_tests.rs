// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::cluster_prism_directions;
use crate::math::v3::{dot, V3};
use crate::router::voids::prism_cut::normalize;
use crate::Vector3;

// #7781 R3 / ROUTER-9: verbatim candidate loop from detect_prism at
// 169c75f39ebd52d70e4d80c0fe58a2a4721b8cf0, followed only by its return value.
fn legacy(normals: &[Option<V3>]) -> Option<Vec<V3>> {
    let mut clusters: Vec<V3> = Vec::new();
    for n in normals.iter().flatten() {
        if !clusters.iter().any(|c| dot(*n, *c).abs() > 0.999) {
            if clusters.len() > 64 {
                return None; // way past any stepped extrusion — bail early
            }
            clusters.push(*n);
        }
    }
    Some(clusters)
}

fn bits(clusters: Option<Vec<V3>>) -> Option<Vec<[u64; 3]>> {
    clusters.map(|axes| {
        axes.into_iter()
            .map(|axis| axis.map(f64::to_bits))
            .collect()
    })
}

fn compare(normals: &[Option<V3>]) {
    assert_eq!(
        bits(cluster_prism_directions(normals)),
        bits(legacy(normals))
    );
}

struct Stream(u64);
impl Stream {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64 * 4.0 - 2.0
    }

    fn normal(&mut self) -> Option<V3> {
        normalize([self.next(), self.next(), self.next()])
    }
}

#[test]
fn c2_5_finish_prism_seeded_legacy_bits_and_dot_arithmetic() {
    let mut stream = Stream(0xD1B5_4A32_D192_ED03);
    let mut capped = 0;
    let mut uncapped = 0;
    for case in 0..2_000 {
        let normals: Vec<_> = (0..case % 100)
            .map(|_| match case % 3 {
                0 => stream.normal(),
                1 => normalize([1.0, stream.next() * 0.05, stream.next() * 0.05]),
                _ => normalize([stream.next() * 0.01, 1.0, stream.next() * 0.01]),
            })
            .collect();
        compare(&normals);
        if legacy(&normals).is_none() {
            capped += 1;
        } else {
            uncapped += 1;
        }
    }
    assert!(capped > 100 && uncapped > 1_000);
    // Check the arithmetic as well as the resulting grouping. No renormalizing
    // conversion or different summation order may hide behind the adapter.
    for _ in 0..100_000 {
        let a = stream.normal().unwrap();
        let b = stream.normal().unwrap();
        let av: Vector3<f64> = a.into();
        let bv: Vector3<f64> = b.into();
        assert_eq!(dot(a, b).to_bits(), av.dot(&bv).to_bits());
        let back: V3 = av.into();
        assert_eq!(a.map(f64::to_bits), back.map(f64::to_bits));
    }
}

#[test]
fn c2_5_finish_prism_strict_threshold_and_first_representative() {
    let threshold = 0.999_f64;
    for offset in -32_i64..=32 {
        let cosine = f64::from_bits(threshold.to_bits().checked_add_signed(offset).unwrap());
        for sign in [-1.0, 1.0] {
            let normal = [sign * cosine, (1.0 - cosine * cosine).sqrt(), 0.0];
            let normals = [Some([1.0, 0.0, 0.0]), Some(normal)];
            compare(&normals);
            assert_eq!(
                cluster_prism_directions(&normals).unwrap().len(),
                if offset > 0 { 1 } else { 2 }
            );
        }
    }
    // 0.99 belongs to the box/wall cluster but MUST open another prism cluster.
    let normals = [
        Some([1.0, 0.0, 0.0]),
        Some([0.99, (1.0_f64 - 0.99 * 0.99).sqrt(), 0.0]),
    ];
    compare(&normals);
    assert_eq!(cluster_prism_directions(&normals).unwrap().len(), 2);
    // The middle facet joins the first, without moving that representative.
    let mut normals: Vec<_> = [0.0_f64, 0.03, 0.06]
        .map(|angle| Some([angle.cos(), angle.sin(), 0.0]))
        .into();
    for _ in 0..2 {
        compare(&normals);
        let axes = cluster_prism_directions(&normals).unwrap();
        assert_eq!(axes.len(), 2);
        assert_eq!(
            axes[0].map(f64::to_bits),
            normals[0].unwrap().map(f64::to_bits)
        );
        assert_eq!(
            axes[1].map(f64::to_bits),
            normals[2].unwrap().map(f64::to_bits)
        );
        normals.reverse();
    }
}

#[test]
fn c2_5_finish_prism_allows_65_clusters_and_only_refuses_a_new_66th() {
    // Adjacent unit directions are further apart than acos(0.999); none of
    // these 66 directions is close to the antipode of an earlier one.
    let normals: Vec<_> = (0..66)
        .map(|i| {
            let angle = i as f64 * std::f64::consts::PI / 70.0;
            Some([angle.cos(), angle.sin(), 0.0])
        })
        .collect();
    for count in [64, 65, 66] {
        compare(&normals[..count]);
        assert_eq!(
            cluster_prism_directions(&normals[..count]).map(|c| c.len()),
            (count <= 65).then_some(count)
        );
    }
    let mut at_limit = normals[..65].to_vec();
    at_limit.extend([None, normals[0], normals[64]]);
    compare(&at_limit);
    assert_eq!(cluster_prism_directions(&at_limit).unwrap().len(), 65);
    at_limit.push(normals[65]);
    compare(&at_limit);
    assert!(cluster_prism_directions(&at_limit).is_none());
}

#[test]
fn c2_5_finish_prism_preserves_degenerate_and_nonfinite_inputs() {
    let raw = [
        [0.0, 0.0, 0.0],
        [-0.0, 0.0, -0.0],
        [1e-300, 0.0, 0.0],
        [f64::NAN, 0.0, 1.0],
        [f64::INFINITY, 1.0, 0.0],
        [1.0, -0.0, 0.0],
        [-1.0, 0.0, -0.0],
    ];
    // Actual detect_prism normalization, with its existing refusal policy.
    let normalized: Vec<_> = raw.into_iter().map(normalize).collect();
    compare(&normalized);
    // The adapter itself must not add normalization, filtering or NaN policy.
    let unfiltered: Vec<_> = raw.into_iter().map(Some).chain([None]).collect();
    compare(&unfiltered);
    compare(&[]);
    compare(&[None; 66]);
    for count in [64, 65, 66] {
        compare(&vec![Some([f64::NAN, -0.0, 0.0]); count]);
        compare(&vec![Some([0.0, 0.0, 0.0]); count]);
    }
}
