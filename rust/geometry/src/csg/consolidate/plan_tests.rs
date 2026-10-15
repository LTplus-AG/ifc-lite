// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7633: remote patches sharing a rounded plane key must keep their own boundaries.

use super::*;
use crate::csg::consolidate::conform::emit_plans;
use crate::csg::ClippingProcessor;
use crate::mesh::Mesh;
use nalgebra::Point3;

fn plan_bucket(
    tris: &[PlaneTri],
    use_tag: bool,
    next_bid: &mut u32,
    length_unit_scale: f64,
) -> Vec<PlanBucket> {
    let mut plans = Vec::new();
    append_bucket_plans(tris, use_tag, next_bid, length_unit_scale, &mut plans);
    plans
}

fn prism(a: [f64; 2], b: [f64; 2]) -> Mesh {
    let d = [b[0] - a[0], b[1] - a[1]];
    let length = d[0].hypot(d[1]);
    let left = [-d[1] / length * 0.4, d[0] / length * 0.4];
    let ring = [
        a,
        b,
        [b[0] - left[0], b[1] - left[1]],
        [a[0] - left[0], a[1] - left[1]],
    ];
    let mut m = Mesh::new();
    for z in [3.6500000953674316, 3.9000000953674316] {
        for p in ring {
            m.add_vertex(Point3::new(p[0], p[1], z), Vector3::zeros());
        }
    }
    m.indices = vec![
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 4, 5, 1, 4, 1, 0, 5, 6, 2, 5, 2, 1, 6, 7, 3, 6, 3, 2,
        7, 4, 0, 7, 0, 3,
    ];
    m
}

/// Strict kernel-grid topology: every edge exactly once each way, with no
/// coincident or collinear collapsed triangle hidden by an edge-balance sum.
fn topology(mesh: &Mesh) -> (usize, usize) {
    use std::collections::BTreeMap;
    let point = |i: u32| -> [i64; 3] {
        std::array::from_fn(|k| {
            let value = mesh.positions[i as usize * 3 + k];
            assert!(value.is_finite());
            (f64::from(value) * 65536.0).round() as i64
        })
    };
    let mut edges = BTreeMap::<([i64; 3], [i64; 3]), (usize, usize)>::new();
    let mut collapsed = 0;
    for t in mesh.indices.chunks_exact(3) {
        let [a, b, c] = [point(t[0]), point(t[1]), point(t[2])];
        let ab: [i128; 3] = std::array::from_fn(|k| i128::from(b[k]) - i128::from(a[k]));
        let ac: [i128; 3] = std::array::from_fn(|k| i128::from(c[k]) - i128::from(a[k]));
        if [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ] == [0; 3]
        {
            collapsed += 1;
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let uses = edges.entry((x.min(y), x.max(y))).or_default();
            if x < y {
                uses.0 += 1;
            } else {
                uses.1 += 1;
            }
        }
    }
    assert!(!edges.is_empty(), "the prism must produce a surface");
    (edges.values().filter(|&&u| u != (1, 1)).count(), collapsed)
}

#[test]
fn issue_7633_disjoint_closed_prisms_keep_their_boundaries() {
    let first = prism(
        [11.764073371887207, 4.684849739074707],
        [11.942479133605957, 4.111988544464111],
    );
    let remote = prism(
        [6.463944435119629, 21.70363998413086],
        [7.504642486572266, 18.3619441986084],
    );
    let mut results = Vec::new();
    for reverse in [false, true] {
        let mut input = if reverse {
            remote.clone()
        } else {
            first.clone()
        };
        input.merge(if reverse { &first } else { &remote });
        assert_eq!(topology(&input), (0, 0));
        let output = ClippingProcessor::consolidate_coplanar(input.clone());
        let source_corners: std::collections::BTreeSet<_> = input
            .positions
            .chunks_exact(3)
            .map(|p| [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()])
            .collect();
        let generated: std::collections::BTreeSet<_> = output
            .positions
            .chunks_exact(3)
            .map(|p| [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()])
            .collect();
        let (bad_edges, collapsed) = topology(&output);
        let missing = source_corners.difference(&generated).count();
        let volume = crate::kernel::mesh_volume::mesh_volume;
        let volume_change = (volume(&input) - volume(&output)).abs();
        eprintln!("DISJOINT reverse={reverse} input={} output={} strict_edges={bad_edges} collapsed={collapsed} missing_source_corners={missing} volume_change={volume_change}", input.triangle_count(), output.triangle_count());
        results.push((reverse, bad_edges, collapsed, missing, volume_change));
    }
    assert!(
        results
            .iter()
            .all(|(_, edges, collapsed, missing, volume)| *edges == 0
                && *collapsed == 0
                && *missing == 0
                && *volume < 1e-7),
        "{results:?}"
    );
}

