// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::csg::ClippingProcessor;
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::HashMap;

/// #3917: outward-wound axis-aligned box, optionally rigidly rotated about
/// `about`. Verbatim copy of `issue_3913_sweep_tests::boxed` (itself a copy
/// of `issue_3353_nary_near_coplanar::boxed`) — each `issue_3353_*`/
/// `issue_3913_*`/`issue_3917_*` fixture keeps its own per that family's
/// documented convention, rather than sharing one across files.
fn boxed_3917(min: [f64; 3], size: [f64; 3], rot: Option<(Vector3<f64>, f64, [f64; 3])>) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let mut corners: Vec<Point3<f64>> = [
        (0, 0, 0),
        (1, 0, 0),
        (1, 1, 0),
        (0, 1, 0),
        (0, 0, 1),
        (1, 0, 1),
        (1, 1, 1),
        (0, 1, 1),
    ]
    .iter()
    .map(|&(i, j, k)| Point3::new(c(0)[i], c(1)[j], c(2)[k]))
    .collect();
    if let Some((axis, angle, about)) = rot {
        let r = Rotation3::from_axis_angle(&Unit::new_normalize(axis), angle);
        let o = Point3::new(about[0], about[1], about[2]);
        for p in corners.iter_mut() {
            *p = o + r * (*p - o);
        }
    }
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for f in &faces {
        let e1 = corners[f[1]] - corners[f[0]];
        let e2 = corners[f[2]] - corners[f[0]];
        let n = e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z());
        let b = m.vertex_count() as u32;
        for &i in f {
            m.add_vertex(corners[i], n);
        }
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// #3917: unmatched directed edges after welding by position at 0.1 mm —
/// identical convention to `issue_3913_sweep_tests::open_edges`.
fn open_edges_3917(m: &Mesh) -> usize {
    if m.is_empty() {
        return usize::MAX;
    }
    let w = m.welded_by_position(1e-4);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for t in w.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            if a == b {
                return usize::MAX;
            }
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    edges.values().filter(|&&(f, r)| f != 1 || r != 1).count()
}

/// #3917: the exact discriminating configuration traced in the issue's
/// diagnosis comment — `three_boxes_at(0.5, 0.5, +SNAP_GRID)` (the
/// #3913/#3916 sweep's own fixture shape) presented in `CAB` order, which
/// measured 53 unmatched directed edges pre-fix while `BCA` measured 0 for
/// the identical physical operand set. RED before #3917's fix (fails with
/// `open_edges_3917 > 0`); GREEN after, because `arrange` now retries the
/// other 5 orderings of this exact 3-operand union when the caller's own
/// order (`CAB` here) comes back open, and one of them (verified to still be
/// `BCA` in the trace) closes.
fn issue_3917_boxes() -> [Mesh; 3] {
    const SG: f64 = 1.0 / 65536.0;
    let (bx, by, dz) = (0.5, 0.5, SG);
    let a = boxed_3917([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], None);
    let b = boxed_3917(
        [bx, by, dz],
        [1.0, 1.0, 1.0],
        Some((
            Vector3::z(),
            30.0f64.to_radians(),
            [bx + 0.5, by + 0.5, 0.5 + dz],
        )),
    );
    let c = boxed_3917(
        [-bx, by, dz],
        [1.0, 1.0, 1.0],
        Some((
            Vector3::z(),
            -20.0f64.to_radians(),
            [-bx + 0.5, by + 0.5, 0.5 + dz],
        )),
    );
    [a, b, c]
}

#[test]
fn issue_3917_a_torn_caller_order_is_repaired_without_the_caller_reordering_anything() {
    let [a, b, c] = issue_3917_boxes();

    // CAB: the ordering the issue measured at 53 unmatched directed edges.
    let cab: [&Mesh; 3] = [&c, &a, &b];
    let out = ClippingProcessor::consolidate_coplanar(union_many(&cab));
    assert_eq!(
        open_edges_3917(&out),
        0,
        "CAB must come back closed: #3917's fix retries the other 5 orderings \
         of this exact 3-operand union when the caller's own order tears, and \
         a closed alternative (traced as BCA) exists for this configuration"
    );

    // The other 5 orderings of the SAME physical operands must also close —
    // this is the "order no longer decides the verdict" half of #3917, not
    // just "CAB specifically got luckier."
    for order in [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 1, 0]] {
        let meshes = [&a, &b, &c];
        let permuted: [&Mesh; 3] = [meshes[order[0]], meshes[order[1]], meshes[order[2]]];
        let out = ClippingProcessor::consolidate_coplanar(union_many(&permuted));
        assert_eq!(
            open_edges_3917(&out),
            0,
            "ordering {order:?} of the same 3 physical operands must also close"
        );
    }
}

/// The retry candidates belong to one public boolean operation. Resetting the
/// per-operation counter for each permutation would let one `union_many` call
/// spend up to six times the configured exact-predicate cap (#1109).
#[test]
fn issue_3917_retries_share_one_boolean_budget() {
    // The fixed fixture consumes 1,058 escalations across its retry candidates,
    // while no individual candidate reaches 1,000. Reading the thread-local
    // counter therefore distinguishes one shared operation from a reset inside
    // every retry without mutating the process-global cap (and racing other
    // parallel geometry tests).
    let boxes = issue_3917_boxes();
    let input = [&boxes[2], &boxes[0], &boxes[1]]; // CAB: known torn first candidate
    let out = union_many(&input);
    let count = budget::count();

    assert!(!out.is_empty());
    assert!(
        count >= 1_000,
        "the public union must retain the retry candidates' accumulated count; got {count}"
    );
}

fn tetrahedron(offset: [f32; 3]) -> Mesh {
    let mut mesh = Mesh::new();
    for p in [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ] {
        mesh.positions.extend((0..3).map(|i| p[i] + offset[i]));
    }
    mesh.indices = vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
    mesh.normals = vec![0.0; mesh.positions.len()];
    mesh
}

#[test]
fn issue_3925_coordinate_preserving_candidate_does_not_move_disjoint_vertices() {
    let a = tetrahedron([0.0; 3]);
    let b = tetrahedron([2.0, 0.0, super::super::SNAP_GRID as f32]);
    let operands = [&a, &b];
    let original_vertices: Vec<_> = operands
        .iter()
        .flat_map(|m| m.positions.chunks_exact(3).map(|p| [p[0], p[1], p[2]]))
        .collect();
    let plain = union_many_preserving_coordinates(&operands);
    assert!(!plain.is_empty());
    assert!(
        plain
            .positions
            .chunks_exact(3)
            .all(|p| original_vertices.contains(&[p[0], p[1], p[2]])),
        "disjoint solids have no intersection vertices to construct or move"
    );
    let moved = union_many(&operands);
    assert!(
        moved
            .positions
            .chunks_exact(3)
            .any(|p| !original_vertices.contains(&[p[0], p[1], p[2]])),
        "control must expose the mutually reconciled candidate"
    );
}
