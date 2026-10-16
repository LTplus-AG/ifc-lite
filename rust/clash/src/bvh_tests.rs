// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! BVH split-order tests (#7674, EDGE-CLASH-1).
//!
//! The split sort used `partial_cmp(..).unwrap_or(Equal)`, which is not a
//! total order once a NaN centre is in the slice. Since Rust 1.81 `sort_by`
//! may panic on such a comparator, and the wasm build is `panic = abort`.
//! NaN centres are expected here: `tri_bounds` NaNs a triangle with a NaN
//! vertex on purpose (#5220). The shared vectors also pin the tree shape
//! against the TypeScript BVH (`packages/spatial/src/bvh.ts`).

use super::Bvh;
use crate::aabb::Aabb;
use crate::tri_mesh::TriMesh;

/// Read by `packages/spatial/src/bvh.parity.test.ts` too.
const PARITY: &str = include_str!("../tests/fixtures/bvh_order_parity.txt");

struct Query {
    bounds: Aabb,
    expected: Vec<u32>,
}

struct Case {
    name: String,
    items: Vec<(u32, Aabb)>,
    queries: Vec<Query>,
}

fn nums(fields: &[&str]) -> Vec<f64> {
    fields.iter().map(|s| s.parse::<f64>().unwrap_or_else(|_| panic!("bad number {s:?}"))).collect()
}

fn aabb(v: &[f64]) -> Aabb {
    Aabb::new([v[0], v[1], v[2]], [v[3], v[4], v[5]])
}

fn parse_cases() -> Vec<Case> {
    let mut cases: Vec<Case> = Vec::new();
    for line in PARITY.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        match fields[0] {
            "case" => cases.push(Case { name: fields[1].to_string(), items: Vec::new(), queries: Vec::new() }),
            "item" => {
                let id: u32 = fields[1].parse().expect("item id");
                cases.last_mut().expect("item before case").items.push((id, aabb(&nums(&fields[2..8]))));
            }
            "query" => {
                assert_eq!(fields[7], "=>", "query line: {line}");
                let expected = fields[8..].iter().map(|s| s.parse::<u32>().expect("hit id")).collect();
                let bounds = aabb(&nums(&fields[1..7]));
                cases.last_mut().expect("query before case").queries.push(Query { bounds, expected });
            }
            other => panic!("unknown record {other:?} in bvh_order_parity.txt"),
        }
    }
    cases
}

#[test]
fn bvh_query_order_matches_ts_parity_vectors_7674() {
    let cases = parse_cases();
    // Anti-vacuity: the file must still hold the shapes this test exists for.
    assert!(cases.len() >= 5, "parity file lost cases: {}", cases.len());
    assert!(
        cases.iter().any(|c| c.items.len() > 20 && c.items.iter().any(|(_, b)| b.min[0].is_nan())),
        "need a NaN case past the 20-element insertion-sort cutoff"
    );
    for case in &cases {
        let bvh = Bvh::build(&case.items);
        for (qi, q) in case.queries.iter().enumerate() {
            assert_eq!(bvh.query_aabb(&q.bounds), q.expected, "case {} query {qi}", case.name);
        }
    }
}

/// A triangle mesh where every third triangle has an all-NaN vertex, laid out
/// along X with repeated centres. 64 triangles is well past the insertion-sort
/// cutoff, so this exercises the sort path that can detect a non-total order.
fn nan_vertex_strip(count: usize) -> TriMesh {
    let mut positions = Vec::with_capacity(count * 9);
    let mut indices = Vec::with_capacity(count * 3);
    for t in 0..count {
        let x = ((t * 37) % 11) as f64;
        let first = if t.is_multiple_of(3) { [f64::NAN; 3] } else { [x, 0.0, 0.0] };
        positions.extend_from_slice(&first);
        positions.extend_from_slice(&[x + 0.5, 0.0, 0.0, x, 0.5, 0.0]);
        let o = (t * 3) as u32;
        indices.extend_from_slice(&[o, o + 1, o + 2]);
    }
    TriMesh::new(positions, indices)
}

#[test]
fn nan_vertex_mesh_past_insertion_sort_cutoff_builds_7674() {
    let mesh = nan_vertex_strip(64);
    let mut hits = mesh.query_tris(&Aabb::new([-100.0; 3], [100.0; 3]));
    hits.sort_unstable();
    // NaN leaves never intersect a query; every finite triangle is still found.
    let expected: Vec<u32> = (0..64u32).filter(|t| !t.is_multiple_of(3)).collect();
    assert_eq!(hits, expected);
}
