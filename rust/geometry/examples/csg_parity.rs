//! Kernel-vs-Manifold parity harness (flip plan M7, synthetic operands).
//!
//! Runs a suite of controlled difference cases through BOTH the pure-Rust kernel
//! (`kernel::mesh_bridge::subtract`) and the C++ Manifold path
//! (`ClippingProcessor::subtract_mesh`, default features) and compares the exact
//! signed volume (the robust invariant — triangle counts legitimately differ) +
//! 2-manifoldness of each output. This is the in-crate proxy for the full
//! captured-operand corpus parity; run with:
//!   cargo run -p ifc-lite-geometry --example csg_parity

use std::collections::HashMap;

use ifc_lite_geometry::kernel::arrangement::box_mesh;
use ifc_lite_geometry::kernel::mesh_bridge::{subtract, tris_to_mesh};
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
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        / 6.0
}

/// 2-manifold = every undirected edge used exactly twice (vertices welded on a
/// fine quantization grid, since the outputs carry independent float coords).
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

struct Case {
    name: &'static str,
    host: Mesh,
    cutter: Mesh,
}

fn bx(lo: [f64; 3], hi: [f64; 3]) -> Mesh {
    tris_to_mesh(&box_mesh(lo, hi))
}

fn main() {
    let cases = vec![
        Case { name: "box−box overlap", host: bx([0., 0., 0.], [2., 2., 2.]), cutter: bx([1., 1., 1.], [3., 3., 3.]) },
        Case { name: "through-wall opening", host: bx([0., 0., 0.], [4., 3., 0.2]), cutter: bx([1., 1., -0.5], [2., 2., 0.7]) },
        Case { name: "flush-bottom opening (coplanar)", host: bx([0., 0., 0.], [4., 3., 0.2]), cutter: bx([1., 1., 0.], [2., 2., 0.5]) },
        Case { name: "corner notch", host: bx([0., 0., 0.], [2., 2., 2.]), cutter: bx([1., 1., -1.], [3., 3., 3.]) },
        Case { name: "blind pocket", host: bx([0., 0., 0.], [4., 3., 1.]), cutter: bx([1., 1., 0.5], [2., 2., 2.]) },
        Case { name: "flush-side opening (coplanar)", host: bx([0., 0., 0.], [4., 3., 1.]), cutter: bx([0., 1., 0.25], [1.5, 2., 0.75]) },
    ];

    let cp = ClippingProcessor::new();
    let mut fails = 0;
    println!("{:<34} {:>10} {:>10} {:>9}  {:>6} {:>6}  {}", "case", "kernel", "manifold", "rel", "man-K", "man-M", "verdict");
    for c in &cases {
        let k = subtract(&c.host, &c.cutter);
        let m = match cp.subtract_mesh(&c.host, &c.cutter) {
            Ok(m) => m,
            Err(e) => {
                println!("{:<34} manifold ERR: {e:?}", c.name);
                fails += 1;
                continue;
            }
        };
        let (vk, vm) = (volume(&k), volume(&m));
        let rel = (vk - vm).abs() / vm.abs().max(1e-9);
        let (mk, mm) = (is_manifold(&k), is_manifold(&m));
        let pass = rel < 1e-3 && mk;
        if !pass {
            fails += 1;
        }
        println!(
            "{:<34} {:>10.4} {:>10.4} {:>9.1e}  {:>6} {:>6}  {}",
            c.name, vk, vm, rel, mk, mm, if pass { "PASS" } else { "FAIL" }
        );
    }
    println!("\n{}/{} cases passed", cases.len() - fails, cases.len());
    if fails > 0 {
        std::process::exit(1);
    }
}
