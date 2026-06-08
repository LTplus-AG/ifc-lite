//! Kernel robustness probe (flip plan M6 panic-free). Feeds adversarial /
//! malformed operands through kernel::mesh_bridge::subtract under catch_unwind to
//! find the REAL panic sites the never-Err seam must survive:
//!   cargo run -p ifc-lite-geometry --example csg_robustness

use std::panic::{catch_unwind, AssertUnwindSafe};

use ifc_lite_geometry::kernel::arrangement::box_mesh;
use ifc_lite_geometry::kernel::mesh_bridge::{subtract, tris_to_mesh};
use ifc_lite_geometry::Mesh;

fn raw(positions: Vec<f32>, indices: Vec<u32>) -> Mesh {
    Mesh { positions, normals: vec![], indices, rtc_applied: false }
}

fn main() {
    let host = tris_to_mesh(&box_mesh([0., 0., 0.], [2., 2., 2.]));
    let mut open_box = tris_to_mesh(&box_mesh([1., 1., 1.], [3., 3., 3.]));
    let n = open_box.indices.len();
    open_box.indices.truncate(n - 3); // drop a face → non-watertight

    let cases: Vec<(&str, Mesh)> = vec![
        ("empty cutter", raw(vec![], vec![])),
        ("single open triangle", raw(vec![0., 0., 0., 1., 0., 0., 0., 1., 0.], vec![0, 1, 2])),
        ("degenerate zero-area", raw(vec![1., 1., 1., 1., 1., 1., 1., 1., 1.], vec![0, 1, 2])),
        ("NaN coords", raw(vec![f32::NAN, 0., 0., 1., 0., 0., 0., 1., 0.], vec![0, 1, 2])),
        ("Inf coords", raw(vec![f32::INFINITY, 0., 0., 1., 0., 0., 0., 1., 0.], vec![0, 1, 2])),
        ("huge coords 1e30", raw(vec![1e30, 1e30, 1e30, 1e30 + 1., 1e30, 1e30, 1e30, 1e30 + 1., 1e30], vec![0, 1, 2])),
        ("out-of-range index", raw(vec![0., 0., 0., 1., 0., 0., 0., 1., 0.], vec![0, 1, 99])),
        ("non-watertight box", open_box),
        ("host-coincident cutter", tris_to_mesh(&box_mesh([0., 0., 0.], [2., 2., 2.]))),
    ];

    let mut panics = 0;
    for (name, cutter) in cases {
        let r = catch_unwind(AssertUnwindSafe(|| subtract(&host, &cutter)));
        match r {
            Ok(m) => println!("{:<26} OK   ({} tris)", name, m.indices.len() / 3),
            Err(_) => {
                println!("{:<26} PANIC", name);
                panics += 1;
            }
        }
    }
    println!("\n{} panic site(s) reachable from malformed operands", panics);
}
