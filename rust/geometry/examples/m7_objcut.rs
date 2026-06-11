//! M7 forensics: sequentially subtract cutter OBJ meshes from a host OBJ via
//! the routed ClippingProcessor (the pure-Rust exact kernel — the only one
//! since M9), printing volume/triangles/edge-health after every step. Used to
//! replay a real model's void-cut loop outside the router orchestration.
//!
//!   m7_objcut <host.obj> <cutter1.obj> [cutter2.obj ...]

use ifc_lite_geometry::{ClippingProcessor, Mesh};
use std::collections::HashMap;

fn load_obj(path: &str) -> Mesh {
    let mut m = Mesh::new();
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.is_empty() {
            continue;
        }
        if t[0] == "v" {
            for k in 1..4 {
                m.positions.push(t[k].parse::<f32>().unwrap());
            }
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        } else if t[0] == "f" {
            for k in 1..4 {
                m.indices
                    .push(t[k].split('/').next().unwrap().parse::<u32>().unwrap() - 1);
            }
        }
    }
    m
}

fn volume(m: &Mesh) -> f64 {
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let v = |i: u32| {
                let b = i as usize * 3;
                [
                    m.positions[b] as f64,
                    m.positions[b + 1] as f64,
                    m.positions[b + 2] as f64,
                ]
            };
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0
}

fn bad_edges(m: &Mesh) -> usize {
    let s = 1e5_f64;
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
        for (u, v) in [(0usize, 1usize), (1, 2), (2, 0)] {
            if k[u] == k[v] {
                continue;
            }
            let e = if k[u] < k[v] { (k[u], k[v]) } else { (k[v], k[u]) };
            *edges.entry(e).or_insert(0) += 1;
        }
    }
    edges.values().filter(|&&c| c != 2).count()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cp = ClippingProcessor::new();
    let mut result = load_obj(&args[1]);
    println!(
        "host: tris={} vol={:.6} bad={} [kernel={} env_manifold={}]",
        result.triangle_count(),
        volume(&result),
        bad_edges(&result),
        "pure",
        false
    );
    for c in &args[2..] {
        let cutter = load_obj(c);
        match cp.subtract_mesh(&result, &cutter) {
            Ok(r) => {
                println!(
                    "  - {c}: cutter tris={} vol={:.6} -> result tris={} vol={:.6} bad={}",
                    cutter.triangle_count(),
                    volume(&cutter),
                    r.triangle_count(),
                    volume(&r),
                    bad_edges(&r)
                );
                result = r;
            }
            Err(e) => println!("  - {c}: ERR {e:?}"),
        }
        for f in cp.take_failures() {
            println!("    FAILURE: {f}");
        }
    }
    if let Some(out) = std::env::var_os("OBJ_OUT") {
        let mut s = String::new();
        for v in result.positions.chunks_exact(3) {
            s.push_str(&format!("v {} {} {}\n", v[0], v[1], v[2]));
        }
        for t in result.indices.chunks_exact(3) {
            s.push_str(&format!("f {} {} {}\n", t[0] + 1, t[1] + 1, t[2] + 1));
        }
        std::fs::write(out, s).unwrap();
    }
}
