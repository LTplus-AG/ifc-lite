//! Common-case CSG perf micro-bench: a rectangular opening through a wall
//! (box − box), the dominant operation. Times per-op + reports tris.
//!   cargo run -p ifc-lite-geometry --example perf_box   (build with the dev opt
//!   override so geometry is -O3, representative of release/wasm relative cost)

use ifc_lite_geometry::{ClippingProcessor, Mesh};
use std::time::Instant;

fn box_mesh(mn: [f32; 3], mx: [f32; 3]) -> Mesh {
    let v = [
        [mn[0], mn[1], mn[2]], [mx[0], mn[1], mn[2]], [mx[0], mx[1], mn[2]], [mn[0], mx[1], mn[2]],
        [mn[0], mn[1], mx[2]], [mx[0], mn[1], mx[2]], [mx[0], mx[1], mx[2]], [mn[0], mx[1], mx[2]],
    ];
    // 12 tris, outward winding
    let f: [[usize; 3]; 12] = [
        [0, 2, 1], [0, 3, 2], // bottom -z
        [4, 5, 6], [4, 6, 7], // top +z
        [0, 1, 5], [0, 5, 4], // front -y
        [3, 7, 6], [3, 6, 2], // back +y
        [0, 4, 7], [0, 7, 3], // left -x
        [1, 2, 6], [1, 6, 5], // right +x
    ];
    let mut positions = Vec::new();
    for p in &v {
        positions.extend_from_slice(p);
    }
    let mut indices = Vec::new();
    for t in &f {
        indices.extend_from_slice(&[t[0] as u32, t[1] as u32, t[2] as u32]);
    }
    let normals = vec![0.0; positions.len()];
    Mesh { positions, normals, indices, rtc_applied: false }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(2000);
    // wall 4m x 0.3m x 3m, opening 1m window punched through it
    let wall = box_mesh([0.0, 0.0, 0.0], [4.0, 0.3, 3.0]);
    let opening = box_mesh([1.0, -0.1, 1.0], [2.0, 0.4, 2.0]);
    let cp = ClippingProcessor::new();

    // warmup
    let r0 = cp.subtract_mesh(&wall, &opening).unwrap();
    let tris = r0.indices.len() / 3;

    let t = Instant::now();
    let mut acc = 0usize;
    for _ in 0..n {
        let r = cp.subtract_mesh(&wall, &opening).unwrap();
        acc = acc.wrapping_add(r.indices.len());
    }
    let ms = t.elapsed().as_secs_f64() * 1e3;
    println!(
        "box-box subtract: {:.4} ms/op  ({} ops, {} out-tris)  [sink={}]",
        ms / n as f64, n, tris, acc & 0xff
    );
    let (a, c, m, np) = ifc_lite_geometry::kernel::prof_take();
    if np > 0 {
        let npf = np as f64;
        println!(
            "  breakdown/op (KERNEL_PROFILE): arrange {:.4}ms  classify {:.4}ms  materialize {:.4}ms",
            a / npf * 1e3, c / npf * 1e3, m / npf * 1e3
        );
    }
    use std::sync::atomic::Ordering;
    let fix = ifc_lite_geometry::kernel::FIX_CALLS.swap(0, Ordering::Relaxed);
    let rat = ifc_lite_geometry::kernel::RAT_CALLS.swap(0, Ordering::Relaxed);
    println!(
        "  predicate escalation/op: fixed-tier {:.1}  BigRational-lambda {:.1}",
        fix as f64 / n as f64, rat as f64 / n as f64
    );
}