#[test]
fn issue_7633_topology_oracle_rejects_duplicate_shell_and_collapsed_face() {
    let source = prism([0., 0.], [1., 0.]);
    assert_eq!(topology(&source), (0, 0));
    let mut doubled = source.clone();
    doubled.merge(&source);
    assert!(
        topology(&doubled).0 > 0,
        "balanced duplicate faces are not manifold"
    );
    let mut collapsed = source;
    collapsed.indices.extend_from_slice(&[0, 0, 1]);
    assert_eq!(
        topology(&collapsed).1,
        1,
        "collapsed faces must not disappear"
    );
}

fn triangle(points: [[f64; 3]; 3]) -> PlaneTri {
    let v = points.map(Point3::from);
    let normal = (v[1] - v[0]).cross(&(v[2] - v[0])).normalize();
    PlaneTri {
        v,
        normal,
        tag: None,
    }
}

fn quad(x: [f64; 2], y: [f64; 2], z: f64) -> Vec<PlaneTri> {
    let (a, b, c, d) = (
        [x[0], y[0], z],
        [x[1], y[0], z],
        [x[1], y[1], z],
        [x[0], y[1], z],
    );
    vec![triangle([a, b, c]), triangle([a, c, d])]
}

/// Overlap, contacts, and ambiguous disconnected domains retain the exact old
/// union plan. In particular world-normal separation cannot justify splitting
/// two overlapping PROJECTED footprints, and vertex connectivity alone cannot
/// split the crossing triangles. Small normal offsets keep these controls
/// outside the exact-coplanar bypass while preserving their projected domains.
#[test]
fn issue_7633_projected_interactions_and_ambiguous_regions_keep_prior_output() {
    let mut normal_offset = quad([0., 2.], [0., 2.], 0.);
    normal_offset.extend(quad([1., 3.], [1., 3.], 2e-7));
    let mut point_touch = quad([0., 1.], [0., 1.], 0.);
    point_touch.extend(quad([1., 2.], [1., 2.], 2e-7));
    let mut edge_touch = quad([0., 1.], [0., 1.], 0.);
    edge_touch.extend(quad([1., 2.], [0., 1.], 2e-7));
    let interlocking = vec![
        triangle([[0., 0., 0.], [3., 0., 0.], [0., 3., 0.]]),
        triangle([[3., 3., 2e-7], [1.75, 3., 2e-7], [3., 1.75, 2e-7]]),
    ];
    let crossing = vec![
        triangle([[-2., -0.5, 0.], [2., -0.5, 0.], [0., 1., 0.]]),
        triangle([[-0.5, -2., 2e-7], [1., 0., 2e-7], [-0.5, 2., 2e-7]]),
    ];
    for (name, tris) in [
        ("normal-offset overlap", normal_offset),
        ("point contact", point_touch),
        ("edge contact", edge_touch),
        ("interlocking disjoint", interlocking),
        ("crossing", crossing),
    ] {
        let Planned::Ready(baseline) = plan_one(&tris, false, 0, 1., false, None) else {
            unreachable!()
        };
        let mut baseline = vec![baseline];
        let mut planned = plan_bucket(&tris, false, &mut 0, 1.);
        assert_eq!(planned.len(), 1, "{name}: no independent gap certificate");
        let (before, complete_before) = emit_plans(&mut baseline, false);
        let (after, complete_after) = emit_plans(&mut planned, false);
        assert!(complete_before && complete_after, "{name}");
        assert_eq!(before.positions, after.positions, "{name}: positions");
        assert_eq!(before.indices, after.indices, "{name}: indices");
    }
}

