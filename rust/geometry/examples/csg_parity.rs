// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Kernel-vs-Manifold parity harness (flip plan M7, synthetic operands).
//!
//! Runs a suite of controlled boolean cases (difference / union / intersection,
//! axis-aligned AND rotated) through BOTH the pure-Rust kernel
//! (`kernel::mesh_bridge`) and the C++ Manifold path (`ClippingProcessor`,
//! default features) and compares the exact signed volume (the robust invariant —
//! triangle counts legitimately differ) + 2-manifoldness. Parity needs no
//! *predicted* volume, only kernel↔Manifold AGREEMENT, so diverse geometry is
//! fair game. The in-crate proxy for the full captured-operand corpus parity:
//!   cargo run -p ifc-lite-geometry --example csg_parity

use std::collections::HashMap;

use ifc_lite_geometry::kernel::arrangement::box_mesh;
use ifc_lite_geometry::kernel::mesh_bridge::{self, tris_to_mesh};
use ifc_lite_geometry::{ClippingProcessor, Mesh};

fn vtx(m: &Mesh, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
}

fn volume(m: &Mesh) -> f64 {
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (vtx(m, t[0]), vtx(m, t[1]), vtx(m, t[2]));
            let cr = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        / 6.0
}

/// Worst triangle aspect ratio (longest/shortest edge) + count of spikes >50:1 —
/// the triangulation-quality metric the FZK gable-wall regression test uses.
fn worst_aspect(m: &Mesh) -> (f64, u32) {
    let mut worst = 0.0f64;
    let mut spikes = 0;
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (vtx(m, t[0]), vtx(m, t[1]), vtx(m, t[2]));
        let d = |p: [f64; 3], q: [f64; 3]| {
            ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
        };
        let (e0, e1, e2) = (d(a, b), d(b, c), d(c, a));
        let mn = e0.min(e1).min(e2);
        let mx = e0.max(e1).max(e2);
        if mn > 1e-6 {
            let r = mx / mn;
            worst = worst.max(r);
            if r > 50.0 {
                spikes += 1;
            }
        }
    }
    (worst, spikes)
}

/// 2-manifold = every undirected edge used exactly twice (vertices welded on a
/// fine quantization grid, since outputs carry independent float coords).
fn is_manifold(m: &Mesh) -> bool {
    let s = 1e5;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            (m.positions[b] as f64 * s).round() as i64,
            (m.positions[b + 1] as f64 * s).round() as i64,
            (m.positions[b + 2] as f64 * s).round() as i64,
        )
    };
    let mut edges: HashMap<((i64, i64, i64), (i64, i64, i64)), i32> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        for (u, v) in [(0, 1), (1, 2), (2, 0)] {
            let e = if k[u] < k[v] { (k[u], k[v]) } else { (k[v], k[u]) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 2)
}

/// Rotate a mesh's vertices about Z by `deg` degrees (to exercise non-axis-aligned
/// geometry — the exact predicates must still match Manifold's merge-epsilon path).
fn rotate_z(mut m: Mesh, deg: f64) -> Mesh {
    let r = deg.to_radians();
    let (c, s) = (r.cos(), r.sin());
    for v in m.positions.chunks_exact_mut(3) {
        let (x, y) = (v[0], v[1]);
        v[0] = (c * x as f64 - s * y as f64) as f32;
        v[1] = (s * x as f64 + c * y as f64) as f32;
    }
    m
}

#[derive(Clone, Copy)]
enum Op {
    Diff,
    Union,
    Inter,
}

fn op_str(o: Op) -> &'static str {
    match o {
        Op::Diff => "A−B",
        Op::Union => "A∪B",
        Op::Inter => "A∩B",
    }
}

struct Case {
    name: &'static str,
    op: Op,
    a: Mesh,
    b: Mesh,
}

fn bx(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
    tris_to_mesh(&box_mesh(lo, hi))
}

fn run_kernel(op: Op, a: &Mesh, b: &Mesh) -> Mesh {
    match op {
        Op::Diff => mesh_bridge::subtract(a, b),
        Op::Union => mesh_bridge::union(a, b),
        Op::Inter => mesh_bridge::intersection(a, b),
    }
}

fn run_manifold(cp: &ClippingProcessor, op: Op, a: &Mesh, b: &Mesh) -> ifc_lite_geometry::Result<Mesh> {
    match op {
        Op::Diff => cp.subtract_mesh(a, b),
        Op::Union => cp.union_mesh(a, b),
        Op::Inter => cp.intersection_mesh(a, b),
    }
}

