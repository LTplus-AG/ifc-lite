// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// subtract_mesh timing at the operand sizes the M0 census found. Originally the
// M0 dual-baseline harness (BSP vs Manifold); since M9 there is ONE kernel:
//   cargo run --release -p ifc-lite-geometry --example csg_timing
use ifc_lite_geometry::{ClippingProcessor, Mesh};
use std::time::Instant;

/// Subdivided axis-aligned box, 12·n² triangles, built via direct f32 fields.
fn box_mesh(hx: f64, hy: f64, hz: f64, n: usize) -> Mesh {
    let mut m = Mesh::new();
    let faces = [
        (0usize, hx, 1usize, 2usize, 1.0f32), (0, -hx, 1, 2, -1.0),
        (1, hy, 0, 2, 1.0), (1, -hy, 0, 2, -1.0),
        (2, hz, 0, 1, 1.0), (2, -hz, 0, 1, -1.0),
    ];
    let ext = [hx, hy, hz];
    for &(fa, fv, ua, va, ns) in &faces {
        for i in 0..n {
            for j in 0..n {
                let base = (m.positions.len() / 3) as u32;
                for &(ii, jj) in &[(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)] {
                    let mut p = [0f64; 3];
                    p[fa] = fv;
                    p[ua] = -ext[ua] + 2.0 * ext[ua] * (ii as f64 / n as f64);
                    p[va] = -ext[va] + 2.0 * ext[va] * (jj as f64 / n as f64);
                    m.positions.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
                    let mut nrm = [0f32; 3];
                    nrm[fa] = ns;
                    m.normals.extend_from_slice(&nrm);
                }
                m.indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
            }
        }
    }
    m
}

fn main() {
    let kernel = "pure-rust-exact";
    let cp = ClippingProcessor::new();
    // (host_subdiv, cutter_subdiv) targeting the census buckets.
    let cases = [(1, 1), (4, 2), (6, 4), (8, 6), (12, 8), (18, 12)];
    println!("kernel={kernel}");
    println!("{:>10} {:>11} {:>10} {:>11}", "host_tris", "cutter_tris", "us/op", "result_tris");
    for &(hs, cs) in &cases {
        let host = box_mesh(2.0, 2.0, 0.15, hs);     // thin slab
        let cutter = box_mesh(0.5, 0.5, 0.6, cs);    // taller → punches through z
        let (ht, ct) = (host.triangle_count(), cutter.triangle_count());
        let _ = cp.subtract_mesh(&host, &cutter); // warmup
        let big = ht.max(ct);
        let iters = if big > 500 { 20 } else if big > 100 { 100 } else { 1000 };
        let mut rt = 0usize;
        let t0 = Instant::now();
        for _ in 0..iters {
            if let Ok(r) = cp.subtract_mesh(&host, &cutter) {
                rt = r.triangle_count();
            }
        }
        let us = t0.elapsed().as_micros() as f64 / iters as f64;
        println!("{:>10} {:>11} {:>10.1} {:>11}", ht, ct, us, rt);
    }
}