/// Splitting independent regions must not promote a thin noise island into a
/// new surface by shrinking the area denominator or taking the raw-singleton
/// shortcut. Keep the original multi-triangle bucket's cleanup decision.
#[test]
fn issue_7633_partition_preserves_bucket_noise_cleanup_for_singleton_islands() {
    let mut tris = quad([0., 2.], [0., 2.], 0.);
    tris.push(triangle([
        [4., 0., 2e-7],
        [4.01, 0., 2e-7],
        [4., 0.0001, 2e-7],
    ]));
    let Planned::Ready(baseline) = plan_one(&tris, false, 0, 1., false, None) else {
        unreachable!()
    };
    assert_eq!(baseline.regions.len(), 1, "thin island is baseline noise");
    let mut planned = plan_bucket(&tris, false, &mut 0, 1.);
    assert_eq!(
        planned.len(),
        2,
        "fixture must exercise the partition retry"
    );
    assert!(
        planned[1].raw.is_empty(),
        "a retry singleton must not bypass cleanup"
    );
    assert!(
        planned[1].regions.is_empty(),
        "keep the original bucket noise threshold"
    );
    let (after, complete) = emit_plans(&mut planned, false);
    assert!(complete);
    // Independent union bounds legitimately change overlay quantization. The
    // admitted retry promises the original surface, not the old rounded bytes.
    let expected: std::collections::BTreeSet<_> = tris[..2]
        .iter()
        .flat_map(|t| t.v)
        .map(|p| [p.x as f32, p.y as f32, p.z as f32].map(f32::to_bits))
        .collect();
    let emitted: std::collections::BTreeSet<_> = after
        .positions
        .chunks_exact(3)
        .map(|p| [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()])
        .collect();
    assert_eq!(
        emitted, expected,
        "retain the authored large quad, without the noise island"
    );
    let at = |i: u32| {
        let k = i as usize * 3;
        Vector3::new(
            f64::from(after.positions[k]),
            f64::from(after.positions[k + 1]),
            f64::from(after.positions[k + 2]),
        )
    };
    let area: f64 = after
        .indices
        .chunks_exact(3)
        .map(|t| (at(t[1]) - at(t[0])).cross(&(at(t[2]) - at(t[0]))).norm() * 0.5)
        .sum();
    assert_eq!(
        area, 4.0,
        "the 2 by 2 quad must survive without extra faces"
    );
}

/// Disconnected surfaces on one exact plane need no projection correction.
/// Preserve the established union bytes, including its global quantization.
#[test]
fn issue_7633_exact_coplanar_disjoint_patches_preserve_prior_output_in_both_windings() {
    let mut triangles = quad([0., 2.], [0., 2.], 0.);
    triangles.extend(quad([4.001, 6.001], [0.25, 2.25], 0.));
    for reverse in [false, true] {
        let tris: Vec<_> = triangles
            .iter()
            .map(|t| {
                let mut p = t.v.map(|p| [p.x, p.y, p.z]);
                if reverse {
                    p.swap(1, 2);
                }
                triangle(p)
            })
            .collect();
        let Planned::Ready(baseline) = plan_one(&tris, false, 0, 1., false, None) else {
            unreachable!()
        };
        let mut planned = plan_bucket(&tris, false, &mut 0, 1.);
        assert_eq!(
            planned.len(),
            1,
            "exactly coplanar patches must not regroup"
        );
        let mut baseline = vec![baseline];
        let (before, before_complete) = emit_plans(&mut baseline, false);
        let (after, after_complete) = emit_plans(&mut planned, false);
        assert!(before_complete && after_complete);
        assert_eq!(
            before.positions, after.positions,
            "winding reversed={reverse}"
        );
        assert_eq!(before.normals, after.normals, "winding reversed={reverse}");
        assert_eq!(before.indices, after.indices, "winding reversed={reverse}");
    }
}