fn main() {
    let cases = vec![
        Case { name: "box−box overlap", op: Op::Diff, a: bx([0., 0., 0.], [2., 2., 2.]), b: bx([1., 1., 1.], [3., 3., 3.]) },
        Case { name: "through-wall opening", op: Op::Diff, a: bx([0., 0., 0.], [4., 3., 0.2]), b: bx([1., 1., -0.5], [2., 2., 0.7]) },
        Case { name: "flush-bottom opening", op: Op::Diff, a: bx([0., 0., 0.], [4., 3., 0.2]), b: bx([1., 1., 0.], [2., 2., 0.5]) },
        Case { name: "corner notch", op: Op::Diff, a: bx([0., 0., 0.], [2., 2., 2.]), b: bx([1., 1., -1.], [3., 3., 3.]) },
        Case { name: "blind pocket", op: Op::Diff, a: bx([0., 0., 0.], [4., 3., 1.]), b: bx([1., 1., 0.5], [2., 2., 2.]) },
        Case { name: "flush-side opening", op: Op::Diff, a: bx([0., 0., 0.], [4., 3., 1.]), b: bx([0., 1., 0.25], [1.5, 2., 0.75]) },
        Case { name: "rotated 30° cutter", op: Op::Diff, a: bx([0., 0., 0.], [4., 4., 1.]), b: rotate_z(bx([1., 1., -0.5], [3., 3., 1.5]), 30.) },
        Case { name: "rotated 45° wall+cut", op: Op::Diff, a: rotate_z(bx([0., 0., 0.], [4., 0.3, 2.]), 45.), b: rotate_z(bx([1., -0.5, 0.5], [2., 0.8, 1.5]), 45.) },
        Case { name: "union overlap", op: Op::Union, a: bx([0., 0., 0.], [2., 2., 2.]), b: bx([1., 1., 1.], [3., 3., 3.]) },
        Case { name: "union abutting (coplanar)", op: Op::Union, a: bx([0., 0., 0.], [1., 1., 1.]), b: bx([1., 0., 0.], [2., 1., 1.]) },
        Case { name: "union disjoint", op: Op::Union, a: bx([0., 0., 0.], [1., 1., 1.]), b: bx([3., 3., 3.], [4., 4., 4.]) },
        Case { name: "intersection overlap", op: Op::Inter, a: bx([0., 0., 0.], [2., 2., 2.]), b: bx([1., 1., 1.], [3., 3., 3.]) },
        Case { name: "intersection rotated", op: Op::Inter, a: bx([0., 0., 0.], [3., 3., 3.]), b: rotate_z(bx([1., 1., 1.], [4., 4., 2.]), 25.) },
    ];

    let cp = ClippingProcessor::new();
    let mut fails = 0;
    println!("{:<28} {:>5} {:>10} {:>10} {:>9}  {:>6} {:>6}  {}", "case", "op", "kernel", "manifold", "rel", "man-K", "man-M", "verdict");
    for c in &cases {
        let k = run_kernel(c.op, &c.a, &c.b);
        let m = match run_manifold(&cp, c.op, &c.a, &c.b) {
            Ok(m) => m,
            Err(e) => {
                println!("{:<28} {:>5} manifold ERR: {e:?}", c.name, op_str(c.op));
                fails += 1;
                continue;
            }
        };
        let (vk, vm) = (volume(&k), volume(&m));
        let rel = (vk - vm).abs() / vm.abs().max(1e-9);
        let (mk, mm) = (is_manifold(&k), is_manifold(&m));
        let (wk, sk) = worst_aspect(&k);
        let (wm, sm) = worst_aspect(&m);
        // disjoint union legitimately yields two shells (non-manifold by the single
        // -component edge test only if welded wrong); accept when both agree.
        let pass = rel < 1e-3 && (mk || !mm);
        if !pass {
            fails += 1;
        }
        println!(
            "{:<28} {:>5} {:>9.4} {:>9.4} {:>8.1e}  {:>5} {:>5}  asp K {:>6.0}:1/{} M {:>6.0}:1/{}  {}",
            c.name, op_str(c.op), vk, vm, rel, mk, mm, wk, sk, wm, sm, if pass { "PASS" } else { "FAIL" }
        );
    }
    println!("\n{}/{} cases passed", cases.len() - fails, cases.len());
    if fails > 0 {
        std::process::exit(1);
    }
}
